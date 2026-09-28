import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import type { ModelMessage } from "../../brain/types";
import { b2bHarness, promptText, ridsIn, say, sta } from "./harness";

let h: ReturnType<typeof b2bHarness>;
afterEach(() => {
  expect(h.approvalCards(), "bot-to-bot volume raised a card").toBe(0);
  expect(h.trays.list(), "bot-to-bot volume raised a tray").toEqual([]);
  h.stop();
});

const firstRid = (input: { prompt: ModelMessage[] }) => ridsIn(promptText(input))[0];
const sends = (name: string) => h.bots.tail(h.id(name), 200).filter((e): e is SendMessageEntry => e.kind === "send-message").map((e) => (e.message as { content: string }).content);

describe("ORIG-09 simulations with stub brains that always reply", () => {
  it("a thank-you loop costs exactly one wake (the result), then none", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", (input) => input.source === "user"
      ? [sta({ target_id: h.id("Scout"), kind: "request", message: "Please build a CSV of Q3 leads from the CRM export", expects: "a CSV at /workspace/leads-q3.csv" }), say("Asked Scout.")]
      : [sta({ target_id: h.id("Scout"), kind: "result", message: "Thanks, got it! \u{1F64F}" })]);
    h.script("Scout", (input) => input.source === "agent"
      ? [sta({ target_id: h.id("Piper"), kind: "result", in_reply_to: firstRid(input), message: "Done: 212 rows at /workspace/leads-q3.csv" }), sta({ target_id: h.id("Piper"), kind: "result", message: "Happy to help, let me know if you need anything else!" })]
      : []);
    h.user("Piper", "get me Q3 leads");
    await h.settle();
    expect(h.agentWakes("Scout")).toHaveLength(1);
    expect(h.agentWakes("Piper")).toHaveLength(1);
    expect(promptText(h.agentWakes("Piper")[0]!)).toContain("Done: 212 rows at /workspace/leads-q3.csv");
    expect(h.metrics.efficiency().messagesDropped).toBe(2);
    await h.settle(300);
    expect(h.agentWakes("Scout")).toHaveLength(1);
    expect(h.agentWakes("Piper")).toHaveLength(1);
  });

  it("a repeated request is rejected by G6, and the third repeat ends the exchange with a structured error (L2)", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", (input) => input.source === "user"
      ? [sta({ target_id: h.id("Scout"), kind: "request", message: "Please send the Q3 leads CSV", expects: "the Q3 leads CSV" }), say("Asked Scout.")]
      : [
        sta({ target_id: h.id("Scout"), kind: "request", message: "please send the Q3 leads CSV now", expects: "the Q3 leads CSV" }),
        sta({ target_id: h.id("Scout"), kind: "request", message: "please send the Q3 leads CSV too", expects: "the Q3 leads CSV" }),
        sta({ target_id: h.id("Scout"), kind: "request", message: "please send the Q3 leads CSV ok", expects: "the Q3 leads CSV" }),
        say("I'll pull the rest myself."),
      ]);
    h.script("Scout", (input) => input.source === "agent" ? [sta({ target_id: h.id("Piper"), kind: "result", in_reply_to: firstRid(input), message: "The CSV is ready: 212 leads at /workspace/leads-q3.csv" })] : []);
    h.user("Piper", "get me Q3 leads");
    await h.settle();
    const texts = h.toolLog("Piper").map((l) => l.text);
    expect(texts[1]).toMatch(/^Not sent: this repeats request r_[a-z2-7]{8} \(answered \d+ min ago: "The CSV is ready: 212 leads at \/workspace\/leads-q3.csv"\)\. Use that result or ask something new\.$/);
    expect(texts[2]).toMatch(/^Not sent: this repeats request/);
    expect(texts[3]).toContain("[agent-error] Your exchange with Scout was ended automatically.");
    expect(texts[3]).toContain('"error":"b2b_loop_detected","detector":"repeated_request"');
    expect(texts[3]).toContain("Continue without that exchange: do the work yourself, change the plan, or ask a different Bot.");
    expect(sends("Piper")).toContain("I'll pull the rest myself.");
    expect(h.agentWakes("Scout")).toHaveLength(1);
    expect(h.metrics.efficiency().loopsEnded).toBe(1);
  });

  it("A→B→C→A handoffs: L3 rejects the third handoff", async () => {
    h = b2bHarness(["Piper", "Scout", "Ledger"]);
    const handoff = (to: string, message: string) => sta({ target_id: h.id(to), kind: "handoff", task_id: "t_budgetq4", message, expects: "final Q4 budget sent to the user" });
    h.script("Piper", (input) => (input.source === "user" ? [handoff("Scout", "The Q4 budget is yours now; numbers in /workspace/budget-q4.xlsx"), say("Handed to Scout.")] : []));
    h.script("Scout", (input) => (input.source === "agent" ? [handoff("Ledger", "Passing the Q4 budget task to you; see /workspace/budget-q4.xlsx and the vendor quotes")] : []));
    h.script("Ledger", (input) => (input.source === "agent" ? [handoff("Piper", "Giving the Q4 budget back; totals are in /workspace/budget-q4-totals.csv")] : []));
    h.user("Piper", "hand off the budget");
    await h.settle();
    const last = h.toolLog("Ledger")[0];
    expect(last?.isError).toBe(true);
    expect(last?.text).toContain('"error":"b2b_circular_handoff"');
    expect(h.agentWakes("Piper")).toHaveLength(0);
  });

  it("A requests B while B has an open request to A: L4 rejects it as a deadlock", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Scout", (input) => (input.source === "user" ? [sta({ target_id: h.id("Piper"), kind: "request", message: "Please send me the vendor list", expects: "the vendor list as a CSV" }), say("Asked Piper.")] : []));
    h.script("Piper", (input) => (input.source === "agent" ? [sta({ target_id: h.id("Scout"), kind: "request", message: "Please confirm the approved budget first", expects: "the approved budget number" })] : []));
    h.user("Scout", "get the vendor list");
    await h.settle();
    const t = h.toolLog("Piper")[0];
    expect(t?.isError).toBe(true);
    expect(t?.text).toMatch(/^\[agent-error\] Your message to Scout was not sent\./);
    expect(t?.text).toContain('"error":"b2b_deadlock"');
    expect(h.agentWakes("Scout")).toHaveLength(0);
  });

  it("a chain over its token budget fails further requests (L6); the requester continues on its own", async () => {
    h = b2bHarness(["Piper", "Scout", "Ledger"]);
    h.script("Piper", (input) => input.source === "user"
      ? [sta({ target_id: h.id("Scout"), kind: "request", message: "Please research three cabin options near Hudson", expects: "3 options with nightly prices" }), say("Asked Scout.")]
      : [sta({ target_id: h.id("Ledger"), kind: "request", message: "Please check the $142/night cabin against the travel budget", expects: "yes or no with the total" }), say("I'll check the budget myself.")]);
    h.script("Scout", (input) => {
      if (input.source !== "agent") return [];
      const rid = firstRid(input) as string;
      h.chains.addPeerTurn(h.requests.get(rid)?.chainId as string, { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return [sta({ target_id: h.id("Piper"), kind: "result", in_reply_to: rid, message: "Found 3 cabins; best is $142/night at https://cabins.example/42" })];
    });
    h.user("Piper", "plan a cabin weekend");
    await h.settle();
    const t = h.toolLog("Piper")[1];
    expect(t?.isError).toBe(true);
    expect(t?.text).toContain('"error":"b2b_budget_exhausted"');
    expect(sends("Piper")).toContain("I'll check the budget myself.");
    expect(h.inputs("Ledger")).toHaveLength(0);
  });

  it("5 waking messages within 3 s cost one turn", async () => {
    // coalesceMs is capped from the FIRST message in the burst (fix round 1, mailbox.ts enqueue()), so
    // it must comfortably cover this burst's real wall-clock span (4 × 50 ms waits + real per-hop I/O),
    // not just the 50 ms gap between any two messages. 3 s matches the test's own "within 3 s" title.
    h = b2bHarness(["Piper", "Scout"], { coalesceMs: 3000 });
    const q = (n: number, text: string) => [sta({ target_id: h.id("Scout"), kind: "question", message: text, expects: `answer number ${n}` }), { wait: 50 }];
    h.script("Piper", (input) => (input.source === "user" ? [
      ...q(1, "Which hotel near Hudson is cheapest?"), ...q(2, "Does the cabin allow dogs?"), ...q(3, "Is there parking at the station?"),
      ...q(4, "What time is the last train back on Sunday?"), ...q(5, "Can we check in before 3 PM?"), say("Asked Scout five things."),
    ] : []));
    h.script("Scout", () => []);
    h.user("Piper", "trip questions");
    await h.settle();
    expect(h.agentWakes("Scout")).toHaveLength(1);
    expect(promptText(h.agentWakes("Scout")[0]!).match(/<message kind="question"/g)).toHaveLength(5);
    expect(h.metrics.efficiency().burstsCoalesced).toBeGreaterThanOrEqual(1);
  });

  it("3 results that arrive while the requester is busy cost one wake", async () => {
    h = b2bHarness(["Piper", "Scout", "Ledger", "Rex"]);
    h.script("Piper", (input) => (input.source === "user" ? [
      sta({ target_id: h.id("Scout"), kind: "question", message: "Which cabin is cheapest?", expects: "a cabin name" }),
      sta({ target_id: h.id("Ledger"), kind: "question", message: "What's left in the travel budget?", expects: "a dollar amount" }),
      sta({ target_id: h.id("Rex"), kind: "question", message: "Which weekend is free for both of us?", expects: "a date range" }),
      { wait: 400 },
      say("Asked all three."),
    ] : []));
    const answer = (text: string) => (input: { source: string; prompt: ModelMessage[] }) => (input.source === "agent" ? [sta({ target_id: h.id("Piper"), kind: "result", in_reply_to: firstRid(input), message: text })] : []);
    h.script("Scout", answer("The Riverside cabin, $142/night"));
    h.script("Ledger", answer("$412 left in the travel budget"));
    h.script("Rex", answer("Oct 24–25 is free for both"));
    h.user("Piper", "plan it");
    await h.settle();
    expect(h.agentWakes("Piper")).toHaveLength(1);
    expect(promptText(h.agentWakes("Piper")[0]!).match(/<message kind="result"/g)).toHaveLength(3);
    expect(h.metrics.efficiency().wakesAvoided).toBeGreaterThanOrEqual(2);
  });
});
