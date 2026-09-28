import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { ScriptedFrontSession, type FrontSpec } from "../../voice/front-session";
import { VoiceFronts } from "../../voice/front";

// Bug 218, review 1: the host's answer to a send says whether the reply it held already has WORDS (then the call makes
// no end-of-turn sound). A held run that finished saying nothing is not ready — else: no sound, then dead air.

function harness(text: string) {
  const bot = { id: "nova", profile: { name: "Nova", title: "", description: "", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const fronts = new VoiceFronts({
    bots: { has: () => true, summary: () => bot, appendEntry: () => {}, publishTyping: () => {}, tail: () => [] as TranscriptEntry[], nextTurnNo: () => 1 },
    runner: { recordVoiceUtterance: () => ({ entryId: "u" }), enqueueWake: () => "w" },
    gate: null, calls: { roster: () => ["nova"] },
    factory: (spec: FrontSpec) => new ScriptedFrontSession(spec, () => ({ text, firstTextMs: 100, ...(text ? {} : { delegate: "Text Sam: running late" }) })),
    enabled: () => true, now: () => Date.now(),
  });
  fronts.callChanged("nova");
  return fronts;
}

beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

describe("the host's 'ready' answer to a kept speculative start", () => {
  it("a held reply with words is ready", async () => {
    const f = harness("Sure, texting Sam now.");
    f.speculate("nova", "s1", "text Sam I'm running late");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.userPost("nova", "text Sam I'm running late", "n1", { speculationId: "s1" }).ready).toBe(true);
  });

  it("a held run that finished having said nothing is NOT ready (the call's sound still covers the wait)", async () => {
    const f = harness("");
    f.speculate("nova", "s1", "text Sam I'm running late");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.userPost("nova", "text Sam I'm running late", "n1", { speculationId: "s1" }).ready).toBe(false);
  });
});
