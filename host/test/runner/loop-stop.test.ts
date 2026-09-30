import { describe, expect, it } from "vitest";
import { STR_COST } from "@synapse/shared";
import { messageText, type TurnEvent } from "../../brain/types";
import type { FakeStep } from "../../brain/fake-brain";
import { LOOP_LIMITS } from "../../runner/loop-guard";
import { makeRunnerHarness } from "./harness";

// 5.7 "stop on repeated failure", through the real TurnRunner: the pause, Continue and Stop.
const send = (text: string): FakeStep => ({ tool: "mcp__bot__SendMessage", input: { content: text } });
const failing = (n: number): FakeStep[] => Array.from({ length: n }, (_, i): FakeStep[] => [
  { emit: { kind: "spend", turnUsd: 0.03 * (i + 1) } as TurnEvent },
  { tool: "Bash", input: { command: "npm install" }, output: `npm ERR! code ENOTFOUND request to https://registry.npmjs.org failed (${i})`, isError: true },
]).flat();
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

async function stuckBot() {
  // The first turn loops on the same failure; any later turn (Continue, a new message) answers.
  const h = await makeRunnerHarness({
    script: (input, ctx) => ctx.turnIndex === 0 ? [...failing(LOOP_LIMITS.sameErrorMax + 6), send("done")] : [send(`answered: ${messageText(input.prompt.at(-1)!).slice(0, 40)}`)],
  });
  const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
  h.runner.sendPrompt(id, "install the deps", "n-1");
  await until(() => h.runner.loopStopped(id));
  await until(() => !h.runner.isRunning(id));
  return { h, id };
}

const loopTray = (h: Awaited<ReturnType<typeof stuckBot>>["h"], id: string) => h.trays.list().find((t) => t.botId === id && t.dedupeKey === `${id}:loop`);

describe("stop on repeated failure (the runner)", () => {
  it("pauses the Bot's turn at the threshold and shows one tray with what the loop cost", async () => {
    const { h, id } = await stuckBot();
    const tray = loopTray(h, id)!;
    expect(tray.title).toBe(STR_COST.loopStopped("Piper", "npm install"));
    expect(tray.detail).toBe(`${LOOP_LIMITS.sameErrorMax} tries · $0.09 spent`);
    expect(tray.buttons.map((b) => b.action)).toEqual(["loop-continue", "loop-stop"]);
    // The turn was cut there: no more failing calls ran, and nothing was said.
    const ran = h.bots.tail(id, 200).filter((e) => e.kind === "tool-call");
    expect(ran.length).toBeLessThanOrEqual(LOOP_LIMITS.sameErrorMax + 1);
    expect(h.bots.tail(id, 200).some((e) => e.kind === "send-message")).toBe(false);
  });

  it("holds the Bot while stopped: queued wakes wait (never dropped), no redrive runs", async () => {
    const { h, id } = await stuckBot();
    h.runner.enqueueHidden(id, { source: "shell-done", lane: "background", silenceAllowed: true, text: "[shell finished]" });
    await new Promise((r) => setTimeout(r, 80));
    expect(h.runner.isRunning(id)).toBe(false);
    expect(h.runner.queued(id, () => true)).toBe(1);
    expect(h.brain(id).inputs).toHaveLength(1);
  });

  it("Continue: the tray goes, one turn says what happened, and the Bot answers the user", async () => {
    const { h, id } = await stuckBot();
    const tray = loopTray(h, id)!;
    expect(await h.runner.loopAction(tray.id, "loop-continue")).toBe(true);
    expect(loopTray(h, id)).toBeUndefined();
    await h.untilIdle(id);
    const cont = h.brain(id).inputs[1]!;
    expect(cont.source).toBe("loop-continue");
    expect(messageText(cont.prompt.at(-1)!)).toContain("npm install");
    expect(h.runner.loopStopped(id)).toBe(false);
    expect(h.acks.get(id)).toBeNull(); // the owed reply went out
  });

  it("Stop: the tray goes, queued work and the owed reply are dropped, and nothing more runs", async () => {
    const { h, id } = await stuckBot();
    h.runner.enqueueHidden(id, { source: "shell-done", lane: "background", silenceAllowed: true, text: "[shell finished]" });
    const tray = loopTray(h, id)!;
    expect(await h.runner.loopAction(tray.id, "loop-stop")).toBe(true);
    expect(loopTray(h, id)).toBeUndefined();
    expect(h.runner.loopStopped(id)).toBe(false);
    expect(h.acks.get(id)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(h.brain(id).inputs).toHaveLength(1);
    expect(h.runner.queued(id, () => true)).toBe(0);
  });

  it("a new message from the user answers the stop: it runs at once", async () => {
    const { h, id } = await stuckBot();
    h.runner.sendPrompt(id, "try yarn instead", "n-2");
    await h.untilIdle(id);
    expect(loopTray(h, id)).toBeUndefined();
    expect(h.brain(id).inputs).toHaveLength(2);
    expect(h.runner.loopStopped(id)).toBe(false);
  });

  it("does not trip on a test re-run after each edit", async () => {
    const steps: FakeStep[] = [];
    for (let i = 0; i < 10; i++) {
      steps.push({ tool: "Bash", input: { command: "npm test" }, output: "FAIL sum.test.ts expected 3 received 4", isError: true });
      steps.push({ tool: "Edit", input: { file_path: "/w/sum.ts", old_string: `v${i}`, new_string: `v${i + 1}` }, output: "updated" });
    }
    const h = await makeRunnerHarness({ script: () => [...steps, send("fixed")] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    h.runner.sendPrompt(id, "fix the test", "n-1");
    await h.untilIdle(id);
    expect(h.runner.loopStopped(id)).toBe(false);
    expect(loopTray(h, id)).toBeUndefined();
    expect(h.bots.tail(id, 200).some((e) => e.kind === "send-message")).toBe(true);
  });

  it("any brain: it reads only turn events, so a brain that just emits tool events is covered", async () => {
    // The provider path (not in this tree) runs through the same runner.onEvent; a raw event stream is enough.
    const raw: FakeStep[] = [];
    for (let i = 0; i < LOOP_LIMITS.sameErrorMax; i++) {
      raw.push({ emit: { kind: "tool_start", toolUseId: `x${i}`, name: "http_get", input: { url: "https://x.test" }, messageId: `m${i}` } });
      raw.push({ emit: { kind: "tool_end", toolUseId: `x${i}`, name: "http_get", isError: true, output: "HTTP 500" } });
    }
    const h = await makeRunnerHarness({ script: (_i, ctx) => ctx.turnIndex === 0 ? [...raw, { wait: 200 }, send("never")] : [send("ok")] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    h.runner.sendPrompt(id, "go", "n-1");
    await until(() => h.runner.loopStopped(id));
    expect(loopTray(h, id)?.title).toBe(STR_COST.loopStopped("Piper", "http_get"));
  });
});
