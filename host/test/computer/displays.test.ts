import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITSC, STRC, type SseEvent } from "@synapse/shared";
import { DisplayFullError, DisplayManager } from "../../computer/displays";
import type { DisplayControl } from "../../computer/display-control";
import { SseHub } from "../../gateway/sse-hub";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

class FakeControl implements DisplayControl {
  running = new Map<number, string>();
  calls: string[] = [];
  async start(i: number, token: string) {
    this.calls.push(`start ${i}`);
    const owner = this.running.get(i);
    if (owner && owner !== token) return "owned" as const;
    this.running.set(i, token);
    return "ok" as const;
  }
  async stop(i: number) { this.calls.push(`stop ${i}`); this.running.delete(i); }
  async status(i: number) { return this.running.has(i) ? ("running" as const) : ("stopped" as const); }
  async restartChrome() {}
}

function setup(max = 12, opts: { idle?: (botId: string) => boolean } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const control = new FakeControl();
  let t = 1_000_000;
  const busyDir = fs.mkdtempSync(path.join(os.tmpdir(), "busy-"));
  const mk = () => new DisplayManager({ cfg, control, hub, maxScreens: max, now: () => t, busyDir, xauthDir: "/run/bot-x", idle: opts.idle });
  return { cfg, control, events, mk, busyDir, advance: (ms: number) => { t += ms; } };
}

describe("DisplayManager (CMP-04)", () => {
  it("assigns the first free index from :2 and persists it with an owner token across restarts", () => {
    const s = setup();
    const a = s.mk();
    expect(a.indexFor("bot-a")).toBe(2);
    expect(a.indexFor("bot-b")).toBe(3);
    expect(a.indexFor("bot-a")).toBe(2);
    const ledger = JSON.parse(fs.readFileSync(path.join(s.cfg.hostPrivate, "window-assignments.json"), "utf8"));
    expect(ledger.assignments).toEqual({ "bot-a": 2, "bot-b": 3 });
    expect(ledger.tokens["bot-a"]).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(s.mk().indexFor("bot-b")).toBe(3);
  });

  it("returns null when every seat is taken, and ensure() throws the spec text", async () => {
    const s = setup(2);
    const m = s.mk();
    m.indexFor("a");
    m.indexFor("b");
    expect(m.indexFor("c")).toBeNull();
    await expect(m.ensure("c")).rejects.toThrow(DisplayFullError);
    await expect(m.ensure("c")).rejects.toThrow(STRC.screensFull);
  });

  it("starts lazily, once, even for concurrent callers; publishes the displays channel; bumps the generation", async () => {
    const s = setup();
    const m = s.mk();
    expect(m.info("a")?.running ?? false).toBe(false);
    const [x, y] = await Promise.all([m.ensure("a"), m.ensure("a")]);
    expect(x).toEqual(y);
    expect(x).toMatchObject({ botId: "a", index: 2, display: ":2", cdpPort: LIMITSC.cdpBase + 2, running: true, generation: 1 });
    expect(s.control.calls).toEqual(["start 2"]);
    expect(s.events.some((e) => e.channel === "displays")).toBe(true);
    expect(m.env("a")).toEqual({ DISPLAY: ":2", BOT_CDP_PORT: "9224" });
  });

  it("touch() writes the busy file and refreshes activity; tick() stops a display idle for 30 minutes but keeps the seat", async () => {
    const s = setup();
    const m = s.mk();
    await m.ensure("a");
    m.touch("a");
    expect(fs.existsSync(path.join(s.busyDir, "bot-monitor-busy-2"))).toBe(true);
    s.advance(LIMITSC.displayIdleStopMs - 1);
    await m.tick();
    expect(s.control.calls).toEqual(["start 2"]);
    s.advance(2);
    await m.tick();
    expect(s.control.calls).toEqual(["start 2", "stop 2"]);
    expect(m.info("a")).toMatchObject({ index: 2, running: false });
    await m.ensure("a");
    expect(m.generation("a")).toBe(2);
  });

  it("recovers from a stale owner (exit 75) by stopping and starting again", async () => {
    const s = setup();
    s.control.running.set(2, "someone-else");
    const m = s.mk();
    await m.ensure("a");
    expect(s.control.calls).toEqual(["start 2", "stop 2", "start 2"]);
  });

  it("release() stops the display and frees the seat for the next Bot", async () => {
    const s = setup();
    const m = s.mk();
    await m.ensure("a");
    await m.release("a");
    expect(m.indexFor("b")).toBe(2);
  });

  it("reconcile() at boot marks already-running displays as running without restarting them", async () => {
    const s = setup();
    const m1 = s.mk();
    await m1.ensure("a");
    const m2 = s.mk();
    await m2.reconcile();
    expect(m2.info("a")?.running).toBe(true);
    expect(s.control.calls).toEqual(["start 2"]);
  });
});

describe("retire races an in-flight start (security re-review item 6)", () => {
  it("retire waits for the start, then the screen is stopped and not running", async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realStart = s.control.start.bind(s.control);
    s.control.start = async (i: number, token: string) => { const r = await realStart(i, token); await gate; return r; };
    const d = s.mk();
    const ensured = d.ensure("bot-a").then(() => "started", (e: Error) => `rejected: ${e.message}`);
    await new Promise((r) => setTimeout(r, 10));
    let retired = false;
    const retire = d.retire("bot-a").then(() => { retired = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(retired).toBe(false);
    release();
    await retire;
    expect(await ensured).toMatch(/^rejected/);
    expect(s.control.running.size).toBe(0);
    expect(d.list()).toEqual([]);
    expect(s.control.calls).toContain("stop 2");
  });
});

describe("screen reclaim (controller ruling 1)", () => {
  it("reclaims the LRU idle Bot's screen when a new Bot needs one and none are free", async () => {
    const busy = new Set<string>(["b"]); // "b" has a running turn; "a" and "c" are idle
    const s = setup(3, { idle: (id) => !busy.has(id) });
    const m = s.mk();
    await m.ensure("a");
    s.advance(10);
    await m.ensure("b");
    s.advance(10);
    await m.ensure("c");
    // "a" was used longest ago among the idle Bots ("b" isn't idle, so it's never a candidate).
    expect(m.indexFor("d")).toBe(2);
    expect(m.list().map((x) => x.botId).sort()).toEqual(["b", "c", "d"]);
    expect(s.control.calls).toContain("stop 2");
  });

  it("keeps 'screens full' when no assigned Bot is idle", async () => {
    const s = setup(2, { idle: () => false });
    const m = s.mk();
    await m.ensure("a");
    await m.ensure("b");
    expect(m.indexFor("c")).toBeNull();
  });

  it("releases a screen automatically after 15 minutes idle (LIMITSC.screenIdleMs), keeping it for a Bot that's active", async () => {
    const busy = new Set<string>(["b"]);
    const s = setup(3, { idle: (id) => !busy.has(id) });
    const m = s.mk();
    await m.ensure("a");
    await m.ensure("b");
    await m.tick(); // seeds the idle-since baseline for "a" (idle from the moment it started)
    s.advance(LIMITSC.screenIdleMs - 1);
    await m.tick();
    expect(m.indexFor("a")).toBe(2); // still assigned
    s.advance(2);
    await m.tick();
    expect(m.list().map((x) => x.botId)).toEqual(["b"]); // "a"'s seat is gone
    expect(m.indexFor("a")).toBe(2); // "a" gets a fresh seat like any other Bot
  });

  it("marks a Bot waiting when screens are full, publishes it, and clears it once a seat frees up", async () => {
    const busy = new Set<string>();
    const s = setup(1, { idle: (id) => !busy.has(id) });
    const m = s.mk();
    await m.ensure("a");
    busy.add("a"); // "a" becomes busy: no idle candidate for "b" to reclaim from
    await expect(m.ensure("b")).rejects.toThrow(DisplayFullError);
    expect(m.waitingIds()).toEqual(["b"]);
    expect(s.events.filter((e) => e.channel === "displays").at(-1)).toMatchObject({ payload: { waiting: ["b"] } });
    busy.delete("a"); // "a" goes idle again
    await m.tick(); // seeds the idle-since baseline for "a"
    s.advance(LIMITSC.screenIdleMs);
    await m.tick(); // "a"'s seat is released and handed to the waiting "b"
    expect(m.waitingIds()).toEqual([]);
    expect(m.list().map((x) => x.botId)).toEqual(["b"]);
  });
});
