import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { createLocalTools } from "../../local/local-tools";

/**
 * LOC-06: a local command in flight when the Mac stops answering ends as "unavailable", and the Bot is
 * told so in those words.
 *
 * WHY THIS LIVES HERE (bug 39 (6)). The claim used to be made only by a Phase 5 e2e journey, which
 * SIGKILLed the coordinator utility process and then waited 120 s for the text. Commit 82927eb put the
 * coordinator under supervision — main re-forks it after 500 ms and replays the connection — so the
 * kill stopped meaning "the Mac went away": the Mac came back inside the bridge's 30 s liveness window,
 * `available()` never went false, and the watchdog was right not to fire. The journey went red for the
 * app's correct behaviour, and no test was left making the LOC-06 claim at all.
 *
 * `exec-stuck.test.ts` next door covers the other watchdog — a BOUNDED op the Mac never answers WHILE
 * STILL HEARTBEATING — and its third case pins the deliberate exclusion that makes this one necessary:
 * a long, quiet `run-command` on a live Mac is left alone, so nothing but `!available()` can ever close
 * a shell out. A clock this test owns is also a better instrument than a 120 s wall-clock wait, which
 * on a loaded machine cannot tell a slow watchdog from a missing one.
 */
const computer = { computerId: "mac", label: "Alex's MacBook", isCurrent: true, executionPolicy: "always" as const, localRoot: "/Users/alex/W", home: "/Users/alex", autoRunRoots: ["/Users/alex/W"] };
let now = 0;
let ws: string;
const bots = { appendEntry: () => {}, updateEntry: () => {}, getEntry: () => null } as never;
const slot = () => ({ turnNo: 2, nextSendK: 0, requestId: "req_9", segment: 0 }) as never;
beforeEach(() => {
  now = 1000;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-unavail-"));
});
// idleMs 50 keeps the watchdog's real-time interval short; `now` is the clock it reads.
const mkBridge = () => new LocalBridge({ hub: { publish: () => {} } as never, now: () => now, workspace: ws, idleMs: 50 });
const settle = <T,>(p: Promise<T>, ms = 1500): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

describe("LOC-06: a command in flight when the Mac goes quiet ends as unavailable", () => {
  it("a running shell whose Mac stops heartbeating is closed out, named after the computer", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { done } = b.request({ botId: "b", approvalId: null, op: "run-command", command: "sleep 90" });
    expect(b.available()).toBe(true);
    now += 30_001 + 50; // past livenessMs, then past idleMs with no output
    expect(b.available()).toBe(false);
    await expect(settle(done)).resolves.toMatchObject({ exitCode: null, error: `unavailable:${computer.label}` });
  });

  it("ExternalShell turns that into the LOC-06 sentence the user reads, not a raw error code", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const tools = createLocalTools({ botId: "b", slot, bridge: b, asks: new LocalAsks({ bots, now: () => now }), now: () => now, workspace: ws });
    // block_ms well past the watchdog, so the tool is still waiting when the Mac goes quiet — the exact
    // shape of "local-wait: sleep 90" in the Phase 5 journey.
    const run = tools.find((t) => t.name === "ExternalShell")!.handler({ command: "echo hi", block_ms: 600_000 });
    await new Promise((r) => setTimeout(r, 20)); // let gate() publish the request
    now += 30_001 + 50;
    const r = await settle(run);
    expect(r).not.toBe("hung");
    expect((r as { text: string }).text).toBe(STR5.localUnavailable(computer.label));
    expect(STR5.localUnavailable(computer.label)).toBe(`Your computer "${computer.label}" can't be reached — it seems to be offline.`);
  });
});
