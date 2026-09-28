import fs from "node:fs";
import path from "node:path";
import type { B2BKind, RequestKind, SendToAgentArgs } from "@synapse/shared";
import type { ClassifierVerdict } from "../../b2b/classifier";
import type { GateDecision, GateInput } from "../../b2b/gate";
import { RequestStore } from "../../b2b/requests";
import { threadLineOf } from "../../b2b/text";
import { ThreadStore } from "../../b2b/threads";

export interface EvalCase {
  id: string;
  expect: "drop" | "deliver" | "inbox";
  note?: string;
  thread?: { from: "A" | "B"; kind: B2BKind; text: string; minsAgo: number; ref?: string }[];
  open?: { ref: string; from: "A" | "B"; kind: RequestKind; expects: string; minsAgo: number; answered?: string }[];
  send: Omit<SendToAgentArgs, "target_id" | "in_reply_to"> & { in_reply_to_ref?: string };
}
export type Outcome = "drop" | "deliver" | "inbox" | "ambiguous";

export const EVAL_NOW = 1_800_000_000_000;
const other = (x: "A" | "B") => (x === "A" ? "B" : "A");

export function loadCases(file: string): EvalCase[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as EvalCase);
}

/** Rebuilds the case's thread and open requests in fresh stores under `dir` and returns the gate input for its send. */
export function replayCase(c: EvalCase, dir: string): GateInput {
  let t = EVAL_NOW;
  const clock = () => t;
  const requests = new RequestStore(path.join(dir, "req.json"), clock);
  const threads = new ThreadStore(path.join(dir, "threads"), clock);
  const refs = new Map<string, string>();
  for (const o of c.open ?? []) {
    t = EVAL_NOW - o.minsAgo * 60_000;
    const r = requests.open({ from: o.from, to: other(o.from), kind: o.kind, expects: o.expects, chainId: "c_eval" });
    refs.set(o.ref, r.rid);
    if (o.answered) requests.answer(r.rid, other(o.from), o.answered);
  }
  for (const l of c.thread ?? []) {
    t = EVAL_NOW - l.minsAgo * 60_000;
    threads.record(threadLineOf({ at: t, from: l.from, to: other(l.from), kind: l.kind, message: l.text, rid: l.ref ? refs.get(l.ref) : undefined }));
  }
  t = EVAL_NOW;
  const { in_reply_to_ref, ...send } = c.send;
  const args: SendToAgentArgs = { ...send, target_id: "B", ...(in_reply_to_ref ? { in_reply_to: refs.get(in_reply_to_ref) } : {}) };
  return { from: "A", to: "B", toName: "Scout", args, requests, threads, nameOf: (id) => (id === "B" ? "Scout" : "Piper"), now: EVAL_NOW };
}

/** What the host does with a gate decision when no classifier runs. An unbound result goes to the inbox (ORIG-09 §09.1). */
export function deterministicOutcome(d: GateDecision): Outcome {
  if (d.verdict === "reject" || d.verdict === "drop") return "drop";
  if (d.verdict === "ambiguous") return "ambiguous";
  return d.kind === "result" && d.boundRid === null ? "inbox" : "deliver";
}

export function classifierOutcome(v: ClassifierVerdict): Outcome {
  return v.verdict;
}
