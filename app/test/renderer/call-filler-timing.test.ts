import { describe, expect, it } from "vitest";
import { CALL_FEEL } from "@synapse/shared";
import { FILLER_AFTER_ACK_MS, VoiceLoop } from "../../src/renderer/voice/voice-loop";

// call-behaviour: the filler is due at a set time after the user's final. It used to wait for the loop's next 200 ms
// tick (VoiceOverlay), so it came 0-200 ms late on every turn that needed one.

function harness() {
  const spoken: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const h = { now: 1_000, spoken, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => {}, stop: () => {}, send: () => {},
    speak: (t, s) => { spoken.push(`${s?.phrase ?? "reply"}@${h.now}:${t}`); return new Promise<void>(() => {}); },
    cancelSpeech: () => {}, now: () => h.now, silenceMs: 700, helperEndpoints: true,
    phrase: (kind) => (kind === "ack" ? null : `${kind} line`),
    members: () => [{ id: "nova", name: "Nova" }],
    after: (ms, fn) => { timers.push({ at: h.now + ms, fn }); },
  });
  /** Time passes with NO tick at all: only the loop's own timers run. */
  const advance = (ms: number) => {
    const end = h.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      h.now = t.at;
      t.fn();
    }
    h.now = end;
  };
  return { ...h, advance, get: () => spoken };
}

describe("the filler comes on time, not on the next tick", () => {
  it("a slow answer: the filler starts exactly fillerAfterMs after the final", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's on my calendar tomorrow");
    h.advance(CALL_FEEL.fillerAfterMs + 50);
    expect(h.get()).toEqual([`filler@${1_000 + CALL_FEEL.fillerAfterMs}:filler line`]);
  });

  it("an answer that is already talking: no filler when it falls due", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("hi");
    h.loop.onBotStream("nova", "Hey there. ");
    h.advance(FILLER_AFTER_ACK_MS + 100);
    expect(h.get().filter((x) => x.startsWith("filler"))).toEqual([]);
  });
});
