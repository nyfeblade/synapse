import { describe, expect, it } from "vitest";
import { STRV, type BotSummary, type TranscriptEntry } from "@synapse/shared";
import type { WakeSpec } from "../../runner/turn-runner";
import { ScriptedFrontSession, type FrontSpec } from "../../voice/front-session";
import { VoiceFronts } from "../../voice/front";

// Bug 223: the voice often hands a task over WITHOUT saying anything (it calls delegate first, and the turn ends at the
// tool: Sonnet did it on 5 of 5 delegated turns in the eval). The empty reply was taken for a dead voice and the
// whole turn run again on a fresh one — seconds of dead air, a second model run, and the task handed over twice.

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

function harness(script: (m: string, n: number) => { text: string; delegate?: string }) {
  const wakes: WakeSpec[] = [];
  const said: string[] = [];
  const sessions: ScriptedFrontSession[] = [];
  const bot = { id: "nova", profile: { name: "Nova", title: "", description: "", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const fronts = new VoiceFronts({
    bots: {
      has: () => true, summary: () => bot, publishTyping: () => {}, tail: () => [] as TranscriptEntry[], nextTurnNo: () => 1,
      appendEntry: (_id, e) => { if (e.kind === "send-message" && e.message.type === "text") said.push(e.message.content); },
    },
    runner: { recordVoiceUtterance: () => ({ entryId: "u" }), enqueueWake: (_b, spec) => { wakes.push(spec); return "w"; } },
    gate: null, calls: { roster: () => ["nova"] },
    factory: (spec: FrontSpec) => { const s = new ScriptedFrontSession(spec, script); sessions.push(s); return s; },
    enabled: () => true, now: () => Date.now(),
  });
  fronts.callChanged("nova");
  return { fronts, wakes, said, sessions };
}

describe("bug 223: a turn that handed work over is never run again", () => {
  it("delegated but said nothing: the task goes over exactly once, no second run, and the call says a short 'On it.'", async () => {
    const h = harness(() => ({ text: "", delegate: "Text Sam Lee: running ten minutes late" }));
    h.fronts.userPost("nova", "text Sam that I'm running ten minutes late", "n1");
    await flush();
    expect(h.wakes).toHaveLength(1);
    expect(h.sessions.reduce((n, s) => n + s.messages.length, 0)).toBe(1);
    expect(h.said).toEqual([STRV.delegatedOnIt]);
  });

  it("said nothing and handed nothing over (a dead voice): still one retry, as before", async () => {
    const h = harness((_m, n) => (n === 0 ? { text: "" } : { text: "Sorry, say that again?" }));
    h.fronts.userPost("nova", "hello", "n1");
    await flush();
    expect(h.sessions.reduce((n, s) => n + s.messages.length, 0)).toBe(2);
    expect(h.said).toEqual(["Sorry, say that again?"]);
    expect(h.wakes).toHaveLength(0);
  });
});
