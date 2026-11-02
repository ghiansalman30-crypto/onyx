// Searches for a nonce so that sha256(seed + ":" + nonce) has at least `bits` leading zero bits.
const { parentPort } = require("worker_threads");
const crypto = require("crypto");

function zeroBits(buf, need) {
  // fast check: only count as far as needed
  let n = 0;
  for (let i = 0; i < buf.length && n < need; i++) {
    const b = buf[i];
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24 >= need;
  }
  return n >= need;
}

let job = 0;
parentPort.on("message", (c) => {
  const my = ++job;
  const prefix = c.seed + ":";
  let nonce = Math.floor(Math.random() * 2 ** 40), done = 0;
  const step = () => {
    if (my !== job) return;
    for (let i = 0; i < 50_000; i++, nonce++) {
      const h = crypto.createHash("sha256").update(prefix + nonce.toString(36)).digest();
      if (zeroBits(h, c.bits)) {
        parentPort.postMessage({ type: "hashes", n: done + i + 1 });
        parentPort.postMessage({ type: "found", id: c.id, nonce: nonce.toString(36) });
        return;
      }
    }
    done += 50_000;
    parentPort.postMessage({ type: "hashes", n: 50_000 }); done = 0;
    setImmediate(step);
  };
  step();
});
