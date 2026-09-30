import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS, type ConnectorHealthView, type SseEvent } from "@synapse/shared";
import { SseHub } from "../../gateway/sse-hub";
import { TrayService } from "../../trays/trays";
import { ConnectorHealth, HealthProbes, type HealthReport } from "../../health/connector-health";

/** A clock and a timer queue the test drives. */
function clock() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(o: { file?: string | null; uses?: (botId: string, c: ConnectorHealthView) => boolean } = {}) {
  const c = clock();
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const trays = new TrayService(hub, c.now);
  const h = new ConnectorHealth({ publish: (e) => hub.publish(e), trays, now: c.now, file: o.file ?? null, uses: o.uses ?? (() => true), setTimer: c.setTimer, clearTimer: c.clearTimer });
  const alerts = () => events.filter((e): e is Extract<SseEvent, { channel: "connector-alert" }> => e.channel === "connector-alert");
  const healthTrays = () => trays.list().filter((t) => t.dedupeKey?.startsWith("health:"));
  return { c, hub, events, trays, h, alerts, healthTrays };
}

const mcp = (state: HealthReport["state"], extra: Partial<HealthReport> = {}): HealthReport => ({ kind: "mcp", name: "Linear", state, fix: { kind: "mcp-restart", serverId: "linear" }, ...extra });
const gmail = (state: HealthReport["state"]): HealthReport => ({ kind: "google", name: "Gmail", state, fix: { kind: "google" } });

describe("connector health: break and recover", () => {
  it("a connector that worked and then needs sign-in: one tray with Fix, one notification, and it clears on recovery", () => {
    const s = setup();
    s.h.report("google", gmail("ok"));
    expect(s.h.get("google")!.state).toBe("ok");
    s.h.report("google", gmail("needs-sign-in"));
    expect(s.healthTrays()).toHaveLength(1);
    expect(s.healthTrays()[0]!.title).toBe("Gmail needs you to sign in again");
    expect(s.healthTrays()[0]!.buttons[0]).toEqual({ label: "Fix", action: "fix-connector", target: "google" });
    s.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    expect(s.alerts().map((a) => a.payload)).toEqual([{ ids: ["google"], title: "Gmail needs you to sign in again", body: "" }]);
    s.h.report("google", gmail("ok"));
    expect(s.healthTrays()).toHaveLength(0);
    expect(s.h.get("google")!.state).toBe("ok");
  });

  it("a Broken connector carries a short reason on the tray, the view and the notification", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.report("mcp:linear", mcp("broken", { reason: "Didn't start" }));
    expect(s.h.get("mcp:linear")).toMatchObject({ state: "broken", reason: "Didn't start" });
    expect(s.healthTrays()[0]).toMatchObject({ title: "Linear stopped working", detail: "Didn't start" });
    s.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    expect(s.alerts()[0]!.payload).toEqual({ ids: ["mcp:linear"], title: "Linear stopped working", body: "Didn't start" });
  });

  it("setup is not a break: a new server waiting for its first sign-in raises no tray and no notification", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("needs-sign-in"));
    s.c.advance(60_000);
    expect(s.h.get("mcp:linear")!.state).toBe("needs-sign-in");
    expect(s.healthTrays()).toHaveLength(0);
    expect(s.alerts()).toHaveLength(0);
  });

  it("Checking never raises or clears a break", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.report("mcp:linear", mcp("broken", { reason: "Didn't start" }));
    s.h.report("mcp:linear", mcp("checking"));
    expect(s.healthTrays()).toHaveLength(1);
    s.h.report("mcp:linear", mcp("broken", { reason: "Didn't start" }));
    s.c.advance(120_000);
    expect(s.alerts()).toHaveLength(1);
  });

  it("removing a connector (turned off, disconnected) takes it off the list and closes its tray quietly", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.report("mcp:linear", mcp("broken", { reason: "x" }));
    s.h.report("mcp:linear", null);
    expect(s.h.list()).toEqual([]);
    expect(s.healthTrays()).toHaveLength(0);
  });
});

describe("connector health: one notification per break, no storms", () => {
  it("the same break reported again and again notifies once and keeps one tray", () => {
    const s = setup();
    s.h.report("google", gmail("ok"));
    for (let i = 0; i < 50; i++) { s.h.report("google", gmail("needs-sign-in")); s.c.advance(1000); }
    expect(s.alerts()).toHaveLength(1);
    expect(s.healthTrays()).toHaveLength(1);
  });

  it("many connectors breaking at once become one notification", () => {
    const s = setup();
    for (let i = 0; i < 20; i++) s.h.report(`mcp:s${i}`, { ...mcp("ok"), name: `S${i}` });
    for (let i = 0; i < 20; i++) s.h.report(`mcp:s${i}`, { ...mcp("broken", { reason: "Didn't start" }), name: `S${i}` });
    s.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]!.payload.title).toBe("20 connections need attention");
    expect(s.alerts()[0]!.payload.ids).toHaveLength(20);
  });

  it("breaks that keep arriving are held to one notification a minute", () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.h.report(`mcp:s${i}`, { ...mcp("ok"), name: `S${i}` });
    for (let i = 0; i < 5; i++) { s.h.report(`mcp:s${i}`, { ...mcp("broken", { reason: "x" }), name: `S${i}` }); s.c.advance(5_000); }
    s.c.advance(HEALTH_LIMITS.alertMinGapMs * 2);
    expect(s.alerts().length).toBeLessThanOrEqual(2);
    expect(s.alerts().flatMap((a) => a.payload.ids).sort()).toEqual(["mcp:s0", "mcp:s1", "mcp:s2", "mcp:s3", "mcp:s4"]);
  });

  it("a flapping connector (back and broken again within the hour) keeps its tray but doesn't notify again", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.report("mcp:linear", mcp("broken", { reason: "x" }));
    s.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    s.h.report("mcp:linear", mcp("ok"));
    s.c.advance(10 * 60_000);
    s.h.report("mcp:linear", mcp("broken", { reason: "x" }));
    s.c.advance(HEALTH_LIMITS.alertMinGapMs);
    expect(s.alerts()).toHaveLength(1);
    expect(s.healthTrays()).toHaveLength(1);
    // After the hour, a new break is news again.
    s.h.report("mcp:linear", mcp("ok"));
    s.c.advance(HEALTH_LIMITS.alertFlapMs);
    s.h.report("mcp:linear", mcp("broken", { reason: "x" }));
    s.c.advance(HEALTH_LIMITS.alertMinGapMs);
    expect(s.alerts()).toHaveLength(2);
  });

  it("a restart during a break brings the tray back without notifying again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
    dirs.push(dir);
    const file = path.join(dir, "connector-health.json");
    const a = setup({ file });
    a.h.report("google", gmail("ok"));
    a.h.report("google", gmail("needs-sign-in"));
    a.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    expect(a.alerts()).toHaveLength(1);
    const b = setup({ file });
    b.h.report("google", gmail("needs-sign-in"));
    b.c.advance(HEALTH_LIMITS.alertMinGapMs);
    expect(b.healthTrays()).toHaveLength(1);
    expect(b.alerts()).toHaveLength(0);
  });

  it("a network-type failure reads Checking through the grace period, then Broken; a recovery inside it is silent", () => {
    const s = setup();
    s.h.report("telegram", { kind: "telegram", name: "Telegram", state: "ok", fix: { kind: "telegram" } });
    const down: HealthReport = { kind: "telegram", name: "Telegram", state: "broken", reason: "Can't reach it", network: true, fix: { kind: "telegram" } };
    s.h.report("telegram", down);
    expect(s.h.get("telegram")!.state).toBe("checking");
    s.c.advance(60_000);
    s.h.report("telegram", { ...down, state: "ok", network: false, reason: null });
    s.c.advance(HEALTH_LIMITS.networkGraceMs);
    expect(s.alerts()).toHaveLength(0);
    s.h.report("telegram", down);
    s.c.advance(HEALTH_LIMITS.networkGraceMs);
    expect(s.h.get("telegram")).toMatchObject({ state: "broken", reason: "Can't reach it" });
    s.c.advance(HEALTH_LIMITS.alertCoalesceMs);
    expect(s.alerts()).toHaveLength(1);
  });
});

describe("connector health: what the Bots' tool calls show", () => {
  it("an auth error reads Needs sign-in at once; a success clears it", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.noteTool("mcp:linear", { ok: false, auth: true, reason: "" });
    expect(s.h.get("mcp:linear")!.state).toBe("needs-sign-in");
    s.h.noteTool("mcp:linear", { ok: true });
    expect(s.h.get("mcp:linear")!.state).toBe("ok");
  });

  it("other failures need three in a row; one success in between resets the count", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    const fail = { ok: false as const, auth: false, reason: "Tools keep failing" };
    s.h.noteTool("mcp:linear", fail);
    s.h.noteTool("mcp:linear", fail);
    s.h.noteTool("mcp:linear", { ok: true });
    s.h.noteTool("mcp:linear", fail);
    s.h.noteTool("mcp:linear", fail);
    expect(s.h.get("mcp:linear")!.state).toBe("ok");
    s.h.noteTool("mcp:linear", fail);
    expect(s.h.get("mcp:linear")).toMatchObject({ state: "broken", reason: "Tools keep failing" });
  });

  it("the connector's own recovery signal (a reconnect) drops what its tools said", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.noteTool("mcp:linear", { ok: false, auth: true, reason: "" });
    s.h.report("mcp:linear", mcp("needs-sign-in"));
    s.h.report("mcp:linear", mcp("ok"));
    expect(s.h.get("mcp:linear")!.state).toBe("ok");
  });

  it("a tool call for a connector nobody reported is ignored", () => {
    const s = setup();
    s.h.noteTool("mcp:ghost", { ok: false, auth: true, reason: "" });
    expect(s.h.list()).toEqual([]);
  });
});

describe("connector health: the Bot is told in its next turn", () => {
  it("each Bot that uses it hears once per break, and hears when it's back", () => {
    const s = setup({ uses: (botId, c) => c.id !== "google" || botId !== "b3" });
    s.h.report("google", gmail("ok"));
    expect(s.h.noteFor("b1")).toBeNull();
    s.h.report("google", gmail("needs-sign-in"));
    const note = s.h.noteFor("b1")!;
    expect(note).toContain("<connector-status>");
    expect(note).toContain("Gmail needs the user to sign in again.");
    expect(note).toContain("Don't retry in a loop.");
    expect(s.h.noteFor("b1")).toBeNull(); // once
    expect(s.h.noteFor("b2")).toContain("Gmail");
    expect(s.h.noteFor("b3")).toBeNull(); // doesn't use Google
    s.h.report("google", gmail("ok"));
    expect(s.h.noteFor("b1")).toBe("<connector-status>\nGmail is working again.\n</connector-status>");
    expect(s.h.noteFor("b1")).toBeNull();
    expect(s.h.noteFor("b4")).toBeNull(); // never told it was down
  });

  it("a Broken connector's note says why", () => {
    const s = setup();
    s.h.report("mcp:linear", mcp("ok"));
    s.h.report("mcp:linear", mcp("broken", { reason: "Didn't start" }));
    expect(s.h.noteFor("b1")).toContain("- Linear is not working (Didn't start).");
  });
});

describe("health probes", () => {
  it("run when due, one at a time, and back off when they can't get an answer", async () => {
    const c = clock();
    const p = new HealthProbes({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    let calls = 0;
    let answer = false;
    p.set("composio:gmail", async () => { calls++; return answer; }, { everyMs: 60_000 });
    await p.tick();
    expect(calls).toBe(0); // not due yet
    c.advance(60_000);
    await p.tick();
    expect(calls).toBe(1);
    expect(p.nextAt("composio:gmail")).toBe(c.now() + HEALTH_LIMITS.probeRetryMs);
    c.advance(HEALTH_LIMITS.probeRetryMs);
    await p.tick();
    expect(p.nextAt("composio:gmail")).toBe(c.now() + HEALTH_LIMITS.probeRetryMs * 2);
    answer = true;
    c.advance(HEALTH_LIMITS.probeRetryMs * 2);
    await p.tick();
    expect(p.nextAt("composio:gmail")).toBe(c.now() + 60_000);
    // The cap: a probe that never answers waits a day at most.
    answer = false;
    for (let i = 0; i < 20; i++) { c.advance(HEALTH_LIMITS.probeMaxBackoffMs); await p.tick(); }
    expect(p.nextAt("composio:gmail")! - c.now()).toBeLessThanOrEqual(HEALTH_LIMITS.probeMaxBackoffMs);
  });
});
