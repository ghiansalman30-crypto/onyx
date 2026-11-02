#!/usr/bin/env node
// onyx login <API_KEY> [--server URL]   save your key
// onyx mine [--threads N]               mine with N CPU threads (default: all cores but one)
// onyx status                           show your balance
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

const CONF = path.join(os.homedir(), ".onyx.json");
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const load = () => { try { return JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { return {}; } };
const conf = load();
const server = (flag("--server") || process.env.ONYX_SERVER || conf.server || "http://127.0.0.1:4000").replace(/\/$/, "");

async function call(method, route, body, key = conf.apiKey) {
  const res = await fetch(server + route, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
}
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const rate = (h) => (h >= 1e9 ? fmt(h / 1e9) + " GH/s" : h >= 1e6 ? fmt(h / 1e6) + " MH/s" : h >= 1e3 ? fmt(h / 1e3) + " kH/s" : fmt(h, 0) + " H/s");

async function login() {
  const key = args[1];
  if (!key || !key.startsWith("onyx_")) { console.error("usage: onyx login <API_KEY>   (get the key at " + server + ")"); process.exit(1); }
  const me = await call("GET", "/api/me", null, key);
  fs.writeFileSync(CONF, JSON.stringify({ apiKey: key, server }, null, 2), { mode: 0o600 });
  console.log(`Logged in as ${me.address}. Key saved to ${CONF}\nNext: onyx mine`);
}

async function status() {
  if (!conf.apiKey) { console.error("Not logged in. Run: onyx login <API_KEY>"); process.exit(1); }
  const me = await call("GET", "/api/me");
  console.log(`${me.address}\nEarned  ${fmt(me.earned, 4)} ONYX\nShares  ${me.shares}`);
}

async function mine() {
  if (!conf.apiKey) { console.error("Not logged in. Run: onyx login <API_KEY>"); process.exit(1); }
  const me = await call("GET", "/api/me");
  const threads = Math.max(1, Number(flag("--threads", Math.max(1, os.cpus().length - 1))));
  console.log(`Mining as ${me.address} on ${threads} thread${threads > 1 ? "s" : ""}  ·  ${server}\nCtrl+C to stop.\n`);

  let hashes = 0, accepted = 0, rejected = 0, earned = me.earned, lastErr = "";
  const started = Date.now();
  for (let t = 0; t < threads; t++) {
    const w = new Worker(path.join(__dirname, "..", "worker.js"));
    let busy = false;
    const next = async (challenge) => {
      try {
        const c = challenge || (await call("POST", "/api/mine/challenge"));
        busy = true;
        w.postMessage(c);
      } catch (e) {
        lastErr = e.message;
        if (e.status === 401) { console.error("\nAPI key rejected. Sign in again on the website and run onyx login."); process.exit(1); }
        // 403: the 30-minute anti-bot check is due (confirm on the website); 429: too many wallets on this network
        if (e.status === 403) lastErr = "paused: anti-bot check due, open " + server + " and press Confirm";
        setTimeout(() => next(), e.status === 403 || e.status === 429 ? 15000 : 3000);
      }
    };
    w.on("message", async (m) => {
      if (m.type === "hashes") { hashes += m.n; return; }
      if (m.type === "found") {
        busy = false;
        try {
          const r = await call("POST", "/api/mine/submit", { id: m.id, nonce: m.nonce });
          accepted++; lastErr = "";
          next(r.next);
        } catch (e) { rejected++; lastErr = e.message; next(); }
      }
    });
    w.on("error", (e) => { lastErr = e.message; });
    next();
  }

  setInterval(async () => { try { earned = (await call("GET", "/api/me")).earned; } catch {} }, 15_000);
  let shown = 0, lastHashes = 0, lastT = Date.now();
  const spin = "◐◓◑◒";
  setInterval(() => {
    const now = Date.now(), hr = (hashes - lastHashes) / ((now - lastT) / 1000);
    lastHashes = hashes; lastT = now;
    const roundLeft = 60 - Math.floor((now / 1000) % 60);
    const line = `${spin[shown++ % 4]} ${rate(hr).padEnd(12)} shares ${String(accepted).padEnd(5)} rejected ${String(rejected).padEnd(3)} round ends ${String(roundLeft).padStart(2)}s  earned ${fmt(earned, 4)} ONYX${lastErr ? "  ! " + lastErr : ""}`;
    process.stdout.write("\r" + line.padEnd(110).slice(0, 140));
  }, 1000);
  process.on("SIGINT", () => { console.log(`\n\nStopped after ${Math.round((Date.now() - started) / 1000)} s · ${accepted} shares · earned ${fmt(earned, 4)} ONYX`); process.exit(0); });
}

const cmd = args[0];
const run = { login, mine, status }[cmd];
if (!run) {
  console.log("ONYX miner\n\n  onyx login <API_KEY>   save your key (get it by connecting a wallet on the website)\n  onyx mine [--threads N] start mining\n  onyx status            show your balance\n\nOptions: --server URL (default " + server + ")");
  process.exit(cmd ? 1 : 0);
}
run().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
