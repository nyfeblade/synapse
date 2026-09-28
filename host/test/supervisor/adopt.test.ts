import { describe, expect, it } from "vitest";
import { FakeBrain } from "../../brain/fake-brain";
import type { BrainWiring } from "../../brain/types";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { Supervisor } from "../../supervisor/supervisor";

const wiring = (): BrainWiring => ({
  preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
  stop: async () => ({ block: false }), botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  flags: () => DEFAULT_FLAGS,
});

describe("Supervisor.adopt (ORIG-16 §16.5)", () => {
  it("admits an adopted child brain under its own key in the background lane and counts it against the caps", async () => {
    const made: string[] = [];
    const sup = new Supervisor({ caps: { maxLive: 2, maxRunning: 1, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, brainFactory: (id) => { made.push(id); return new FakeBrain(id, wiring(), () => []); } });
    const child = new FakeBrain("child:sub-1", wiring(), () => [{ text: "report" }]);
    sup.adopt("child:sub-1", child);
    const lease = await sup.acquire("child:sub-1", "background", 1);
    expect(lease.brain).toBe(child);
    expect(sup.counts().running).toBe(1);
    let userAdmitted = false;
    void sup.acquire("bot-a", "user", 2).then(() => { userAdmitted = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(userAdmitted).toBe(false); // maxRunning = 1 is held by the child
    lease.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(userAdmitted).toBe(true);
    expect(made).toEqual(["bot-a"]);
    await sup.forget("child:sub-1");
  });
});
