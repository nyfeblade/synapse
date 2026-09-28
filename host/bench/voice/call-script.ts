/**
 * Bug 142: the scripted call both paths are measured on (host/bench/voice/run.ts, and the real-model run).
 * Twelve utterances of a minute-and-a-half call: chat, two things to do, an approval answered by voice, and a
 * follow-up question. `work: true` means the Bot has to use its tools (a delegated task on the fast path, a full
 * turn with tool calls on the old one).
 */
export interface Utterance { text: string; work?: boolean; approvalAnswer?: boolean }

export const CALL_SCRIPT: Utterance[] = [
  { text: "hey, how's it going" },
  { text: "did you get a chance to look at the retainer numbers" },
  { text: "text Sam that I'm running ten minutes late", work: true },
  { text: "yes, send it", approvalAnswer: true },
  { text: "thanks" },
  { text: "what's on my calendar tomorrow", work: true },
  { text: "is the afternoon one the one with the lawyers" },
  { text: "okay, open the deck for it", work: true },
  { text: "no, the other one" },
  { text: "perfect, thanks" },
  { text: "one more thing, remind me to call the bank on Friday", work: true },
  { text: "that's everything, talk later" },
];

/** The call's length in the measurement: the user speaks for about 7 s a turn, including their pauses. */
export const SECONDS_PER_TURN = 7.5;
export const CALL_MINUTES = (CALL_SCRIPT.length * SECONDS_PER_TURN) / 60;
