// ONYX mining server: serves the website and runs the proof-of-work engine.
//
//   node server.js            -> http://127.0.0.1:4000
//
// How mining works
//   1. A wallet signs a login message on the website and gets a personal API key.
//   2. The CLI (`onyx mine`) asks for challenges with that key, searches for a nonce so that
//      sha256(seed + ":" + nonce) starts with enough zero bits, and submits it as a "share".
//   3. Difficulty is tuned per miner so each miner finds about one share every 20 s; a share
//      is worth 2^bits units of work.
//   4. Every 60 s a round closes: that round's fixed emission is split between its miners
//      by work. Emission halves every 30 days, so the total can never exceed MAX_SUPPLY.
//
// Balances are an off-chain ledger for now. Paying out real tokens is a separate step.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const DATA = path.join(__dirname, "data");

// ---------- economy ----------
const ROUND_MS = 60_000;
const HALVING_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SUPPLY = Number(process.env.MAX_SUPPLY || 50_000_000);
// sum over all halvings of (rounds per period * emission) = 2 * roundsPerPeriod * E  =>  E = MAX / (2 * roundsPerPeriod)
const BASE_EMISSION = MAX_SUPPLY / (2 * (HALVING_MS / ROUND_MS));
const TARGET_SHARE_MS = 20_000;
const MIN_BITS = 12, MAX_BITS = 40, START_BITS = 20;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_OPEN_CHALLENGES = 64; // per miner, enough for one per CPU core
const ACTIVE_WINDOW_MS = 10 * 60_000;

// ---------- storage ----------
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, "onyx.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS miners (
    address TEXT PRIMARY KEY, api_key_hash TEXT UNIQUE, created INTEGER,
    bits INTEGER, last_share INTEGER, shares INTEGER DEFAULT 0, earned REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS round_work (round INTEGER, address TEXT, work REAL, shares INTEGER,
    PRIMARY KEY (round, address));
  CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, ended INTEGER, miners INTEGER,
    shares INTEGER, work REAL, emission REAL);
  CREATE TABLE IF NOT EXISTS share_log (ts INTEGER, address TEXT, work REAL);
  CREATE INDEX IF NOT EXISTS share_log_ts ON share_log (ts);
`);
const getMeta = (k) => db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v;
const setMeta = (k, v) => db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
if (!getMeta("genesis")) setMeta("genesis", Date.now());
const GENESIS = Number(getMeta("genesis"));

const roundOf = (t) => Math.floor(t / ROUND_MS);
const emissionAt = (t) => BASE_EMISSION / 2 ** Math.floor(Math.max(0, t - GENESIS) / HALVING_MS);
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const hashKey = (k) => sha("onyx-key:" + k).toString("hex");

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    n += Math.clz32(byte) - 24;
    break;
  }
  return n;
}

// ---------- rounds ----------
function closeRound(id) {
  if (db.prepare("SELECT 1 FROM rounds WHERE id = ?").get(id)) return;
  const rows = db.prepare("SELECT address, work, shares FROM round_work WHERE round = ?").all(id);
  const total = rows.reduce((a, r) => a + r.work, 0);
  const ended = (id + 1) * ROUND_MS;
  const emission = total > 0 ? emissionAt(ended) : 0; // nobody mined: nothing is minted
  db.exec("BEGIN");
  try {
    const pay = db.prepare("UPDATE miners SET earned = earned + ? WHERE address = ?");
    for (const r of rows) pay.run(emission * (r.work / total), r.address);
    db.prepare("INSERT INTO rounds (id, ended, miners, shares, work, emission) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ended, rows.length, rows.reduce((a, r) => a + r.shares, 0), total, emission);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function settle() {
  // close every finished round that has work recorded (also catches rounds missed while the server was off)
  const now = roundOf(Date.now());
  for (const { round } of db.prepare("SELECT DISTINCT round FROM round_work WHERE round < ? AND round NOT IN (SELECT id FROM rounds)").all(now)) closeRound(round);
  db.prepare("DELETE FROM share_log WHERE ts < ?").run(Date.now() - ACTIVE_WINDOW_MS);
}
setInterval(settle, 2_000);

// ---------- wallet login ----------
const logins = new Map(); // address -> { nonce, expires }
function loginMessage(address, nonce) {
  return `Sign in to ONYX\n\nThis signature only proves you own this wallet. It costs nothing and moves no funds.\n\nWallet: ${address}\nNonce: ${nonce}`;
}

// ---------- challenges ----------
const challenges = new Map(); // id -> { address, seed, bits, expires }
setInterval(() => { const t = Date.now(); for (const [id, c] of challenges) if (c.expires < t) challenges.delete(id); }, 30_000);
function newChallenge(miner) {
  let open = 0;
  for (const c of challenges.values()) if (c.address === miner.address) open++;
  if (open >= MAX_OPEN_CHALLENGES) return null;
  const id = crypto.randomBytes(12).toString("hex");
  const c = { address: miner.address, seed: crypto.randomBytes(16).toString("hex"), bits: miner.bits, expires: Date.now() + CHALLENGE_TTL_MS };
  challenges.set(id, c);
  const round = roundOf(Date.now());
  return { id, seed: c.seed, bits: c.bits, round, roundEndsAt: (round + 1) * ROUND_MS };
}

// ---------- http helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json" };
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 10_000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad json")); } });
  });
}
function minerFromAuth(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || "");
  return m ? db.prepare("SELECT * FROM miners WHERE api_key_hash = ?").get(hashKey(m[1])) : undefined;
}
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

// ---------- api ----------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/stats") {
    const now = Date.now(), since = now - ACTIVE_WINDOW_MS;
    const recent = db.prepare("SELECT COUNT(DISTINCT address) miners, COALESCE(SUM(work), 0) work, MIN(ts) first FROM share_log WHERE ts >= ?").get(since);
    const span = recent.first ? Math.max(20_000, now - recent.first) : ACTIVE_WINDOW_MS; // a fresh network has less than 10 min of history
    const round = roundOf(now);
    return send(res, 200, {
      activeMiners: recent.miners,
      hashrate: recent.work / (span / 1000), // hashes per second, estimated from shares
      round, roundEndsAt: (round + 1) * ROUND_MS, serverTime: now,
      emissionPerRound: emissionAt(now),
      nextHalvingAt: GENESIS + (Math.floor((now - GENESIS) / HALVING_MS) + 1) * HALVING_MS,
      circulating: db.prepare("SELECT COALESCE(SUM(earned), 0) s FROM miners").get().s,
      maxSupply: MAX_SUPPLY,
      targetShareSeconds: TARGET_SHARE_MS / 1000,
      rounds: db.prepare("SELECT id, ended, miners, shares, emission FROM rounds ORDER BY id DESC LIMIT 8").all(),
      leaderboard: db.prepare("SELECT address, shares, earned, last_share lastShare FROM miners WHERE shares > 0 ORDER BY earned DESC LIMIT 10").all(),
    });
  }

  if (route === "GET /api/auth/nonce") {
    const address = url.searchParams.get("address");
    if (!isAddress(address)) return send(res, 400, { error: "invalid address" });
    const nonce = crypto.randomBytes(16).toString("hex");
    logins.set(address.toLowerCase(), { nonce, expires: Date.now() + 5 * 60_000 });
    return send(res, 200, { message: loginMessage(address, nonce) });
  }

  if (route === "POST /api/auth/verify") {
    const { address, signature } = await readBody(req);
    if (!isAddress(address) || typeof signature !== "string") return send(res, 400, { error: "invalid request" });
    const pending = logins.get(address.toLowerCase());
    if (!pending || pending.expires < Date.now()) return send(res, 400, { error: "login expired, try again" });
    logins.delete(address.toLowerCase());
    const { verifyMessage } = await import("viem");
    const ok = await verifyMessage({ address, message: loginMessage(address, pending.nonce), signature }).catch(() => false);
    if (!ok) return send(res, 401, { error: "signature does not match this wallet" });
    // a fresh key on every sign-in; the old one stops working (only its hash is stored)
    const apiKey = "onyx_" + crypto.randomBytes(20).toString("hex");
    const addr = address.toLowerCase();
    db.prepare(`INSERT INTO miners (address, api_key_hash, created, bits, shares, earned) VALUES (?, ?, ?, ?, 0, 0)
      ON CONFLICT(address) DO UPDATE SET api_key_hash = excluded.api_key_hash`).run(addr, hashKey(apiKey), Date.now(), START_BITS);
    return send(res, 200, { apiKey, address: addr });
  }

  if (route === "GET /api/me") {
    const m = minerFromAuth(req);
    if (!m) return send(res, 401, { error: "invalid API key" });
    const cur = db.prepare("SELECT shares FROM round_work WHERE round = ? AND address = ?").get(roundOf(Date.now()), m.address);
    return send(res, 200, { address: m.address, earned: m.earned, shares: m.shares, bits: m.bits, roundShares: cur?.shares || 0 });
  }

  if (route === "POST /api/mine/challenge") {
    const m = minerFromAuth(req);
    if (!m) return send(res, 401, { error: "invalid API key" });
    const c = newChallenge(m);
    return c ? send(res, 200, c) : send(res, 429, { error: "too many open challenges" });
  }

  if (route === "POST /api/mine/submit") {
    const m = minerFromAuth(req);
    if (!m) return send(res, 401, { error: "invalid API key" });
    const { id, nonce } = await readBody(req);
    const c = challenges.get(id);
    if (!c || c.address !== m.address) return send(res, 400, { error: "unknown or expired challenge" });
    if (typeof nonce !== "string" || nonce.length > 32) return send(res, 400, { error: "invalid nonce" });
    if (leadingZeroBits(sha(c.seed + ":" + nonce)) < c.bits) return send(res, 400, { error: "hash does not meet difficulty" });
    challenges.delete(id); // each challenge pays once

    const now = Date.now(), work = 2 ** c.bits, round = roundOf(now);
    // retune toward one share per TARGET_SHARE_MS for this miner
    let bits = m.bits;
    if (m.last_share) {
      const gap = now - m.last_share;
      if (gap < TARGET_SHARE_MS / 2) bits++;
      else if (gap > TARGET_SHARE_MS * 2) bits--;
    }
    bits = Math.min(MAX_BITS, Math.max(MIN_BITS, bits));
    db.prepare("UPDATE miners SET bits = ?, last_share = ?, shares = shares + 1 WHERE address = ?").run(bits, now, m.address);
    db.prepare(`INSERT INTO round_work (round, address, work, shares) VALUES (?, ?, ?, 1)
      ON CONFLICT(round, address) DO UPDATE SET work = work + excluded.work, shares = shares + 1`).run(round, m.address, work);
    db.prepare("INSERT INTO share_log (ts, address, work) VALUES (?, ?, ?)").run(now, m.address, work);
    return send(res, 200, { accepted: true, work, round, next: newChallenge({ ...m, bits }) });
  }

  return send(res, 404, { error: "not found" });
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  } catch (e) {
    send(res, 400, { error: e.message || "bad request" });
  }
}).listen(PORT, HOST, () => console.log(`ONYX: http://${HOST}:${PORT}  (emission ${BASE_EMISSION.toFixed(1)} per round)`));
