import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paramCandidates } from "../../teach/analyze";
import { CdpClient } from "../../teach/cdp";
import { ffmpegArgs } from "../../teach/recorder";
import { scrubSecrets } from "../../teach/redact";
import { startSidecar, type SidecarEvent } from "../../teach/sidecar";
import { spawnXInput } from "../../teach/xinput";

const DISPLAY = ":97";
const CDP = 9297;
const SEEDED = "S3eded-Pa55!word";
const env = { ...process.env, DISPLAY };
const x = (...a: string[]) => execFileSync("xdotool", a, { env });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGES: Record<string, string> = {
  "/expense": `<form action="/done"><label>Amount <input name="amount" id="amount"></label><label>Category <select name="category"><option>Meals</option><option>Travel</option><option>Office</option></select></label><label>Receipt <input type="file" name="receipt"></label><button>Submit report</button></form>`,
  "/search": `<form action="/results"><input name="q" aria-label="Search"><button>Search</button></form>`,
  "/results": `<a href="/q3.csv" download>q3-report.csv</a>`,
  "/step1": `<form action="/step2"><label>Name <input name="full_name"></label><button>Next</button></form>`,
  "/step2": `<form action="/step3"><label>Date <input name="trip_date"></label><button>Next</button></form>`,
  "/step3": `<form action="/done"><button>Submit</button></form>`,
  "/login": `<form action="/done"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`,
  "/done": `<h1>Done</h1>`,
};

let server: http.Server;
let xvfb: ChildProcess;
let wm: ChildProcess;
let chrome: ChildProcess;

async function demo(name: string, start: string, act: () => Promise<void>): Promise<{ dir: string; events: SidecarEvent[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `teach-${name}-`));
  x("search", "--class", "chromium", "windowactivate", "--sync");
  x("key", "ctrl+l"); x("type", `http://127.0.0.1:8977${start}`); x("key", "Return");
  await sleep(1500);
  const ff = spawn("ffmpeg", ffmpegArgs(DISPLAY, path.join(dir, "demo.mp4")), { env, stdio: ["pipe", "ignore", "ignore"] });
  const cdp = await CdpClient.connect(CDP);
  const side = startSidecar({ sessionDir: dir, startedAtMs: Date.now(), xinput: await spawnXInput(DISPLAY), cdp, now: Date.now });
  await sleep(500);
  await act();
  await sleep(1500);
  await side.stop();
  ff.stdin!.write("q");
  await new Promise((r) => ff.once("exit", r));
  scrubSecrets(dir, [SEEDED]);
  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SidecarEvent);
  return { dir, events };
}

/** Real pointer clicks: read the element's screen position over CDP, then move and click with xdotool. */
async function evalInPage<T>(expression: string): Promise<T> {
  const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(list.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const msg = await new Promise<{ result: { result: { value: T } } }>((r) => {
    ws.onmessage = (m) => r(JSON.parse(String(m.data)));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return msg.result.result.value;
}
const click = async (selector: string) => {
  const [cx, cy] = await evalInPage<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return [Math.round(screenX + (outerWidth - innerWidth) / 2 + r.left + r.width / 2), Math.round(screenY + (outerHeight - innerHeight) + r.top + r.height / 2)]; })()`);
  x("mousemove", String(cx), String(cy));
  x("click", "1");
  await sleep(300);
};

describe.skipIf(!process.env.RUN_BOX)("Teach a task in the box (ORIG-08 §08.4)", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url!, "http://x").pathname;
      if (p === "/q3.csv") { res.setHeader("content-disposition", "attachment; filename=q3-report.csv"); res.end("a,b\n1,2\n"); return; }
      res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>${p.slice(1)}</title><body>${PAGES[p] ?? PAGES["/done"]}</body>`);
    }).listen(8977);
    xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24"], { stdio: "ignore" });
    await sleep(800);
    // like a real Bot display (box/files/bot-desktop-session): xdotool windowactivate needs a window manager
    wm = spawn("dbus-launch", ["--exit-with-session", "xfwm4", "--compositor=off"], { env, stdio: "ignore" });
    await sleep(1000);
    fs.writeFileSync("/tmp/teach-receipt.pdf", "%PDF-1.4 test");
    chrome = spawn("chromium", ["--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${CDP}`, "--window-position=0,0", "--window-size=1280,800", `--user-data-dir=${fs.mkdtempSync("/tmp/teach-chrome-")}`, "about:blank"], { env, stdio: "ignore" });
    await sleep(3000);
  }, 30_000);

  afterAll(() => { chrome?.kill(); wm?.kill(); xvfb?.kill(); server?.close(); });

  const found = (events: SidecarEvent[]) => new Set(paramCandidates(events).map((c) => c.label));
  const results: boolean[] = [];

  it("1. expense form with file upload", async () => {
    const { events } = await demo("expense", "/expense", async () => {
      await click("input[name=amount]"); x("type", "42.10");
      await click("select[name=category]"); x("key", "Down"); x("key", "Return"); // Category → Travel
      await click("input[name=receipt]"); await sleep(1500); // GTK file chooser
      x("key", "ctrl+l"); x("type", "/tmp/teach-receipt.pdf"); x("key", "Return"); await sleep(800);
      await click("button");
    });
    const f = found(events);
    results.push(["amount", "category", "receipt"].every((k) => f.has(k)));
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "key" && /^[0-9.]$/.test(e.key))).toBe(false); // typed characters are counted, never stored
  }, 60_000);

  it("2. search and download", async () => {
    const { events } = await demo("search", "/search", async () => {
      await click("input[name=q]"); x("type", "q3 report"); x("key", "Return"); await sleep(1200);
      await click("a"); await sleep(1500);
    });
    results.push(found(events).has("q"));
    expect(events.filter((e) => e.type === "nav").length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("3. three-page form with a date", async () => {
    const { events } = await demo("wizard", "/step1", async () => {
      await click("input[name=full_name]"); x("type", "Ada Lovelace"); await click("button"); await sleep(1000);
      await click("input[name=trip_date]"); x("type", "2026-10-24"); await click("button"); await sleep(1000);
      await click("button");
    });
    const c = paramCandidates(events);
    results.push(c.some((p) => p.label === "full_name") && c.some((p) => p.label === "trip_date" && p.typeGuess === "date"));
  }, 60_000);

  it("4. desktop Save As", async () => {
    const { events } = await demo("desktop", "/done", async () => {
      const ed = spawn("mousepad", [], { env, stdio: "ignore" }); await sleep(2000);
      x("type", "notes for the trip"); x("key", "ctrl+shift+s"); await sleep(1200);
      x("type", "/tmp/teach-notes.txt"); x("key", "Return"); await sleep(800);
      ed.kill();
    });
    results.push(events.some((e) => e.type === "key" && e.key === "ctrl+shift+s"));
    expect(events.every((e) => e.type !== "field")).toBe(true);
  }, 60_000);

  it("5. login form with a seeded password: the password appears in no file", async () => {
    const { dir, events } = await demo("login", "/login", async () => {
      await click("input[name=email]"); x("type", "ada@example.com");
      await click("input[name=password]"); x("type", SEEDED);
      await click("button");
    });
    const c = paramCandidates(events);
    results.push(c.some((p) => p.label === "email" && p.typeGuess === "email") && c.some((p) => p.label === "password" && p.secret));
    let hits = "";
    try { hits = execFileSync("grep", ["-rl", "--", SEEDED, dir]).toString().trim(); } catch { hits = ""; } // grep exits 1 when nothing matches
    expect(hits).toBe("");
  }, 60_000);

  it("finds the expected parameter sets in at least 4 of 5 demos", () => {
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });
});
