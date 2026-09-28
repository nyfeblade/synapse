import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { blankRegion, detectAll } from "./detectors";
import { inkSeries } from "./pixels";
import { startRig, type Rig } from "./harness";
import type { Glitch, Recording } from "./types";

/**
 * THE MOTION CHECK (`npm run motion:check -w @synapse/app`). Every interaction the liquid-motion passes
 * animate, driven fast and repeatedly in headless Chromium, every frame recorded, glitches detected.
 * MOTION_OUT=<dir> keeps each recording as JSON; MOTION_REPORT=1 reports without failing.
 */
const OUT = process.env.MOTION_OUT;
const REPORT_ONLY = process.env.MOTION_REPORT === "1";
test.describe.configure({ mode: "serial" });

let rig: Rig;
let page: Page;
const bots: Record<string, string> = {};
const found: Record<string, Glitch[]> = {};

test.beforeAll(async () => {
  rig = await startRig();
  page = rig.page;
  for (const n of ["Ada", "Bea", "Cy", "Dee"]) bots[n] = (await rig.call("createAgent", { name: n })).id;
  // A cold Vite compiles the renderer on first load: allow for it here, not in every action.
  await page.getByRole("link", { name: /Dee/ }).first().waitFor({ timeout: 90_000 });
  await page.getByRole("link", { name: /Ada/ }).first().click({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Message Ada" }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
});
test.afterAll(async () => {
  if (REPORT_ONLY) console.log(JSON.stringify(found, null, 1));
  await rig?.close();
});

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const rec: Recording = await rig.record(fn);
  if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rec)); }
  const g = detectAll(rec);
  found[name] = g;
  if (!REPORT_ONLY) expect(g, `${name}: ${rec.frames.length} frames`).toEqual([]);
}

const link = (n: string) => page.getByRole("link", { name: new RegExp(n) }).first();
const composer = (n: string) => page.getByRole("textbox", { name: `Message ${n}` });
async function send(n: string, text: string): Promise<void> {
  await composer(n).fill(text);
  await composer(n).press("Enter");
}

/** A real click at the row's centre: no actionability wait, so it lands mid-transition the way a user's does. */
async function clickRow(n: string): Promise<void> {
  const b = await link(n).boundingBox();
  if (!b) throw new Error(`no row for ${n}`);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test("switch Bots quickly and repeatedly", async () => {
  await check("switch", async () => {
    for (const n of ["Bea", "Cy", "Ada", "Dee", "Bea", "Ada"]) { await clickRow(n); await page.waitForTimeout(90); }
    for (const n of ["Cy", "Ada"]) { await clickRow(n); await page.waitForTimeout(700); }
  });
  // What the user SEES through one switch: the header's avatar and name must never drop out.
  const hb = await page.locator(".chat-header .title-btn").boundingBox();
  const box = { x: Math.round(hb!.x), y: Math.round(hb!.y), w: 110, h: Math.round(hb!.height) };
  const shots = await rig.film(async () => { await clickRow("Bea"); });
  const g = [...blankRegion(await inkSeries(rig.browser, shots, { header: box }), "header")];
  // …and a fast redirect must land on the Bot clicked last.
  await clickRow("Cy"); await page.waitForTimeout(100); await clickRow("Dee"); await page.waitForTimeout(1200);
  const title = (await page.locator(".chat-header .morph-name, .chat-header .title-btn").first().innerText()).trim();
  if (!title.includes("Dee")) g.push({ kind: "redirect", detail: `a click mid-transition was lost: header shows "${title}", expected Dee` });
  found["switch-pixels"] = g;
  if (!REPORT_ONLY) expect(g).toEqual([]);
});

test("send, double send, send while a reply streams", async () => {
  await clickRow("Ada");
  await composer("Ada").waitFor();
  await page.waitForTimeout(900);
  await check("send", async () => {
    await send("Ada", "first message");
    await page.waitForTimeout(250);
    await send("Ada", "second quick");
    await send("Ada", "third quicker");
    await page.waitForTimeout(1500);
    await send("Ada", "run: sleep 1");
    await page.waitForTimeout(400);
    await send("Ada", "while it works");
    await page.waitForTimeout(2500);
  });
});

test("expand tool steps", async () => {
  await check("steps", async () => {
    const toggles = page.locator(".activity-rows");
    const n = await toggles.count();
    for (let i = 0; i < Math.min(n, 2); i++) { await toggles.nth(i).click(); await page.waitForTimeout(60); await toggles.nth(i).click(); await page.waitForTimeout(60); await toggles.nth(i).click(); }
    await page.waitForTimeout(300);
  });
});

test("streamed reply, auto-scroll, new-messages pill, scrolling during a glide", async () => {
  // Playwright's own clicks in the steps scenario scroll a toggle into view; start this one at the bottom.
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await check("fill", async () => {
    for (let i = 0; i < 6; i++) { await send("Ada", `filler ${i} ` + "lorem ipsum ".repeat(30)); await page.waitForTimeout(300); }
    await page.waitForTimeout(2000);
  });
  // Auto-scroll stuck to the bottom through all of that: the user never scrolled.
  const gap = await page.locator(".transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  if (!REPORT_ONLY) expect(gap, "auto-scroll lost the bottom").toBeLessThanOrEqual(2);
  else found["fill-bottom"] = gap > 2 ? [{ kind: "lost-bottom", detail: `${gap}px from the bottom after sends` }] : [];
  await check("scroll", async () => {
    await send("Ada", "run: sleep 1");
    await page.waitForTimeout(120);
    const box = page.locator(".transcript");
    await box.hover();
    await page.mouse.wheel(0, -500); // scroll up during the glide
    await page.waitForTimeout(3000);
    const pill = page.locator(".new-pill");
    if (await pill.count()) await pill.click();
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    await send("Ada", "another");
    await page.waitForTimeout(40);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(2500);
  });
});

test("model dropdown and menus open and close fast", async () => {
  await clickRow("Ada");
  await page.waitForTimeout(900);
  if (!(await page.getByRole("button", { name: "Bot settings" }).count())) await page.getByRole("button", { name: "View conversation details" }).click({ timeout: 5000 });
  await page.getByRole("button", { name: "Bot settings" }).click({ timeout: 5000 });
  await page.waitForTimeout(900);
  await check("menus", async () => {
    const select = page.locator(".panel .select").first();
    for (let i = 0; i < 4; i++) { await select.click(); await page.waitForTimeout(50); await page.keyboard.press("Escape"); await page.waitForTimeout(30); }
    for (let i = 0; i < 3; i++) { await link("Bea").click({ button: "right" }); await page.waitForTimeout(60); await page.keyboard.press("Escape"); }
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.waitForTimeout(40);
    await page.keyboard.press("Escape");
  });
});

test("memory panel, settings sections, Manage plugins", async () => {
  await check("panels", async () => {
    await page.locator('.settings-row[data-setting="memory"] .btn-outline').click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Back to details" }).click().catch(() => {});
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const items = page.locator(".settings-nav .nav-item, .nav-item");
    const n = await items.count();
    for (let i = 0; i < n; i++) { await items.nth(i).click(); await page.waitForTimeout(70); }
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Marketplace opens from the account menu (account-menu.ts), a role="menuitem" button (Menus.tsx)
    // reached only through "Open account menu" again — never a bare role="button" on the page.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Marketplace", exact: true }).click();
    await page.getByRole("link", { name: /^Your plugins/ }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Close Marketplace" }).click().catch(() => {});
  });
});

test("reorder the sidebar", async () => {
  await check("reorder", async () => {
    for (const n of ["Cy", "Dee", "Bea"]) { void rig.call("sendPrompt", { id: bots[n]!, text: "hello", clientNonce: `m-${n}-${Date.now()}` }); await page.waitForTimeout(120); }
    await page.waitForTimeout(2500);
  });
});

test("resize the window", async () => {
  await check("resize", async () => {
    for (const [w, h] of [[900, 700], [1400, 900], [760, 600], [1280, 800]] as const) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(120); }
    await link("Bea").click();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});

/**
 * A REAL-LOOKING REPLY. The fake brain cannot stream a SendMessage, so the check delivers the host's
 * exact event sequence for one (turn-runner.ts onEvent + bot-tools.ts deliver), at real speed, through
 * the shim's subscribers: presence thinking → typing dots → a tool-step row → a first streamed message
 * → a second tool row → a 48-chunk streamed reply → the SendMessage tool_start (`typing:true,
 * partialText:null`) → the persisted entry → `typing:false` → presence idle.
 */
test("a streamed reply arrives, lands and the Bot goes idle", async () => {
  const id = (await rig.call("createAgent", { name: "Eve" })).id;
  await page.waitForTimeout(1500); // its kickstart greeting settles first
  await clickRow("Eve");
  await composer("Eve").waitFor();
  await page.waitForTimeout(900);
  const agent = (await rig.call("listAgents", {} as never)).agents.find((a) => a.id === id)!;
  // A conversation with history, as a real one has: the transcript scrolls, so auto-scroll follows every chunk.
  await page.evaluate((id) => {
    const inject = (window as unknown as { __motionInject: (e: unknown) => void }).__motionInject;
    for (let n = 1; n <= 10; n++) {
      inject({ channel: "transcript", payload: { botId: id, op: "append", entry: { kind: "message", id: `t${50 + n}u`, role: "user", content: `earlier question ${n}`, createdAt: Date.now() } } });
      inject({ channel: "transcript", payload: { botId: id, op: "append", entry: { kind: "send-message", id: `t${50 + n}s1`, requestId: `h${n}`, createdAt: Date.now(), message: { type: "text", content: `An earlier answer, number ${n}. ` + "It ran a little long. ".repeat(4) } } } });
    }
  }, id);
  await page.waitForTimeout(1500);
  await check("reply", async () => {
    await page.evaluate(async ({ agent, id }) => {
      const inject = (window as unknown as { __motionInject: (e: unknown) => void }).__motionInject;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const T = 90;
      const now = () => Date.now();
      const presence = (p: string, running: boolean, activity: unknown = null) =>
        inject({ channel: "agent-upserted", payload: { agent: { ...agent, presence: p, running, activity, updatedAt: now() } } });
      const tr = (payload: Record<string, unknown>) => inject({ channel: "transcript", payload: { botId: id, ...payload } });
      const typing = (t: boolean, partialText: string | null) => tr({ op: "typing", typing: t, partialText });
      const tool = (k: number, status: "running" | "done", step: string) =>
        tr({ op: status === "done" ? "update" : "append", entry: { kind: "tool-call", id: `t${T}a${k}`, requestId: "rq", segmentId: `rq:${k}`, hidden: false, name: "Bash", step, icon: "terminal", metric: null, status, startedAt: now(), ...(status === "done" ? { endedAt: now(), metric: { verb: "Ran", noun: "command", nounPlural: "commands", count: 1 } } : {}) } });
      const stream = async (full: string, chunks: number, ms: number) => {
        for (let i = 1; i <= chunks; i++) { typing(true, full.slice(0, Math.ceil((full.length * i) / chunks))); await sleep(ms + (i % 3) * 8); }
      };
      const land = async (k: number, content: string) => {
        typing(true, null); // the SendMessage tool_start: publishTyping(true, null)
        await sleep(140); // hooks and review before the tool runs
        tr({ op: "append", entry: { kind: "send-message", id: `t${T}s${k}`, requestId: "rq", createdAt: now(), message: { type: "text", content } } });
        typing(false, null); // markSent
      };
      tr({ op: "append", entry: { kind: "message", id: `t${T}u`, role: "user", content: "Can you check the build and tell me what broke?", createdAt: now() } });
      await sleep(250);
      presence("thinking", true, { thinking: true });
      await sleep(900);
      presence("working", true, { tool: "Bash", detail: "npm test" });
      tool(1, "running", "Running npm test");
      await sleep(700);
      tool(1, "done", "Ran npm test");
      presence("thinking", true, { thinking: true });
      await sleep(300);
      const first = "Found it. Two tests fail in the parser, both from the same change.";
      await stream(first, 12, 40);
      await land(1, first);
      await sleep(120);
      presence("working", true, { tool: "Bash", detail: "git log" });
      tool(2, "running", "Running git log -3");
      await sleep(600);
      tool(2, "done", "Ran git log -3");
      presence("thinking", true, { thinking: true });
      await sleep(250);
      const reply = "Here's what happened:\n\n1. **a3f9c21** changed `parseDate` to return `null` for an empty string instead of throwing.\n2. Two callers still wrap it in `try/catch` and never check for `null`, so they pass `null` on to `format()`.\n3. `format(null)` throws a `TypeError`, which is the failure you saw.\n\nThe smallest fix is a null check in both callers. Want me to make it and re-run the tests?";
      await stream(reply, 48, 38);
      await land(2, reply);
      await sleep(250);
      presence("idle", false);
    }, { agent, id });
    await page.waitForTimeout(600);
  });
});
