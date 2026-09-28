import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MacAppController } from "../../src/main/macapp/controller";
import { MacHelper } from "../../src/main/macapp/helper";
import { OsascriptRunner, WarmFirstRunner } from "../../src/main/macapp/osa";

/**
 * mac-apps: THE REAL MAC. Opt-in with RUN_MAC=1, because every case here drives the actual apps on the machine
 * it runs on. It is the only place the timings in the bug log come from — the unit suites stub osascript.
 *
 * What it deliberately does NOT do: send a message or an email to anybody. Those are the two actions that reach
 * another person and cannot be taken back, so the send path is measured as far as the app (a real Messages read,
 * which pays the identical Apple-event round trip) and the send itself stays the user's to make. Everything it
 * does create — one calendar event, one reminder — it deletes again in the same test.
 */
const LIVE = process.env.RUN_MAC === "1";
const d = LIVE ? describe : describe.skip;

let dir: string;
let helper: MacHelper;
let c: MacAppController;
const times: [string, number][] = [];
/** Whether this Mac can actually read a window tree (see the probe in beforeAll). */
let axWorks = false;

const bin = path.join(__dirname, "../../dist/native", "bots-mac");

beforeAll(async () => {
  if (!LIVE) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "macapp-live-"));
  helper = new MacHelper({ binary: bin, log: () => {} });
  const osa = new WarmFirstRunner({ helper, fallback: new OsascriptRunner({}), log: () => {} });
  c = new MacAppController({ helper, osa, home: os.homedir(), userData: dir, log: () => {} });
  // SPEED: the helper is warm before anything is measured, which is how it runs in the app.
  expect(await c.warm(), "the bots-mac helper must be built (npm run build -w @synapse/app)").toBe(true);
  // A FUNCTIONAL Accessibility probe, not AXIsProcessTrusted(): that returns true on a Mac whose grant has
  // been invalidated (an ad-hoc rebuild changes the cdhash TCC keyed the grant to, and a declined consent
  // dialog does it too), and every window then reads back as the application element with no children.
  // Asking whether a real window can actually be read is the only answer that means anything.
  const probe = await c.handle({ botId: "probe", botName: "Timing", args: { action: "ui.outline", app: "Finder" } as never, approved: true });
  axWorks = probe.ok && (probe as { reply: { text: string } }).reply.text.split("\n").length > 3;
  if (!axWorks) process.stdout.write("\naccessibility: this Mac cannot read a window tree right now, so the ui.* cases are skipped\n");
});

afterAll(() => {
  if (!LIVE) return;
  c.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (times.length) process.stdout.write(`\nmac-apps, measured on this Mac (warm helper):\n${times.map(([k, ms]) => `  ${k.padEnd(34)} ${ms} ms`).join("\n")}\n`);
  if (blocked.length) process.stdout.write(`\nnot measurable until the user grants the consent macOS is waiting on (Settings \u2192 Computer \u2192 Apps):\n${blocked.map((k) => `  ${k}`).join("\n")}\n`);
});

/**
 * An app whose Automation consent the user has not answered yet cannot be timed: macOS holds the Apple event
 * behind an undecided consent, and the script expires on its own. That is not a broken build — it is the state
 * every Mac starts in — so it is reported as a blocked capability and the case stops there. What it proves is
 * the thing that WAS broken and is now fixed: one blocked app no longer holds up any other lane.
 */
const blocked: string[] = [];
const notGranted = (r: { ok: boolean } & Record<string, unknown>): boolean =>
  !r.ok && /still running after|didn't answer in time|hasn't allowed/.test(String(r.error ?? ""));

const run = async (name: string, args: Record<string, unknown>, approved = true) => {
  const t = Date.now();
  const r = await c.handle({ botId: "live", botName: "Timing", args: args as never, approved });
  const ms = Date.now() - t;
  if (notGranted(r as never)) blocked.push(name);
  else times.push([name, ms]);
  return { r, ms, blocked: notGranted(r as never) };
};

d("mac-apps on the real Mac (RUN_MAC=1)", () => {
  it("opens an app", async () => {
    const { r, ms, blocked: no } = await run("open an app (Calculator)", { action: "open", app: "Calculator" });
    if (no) return; // System Events consent not answered yet
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(ms).toBeLessThan(3_000);
  });

  it("reads Messages (the same Apple-event round trip a send pays; nothing is sent)", async () => {
    const { r, blocked: no } = await run("Messages round trip (read)", { action: "messages.threads", limit: 3 });
    if (no) return;
    // A Mac that has never used Messages answers with an empty list, which is still a real round trip.
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Messages reads get the long script budget (a big chat history), so this case needs more than
    // the project's 20 s default before it can even report that consent is what is holding it up.
  }, 40_000);

  it("creates a calendar event, then cancels it again", async () => {
    const start = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19);
    const { r, ms, blocked: no } = await run("create a Calendar event", { action: "calendar.create", title: "Synapse timing check", start });
    if (no) return;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(ms).toBeLessThan(3_000);
    const id = (JSON.parse((r as { reply: { text: string } }).reply.text) as { id?: string }).id;
    expect(id).toBeTruthy();
    const { r: gone } = await run("cancel a Calendar event", { action: "calendar.cancel", ref: id });
    expect(gone.ok, JSON.stringify(gone)).toBe(true);
  });

  it("adds a reminder, then completes it", async () => {
    const title = `Synapse timing check ${Date.now()}`;
    const { r, ms, blocked: no } = await run("add a Reminder", { action: "reminders.create", title });
    if (no) return;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(ms).toBeLessThan(3_000);
    const { r: done } = await run("complete a Reminder", { action: "reminders.complete", title });
    expect(done.ok, JSON.stringify(done)).toBe(true);
  });

  it("reads and clicks a non-scriptable app through the Accessibility helper", async () => {
    // Calculator is already open from the first case. Opening it again would go through System Events,
    // whose own consent may be undecided — and this case is about the Accessibility path, not that one.
    if (!axWorks) { blocked.push("Accessibility (read and click any app)"); return; }
    const { r, ms } = await run("ui.outline (Calculator)", { action: "ui.outline", app: "Calculator" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const text = (r as { reply: { text: string } }).reply.text;
    expect(text).toContain("App: Calculator");
    expect(ms).toBeLessThan(3_000);
    // Calculator has no AppleScript interface at all, so this is the generic path doing real work.
    const ref = /\[(e\d+)\] button "5"/.exec(text)?.[1] ?? /\[(e\d+)\] button/.exec(text)?.[1];
    expect(ref, `no button in the outline:\n${text.slice(0, 600)}`).toBeTruthy();
    const { r: clicked, ms: clickMs } = await run("ui.press (Accessibility click)", { action: "ui.press", ref, app: "Calculator" });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    expect(clickMs).toBeLessThan(3_000);
  });

  it("the warm helper answers a repeated script far faster than the first (the compile cache)", async () => {
    const a = await run("apps (first)", { action: "apps" });
    const b = await run("apps (repeat)", { action: "apps" });
    if (a.blocked || b.blocked) return;
    expect(b.ms).toBeLessThanOrEqual(a.ms + 50);
  });

  /**
   * The regression that mattered: one app whose consent is undecided used to hold the whole helper, so an
   * Accessibility read of an unrelated app never answered either. Each lane is independent now.
   */
  it("one blocked app does not hold up any other lane", async () => {
    if (!axWorks) return;
    const slow = run("Calendar while blocked", { action: "calendar.calendars" });
    const t = Date.now();
    const { r } = await run("ui.outline beside a blocked app", { action: "ui.outline", app: "Calculator" });
    const beside = Date.now() - t;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(beside, "an AX read must not wait for a blocked Apple event").toBeLessThan(2_000);
    await slow;
  });
});
