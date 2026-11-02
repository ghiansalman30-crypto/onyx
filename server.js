// Tiny static server for the ORRERY site: node server.js  ->  http://127.0.0.1:4000
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = Number(process.env.PORT || 4000), ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!file.startsWith(ROOT) || path.basename(file) === "server.js") { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`ORRERY: http://127.0.0.1:${PORT}`));
