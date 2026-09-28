import { describe, expect, it } from "vitest";
import { messageText } from "../../brain/types";
import { makeRunnerHarness } from "./harness";

// Portable install, fix round 1 (blocker 1): re-provisioning the Bots' computer restarts services, so it must
// never cut a Bot's turn. While it runs, NEW turns are held: a message the user sends is accepted and shown,
// queued, and answered after — never dropped — and the turn already running finishes first.
const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

describe("holding new turns for box maintenance", () => {
  it("a message sent mid-maintenance is queued, not started, and answered once maintenance ends", async () => {
    const h = await makeRunnerHarness({ script: (input) => [send(`re: ${messageText(input.prompt.at(-1)!).slice(-20)}`)] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    h.runner.holdNewTurns(true);
    expect(h.runner.newTurnsHeld()).toBe(true);
    h.runner.sendPrompt(id, "are you there?", "n-1");
    await new Promise((r) => setTimeout(r, 60));
    // Accepted (the transcript has it, the obligation to answer is recorded) but not started.
    expect(h.runner.isRunning(id)).toBe(false);
    expect(h.runner.queued(id, () => true)).toBe(1);
    expect(h.acks.get(id)).not.toBeNull();
    expect(h.brain(id)?.inputs ?? []).toHaveLength(0);
    h.runner.holdNewTurns(false);
    await until(() => (h.brain(id)?.inputs.length ?? 0) > 0);
    await h.untilIdle(id);
    expect(h.acks.get(id)).toBeNull(); // answered
  });

  it("the turn already running finishes; only new ones wait", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const h = await makeRunnerHarness({
      script: () => [{ tool: "mcp__bot__Wait", input: {} }, send("done")],
      toolExtensionsFactory: () => ({ extraTools: () => [{ name: "Wait", description: "wait", readOnly: true, schema: {}, handler: async () => { await slow; return { text: "ok" }; } }] }) as never,
    });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    h.runner.sendPrompt(id, "long job", "n-1");
    await until(() => h.runner.isRunning(id));
    h.runner.holdNewTurns(true);
    h.runner.sendPrompt(id, "and another", "n-2");
    expect(h.runner.isRunning(id)).toBe(true); // not interrupted
    release();
    await until(() => !h.runner.isRunning(id));
    expect(h.runner.queued(id, () => true)).toBeGreaterThanOrEqual(1);
    h.runner.holdNewTurns(false);
    await h.untilIdle(id);
  });

  it("a restart during maintenance (the deploy restarts the host) still answers the held message", async () => {
    const h = await makeRunnerHarness({ script: () => [send("answered after the restart")], timings: { ackRedriveIdleMs: 50 } });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    h.runner.holdNewTurns(true);
    h.runner.sendPrompt(id, "hello during the update", "n-1");
    h.runner.quiesce(); // what the host does on SIGTERM
    const next = h.boot(); // a new host process: nothing held
    next.runner.resumeAtBoot();
    await until(() => h.acks.get(id) === null, 5000);
  });
});
