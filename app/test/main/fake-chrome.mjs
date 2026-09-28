/**
 * A stand-in for Google Chrome's binary (browser-signin tests). What it copies from the real one:
 * - one process per --user-data-dir: a SingletonLock symlink "<host>-<pid>"; a second copy on a locked profile hands
 *   off and exits at once (the real process singleton);
 * - cookies live in the profile: each launch appends one to Default/Cookies.fake and records the ones it found;
 * - --remote-debugging-port=0 writes DevToolsActivePort and serves a minimal CDP (Browser.close quits);
 * - SIGTERM is a clean quit (lock released, exit 0).
 * Every launch writes its argv to launches.jsonl in the profile.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const dir = args.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!dir) process.exit(2);
fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
const lock = path.join(dir, "SingletonLock");
const log = (o) => fs.appendFileSync(path.join(dir, "launches.jsonl"), JSON.stringify(o) + "\n");
try {
  const [host, pid] = fs.readlinkSync(lock).split(/-(?=\d+$)/);
  let alive = false;
  try { process.kill(Number(pid), 0); alive = true; } catch { /* stale */ }
  if (alive && host === os.hostname()) { log({ args, handedOff: true }); process.exit(0); }
  fs.rmSync(lock, { force: true });
} catch { /* no lock */ }
fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
const jar = path.join(dir, "Default", "Cookies.fake");
const found = fs.existsSync(jar) ? fs.readFileSync(jar, "utf8").split("\n").filter(Boolean) : [];
fs.appendFileSync(jar, `sid=${process.pid}\n`);
log({ args, pid: process.pid, cookies: found });

let wss = null;
const quit = () => {
  try { fs.rmSync(lock, { force: true }); } catch { /* gone */ }
  try { fs.rmSync(path.join(dir, "DevToolsActivePort"), { force: true }); } catch { /* gone */ }
  wss?.close();
  process.exit(0);
};
process.on("SIGTERM", quit);
if (args.includes("--remote-debugging-port=0")) {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("listening", () => fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `${wss.address().port}\n/devtools/browser/fake\n`));
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    ws.send(JSON.stringify({ id: m.id, result: {} }));
    if (m.method === "Browser.close") setTimeout(quit, 50);
  }));
}
setInterval(() => {}, 1 << 30);
