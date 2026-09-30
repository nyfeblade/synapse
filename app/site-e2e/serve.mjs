// A tiny static server for the built website (tests and screenshots only): clean URLs and vercel.json's
// headers, the way Vercel serves it. `node serve.mjs <dist> <port>`.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(fs.readFileSync(path.join(here, "../../vercel.json"), "utf8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".xml": "application/xml", ".txt": "text/plain", ".json": "application/json" };

export function serve(dist, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let p = decodeURIComponent(url.pathname);
    if (p.includes("..")) { res.writeHead(400).end(); return; }
    let file = path.join(dist, p === "/" ? "index.html" : p);
    if (!path.extname(file)) file += ".html";
    if (!fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
    const headers = { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" };
    for (const h of vercel.headers ?? []) {
      const re = new RegExp(`^${h.source.replace(/\(\.\*\)/g, ".*")}$`);
      if (re.test(p)) for (const { key, value } of h.headers) headers[key] = value;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await serve(path.resolve(process.argv[2] ?? path.join(here, "../../site/dist")), Number(process.argv[3] ?? 0));
  console.log(`serving on http://127.0.0.1:${port}`);
}
