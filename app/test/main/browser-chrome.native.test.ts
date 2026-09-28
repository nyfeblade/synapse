import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserArgs } from "@synapse/shared";
import { ChromeDriver, findChrome } from "../../src/main/browser/cdp";
import { BrowserController, type ControllerResult } from "../../src/main/browser/controller";
import { estTokens } from "../../src/main/browser/outline";
import { serveFixtures } from "./browser-fixtures";

/**
 * mac-browser against REAL Google Chrome (headless, a throwaway profile) on the local fixture site, driven by a
 * scripted fake model that reads refs out of the outlines exactly as a model would. It measures what each step puts
 * into the model's context (outline/diff chars → tokens at 3.5 chars/token) and compares that with the screenshot
 * approach on the same tasks (each step returns a viewport image: w×h/750 tokens at the real screenshot size; a field
 * needs a click before typing; reading a page needs one screenshot per viewport).
 *
 * RUN_NATIVE=1 (or RUN_BROWSER=1) npx vitest run --project app app/test/main/browser-chrome.native.test.ts
 */
const chrome = findChrome();
const on = (process.env.RUN_NATIVE === "1" || process.env.RUN_BROWSER === "1") && !!chrome;

interface Step { action: string; chars: number; tokens: number; ssSteps: number; note?: string }
describe.skipIf(!on)("the Mac browser on real Chrome: three local tasks, outline vs screenshots", () => {
  let site: Awaited<ReturnType<typeof serveFixtures>>;
  let c: BrowserController;
  let tmp: string;
  const rows: { task: string; steps: Step[] }[] = [];
  let shotTokens = 1365;

  beforeAll(async () => {
    site = await serveFixtures();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-browser-"));
    c = new BrowserController({
      launch: () => ChromeDriver.launch({ chrome: chrome!, profileDir: path.join(tmp, "profile"), downloads: path.join(tmp, "dl"), headless: true }),
      now: Date.now, log: () => {},
    });
  }, 60_000);
  afterAll(async () => {
    await c?.close();
    await site?.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (!rows.length) return;
    const lines = ["", "task | round trips | outline/diff tokens (sum) | context re-read over the task | screenshot round trips | screenshot tokens (sum) | screenshot context re-read"];
    for (const r of rows) {
      const toks = r.steps.map((s) => s.tokens);
      const ss = r.steps.flatMap((s) => Array.from({ length: s.ssSteps }, () => shotTokens + 40));
      const reread = (xs: number[]) => xs.reduce((acc, _x, i) => acc + xs.slice(0, i + 1).reduce((a, b) => a + b, 0), 0);
      lines.push(`${r.task} | ${r.steps.length} | ${toks.reduce((a, b) => a + b, 0)} | ${reread(toks)} | ${ss.length} | ${ss.reduce((a, b) => a + b, 0)} | ${reread(ss)}`);
      lines.push(`  per step: ${r.steps.map((s) => `${s.action}=${s.tokens}${s.note ? `(${s.note})` : ""}`).join(" · ")}`);
    }
    lines.push(`(screenshot = ${shotTokens} tokens each, measured from a real downscaled JPEG of this viewport; outline tokens = chars/3.5)`);
    process.stdout.write(lines.join("\n") + "\n");
  });

  const bot = { botId: "bench", botName: "Bench" };
  let seen = "";
  const refFor = (role: string, name: string | RegExp): string => {
    const re = /\[(e\d+)\] (\w+) "((?:[^"\\]|\\.)*)"/g;
    let hit: string | null = null;
    for (const m of seen.matchAll(re)) if (m[2] === role && (typeof name === "string" ? m[3] === name : name.test(m[3]!))) hit = m[1]!;
    if (!hit) throw new Error(`no ${role} ${String(name)} in the outlines so far`);
    return hit;
  };
  async function run(task: string, script: ((last: string) => BrowserArgs | { args: BrowserArgs; ss: number })[], check: (last: string) => void) {
    const steps: Step[] = [];
    seen = "";
    let last = "";
    for (const next of script) {
      const x = next(last);
      const args = "args" in x ? x.args : x;
      let r: ControllerResult = await c.handle({ ...bot, args, approved: false, origins: [], explicit: false, turn: task, userTurn: true });
      let ssSteps = "ss" in x ? x.ss : 1;
      if (!r.ok && r.needsApproval) {
        // the card, then the user's "Allow once", then the re-run: two round trips (the screenshot Bot asks too)
        steps.push({ action: `${args.action}(card)`, chars: r.error.length, tokens: estTokens(r.error), ssSteps: 1, note: "asks" });
        r = await c.handle({ ...bot, args, approved: true, origins: [], explicit: false, turn: task, userTurn: true });
      }
      if (!r.ok) throw new Error(`${task}: ${args.action} failed: ${r.error}`);
      last = r.reply.text;
      seen += `\n${last}`;
      if (process.env.BENCH_SHOW) process.stdout.write(`\n--- ${task} ${args.action} ---\n${last}\n`);
      if (args.action === "text") ssSteps = Math.max(1, ssSteps);
      steps.push({ action: args.action, chars: last.length, tokens: estTokens(last), ssSteps });
    }
    check(last);
    rows.push({ task, steps });
    return steps;
  }

  it("measures one real screenshot of this viewport", async () => {
    const r = await c.handle({ ...bot, args: { action: "open", url: `${site.base}/` }, approved: false, origins: [], explicit: false });
    expect(r.ok).toBe(true);
    const s = await c.handle({ ...bot, args: { action: "screenshot" }, approved: false, origins: [], explicit: false });
    if (!s.ok || !s.reply.image) throw new Error("no screenshot");
    const jpeg = Buffer.from(s.reply.image, "base64");
    // JPEG SOF0/SOF2 frame: height then width
    let i = 2, w = 0, h = 0;
    while (i < jpeg.length) { const m = jpeg[i + 1]!; const len = jpeg.readUInt16BE(i + 2); if (m === 0xc0 || m === 0xc2) { h = jpeg.readUInt16BE(i + 5); w = jpeg.readUInt16BE(i + 7); break; } i += 2 + len; }
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(1280);
    shotTokens = Math.round((w * h) / 750);
    process.stdout.write(`screenshot: ${w}×${h} JPEG, ${jpeg.length} bytes → ~${shotTokens} image tokens\n`);
  }, 60_000);

  it("task 1: search and read a result", async () => {
    await run("search+read", [
      () => ({ action: "open", url: `${site.base}/` }),
      () => ({ args: { action: "type", ref: refFor("searchbox", "Search the site"), text: "Veltria capital", submit: true }, ss: 2 }),
      () => ({ action: "click", ref: refFor("link", "Veltria's capital explained") }),
      // the screenshot Bot scrolls the article: one screenshot per viewport of it
      () => ({ args: { action: "text" }, ss: 3 }),
    ], (last) => expect(last).toContain("The capital of Veltria is Orsk"));
  }, 120_000);

  it("task 2: fill and submit a multi-field form", async () => {
    await run("form", [
      () => ({ action: "open", url: `${site.base}/signup` }),
      () => ({ args: { action: "type", ref: refFor("textbox", "Full name"), text: "Ada Lovelace" }, ss: 2 }),
      () => ({ args: { action: "type", ref: refFor("textbox", "Email"), text: "ada@example.com" }, ss: 2 }),
      () => ({ args: { action: "select", ref: refFor("combobox", "Country"), value: "Ireland" }, ss: 2 }),
      () => ({ action: "check", ref: refFor("radio", "Pro") }),
      () => ({ action: "check", ref: refFor("checkbox", "Send me the newsletter") }),
      () => ({ args: { action: "type", ref: refFor("textbox", "About you"), text: "Mathematician." }, ss: 2 }),
      () => ({ action: "click", ref: refFor("button", "Create account") }),
    ], (last) => expect(last).toMatch(/Welcome, Ada Lovelace|Account created for ada@example.com/));
    expect(site.posts.find((p) => p.path === "/signup")).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com", country: "Ireland", plan: "pro", news: "on", about: "Mathematician." });
  }, 120_000);

  it("task 3: a 3-page flow", async () => {
    await run("3-page flow", [
      () => ({ action: "open", url: `${site.base}/flow/1` }),
      () => ({ args: { action: "select", ref: refFor("combobox", "Party size"), value: "4" }, ss: 2 }),
      () => ({ action: "click", ref: refFor("button", "Next") }),
      () => ({ args: { action: "type", ref: refFor("textbox", "Time"), text: "19:30", submit: true }, ss: 2 }),
      () => ({ action: "click", ref: refFor("button", "Confirm booking") }),
    ], (last) => expect(last).toContain("VP-2231"));
  }, 120_000);

  it("pauses when the user takes over the real window, and Stop holds until a new message", async () => {
    const r = await c.handle({ ...bot, args: { action: "open", url: `${site.base}/` }, approved: false, origins: [], explicit: false, turn: "u1", userTurn: true });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 800)); // past the post-action grace
    // the user's own key press in the window (a trusted event, as far as the page can tell)
    const drv = (c as unknown as { driver: ChromeDriver }).driver;
    const tab = (c as unknown as { sessions: Map<string, { tabs: { key(k: string): Promise<void> }[] }> }).sessions.get("bench")!.tabs[0]!;
    await tab.key("a");
    await new Promise((res) => setTimeout(res, 300));
    const held = await c.handle({ ...bot, args: { action: "snapshot" }, approved: false, origins: [], explicit: false, turn: "u1", userTurn: true });
    expect(held.ok).toBe(false);
    const again = await c.handle({ ...bot, args: { action: "snapshot" }, approved: false, origins: [], explicit: false, turn: "u2", userTurn: true });
    expect(again.ok).toBe(true);
    expect(drv.alive()).toBe(true);
  }, 60_000);
});
