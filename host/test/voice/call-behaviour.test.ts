import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { runCall, summary } from "./voice-budget-harness";

// Call behaviour (the call-behaviour branch: "I want better logic for how bots act during calls. It's clunky.").
// The composed 1:1 call of voice-budget-harness.ts (36 real utterances x 3, fake clock, real loop and host
// coordinator), measured on how the Bot behaves rather than how fast it is: does it answer a half-finished
// thought, answer twice, talk over an open utterance, say "sorry" too often, talk too long.

type Result = Awaited<ReturnType<typeof runCall>>;
let call: Result;
beforeAll(async () => {
  call = await runCall();
  if (process.env.CALL_BEHAVIOUR_OUT) writeFileSync(process.env.CALL_BEHAVIOUR_OUT, JSON.stringify({ ...summary(call), perTurn: call.turns.map((t) => [t.id, t.cutIn, t.answerAudio, t.firstAudio, t.frontRuns, t.speculations, t.speculationCancels, t.phrases.join("+")]) }, null, 1));
}, 120_000);

describe("call behaviour: the composed call", () => {
  it("reports", () => {
    const s = summary(call);
    console.log(JSON.stringify(s));
    expect(s.turns).toBe(108);
  });

  it("plan item 3: no answer line starts over an utterance the user has open (was 3 over the user, 5 before the last final)", () => {
    const s = summary(call);
    expect(s.overUser).toBe(0);
    expect(s.fragmentAnswered).toBe(0);
  });

  it("plan item 10: a user who went on right after a pause gets ONE answer, to the whole thought (was: 7 of 18 heard the answer to the fragment too)", () => {
    const s = summary(call);
    expect(s.answeredTwice).toBe(0);
    for (const t of call.turns.filter((x) => x.cutIn)) expect(t.fragmentHeard, t.id).toBe(false);
  });
});
