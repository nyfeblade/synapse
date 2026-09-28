import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessageEntry } from "@synapse/shared";
import { b2bHarness, promptText, ridsIn, say, sta } from "./harness";

/**
 * Bug #61: Bots are walled off from each other's private data; the ONE sanctioned way across is asking the teammate
 * (SendToAgent kind "question"). The teammate answers from its own history and memory, the asker gets the answer
 * (never files), both transcripts show the exchange, and it costs one wake each way.
 */
let h: ReturnType<typeof b2bHarness>;
afterEach(() => h?.stop());

const agentEntries = (name: string) => h.bots.tail(h.id(name), 200).filter((e): e is AgentMessageEntry => e.kind === "message" && ("toAgent" in e || "fromAgent" in e));

describe("Ask your teammate (bug #61)", () => {
  it("the Bot prompt says teammates' data is private and names the one way to ask", () => {
    h = b2bHarness(["Piper", "Scout"]);
    const p = h.runner.systemAppend(h.id("Piper"));
    expect(p).toContain('To learn what a teammate knows, ask it: SendToAgent kind "question"');
    expect(p).not.toContain(`${h.cfg.dataRoot}/agents`);
  });

  it("the tool says so too", () => {
    h = b2bHarness(["Piper", "Scout"]);
    const tool = h.runner.wiring(h.id("Piper")).botTools().find((t) => t.name === "SendToAgent")!;
    expect(tool.description).toMatch(/data is private: ask it, kind "question"/);
  });

  it("one question, one answer from the teammate's own history, shown in both transcripts, one wake each way", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", (input) => (input.source === "user"
      ? [sta({ target_id: h.id("Scout"), kind: "question", message: "What is the landlord's name the user told you?", expects: "the name" }), say("Asked Scout.")]
      : []));
    h.script("Scout", (input) => {
      const rid = ridsIn(promptText(input))[0];
      return rid ? [sta({ target_id: h.id("Piper"), kind: "result", in_reply_to: rid, message: "The landlord is Mark Ellis (the user told me on 2026-09-01)." })] : [];
    });
    h.user("Piper", "what's my landlord's name? Scout knows");
    await h.settle();

    const wakes = h.agentWakes("Scout");
    expect(wakes).toHaveLength(1);
    const wake = promptText(wakes[0]!);
    expect(wake).toContain('<message kind="question"');
    expect(wake).toMatch(/Answer a question from your own history and memory \(SearchHistory\)/);
    expect(wake).toMatch(/never paste raw transcripts or files/);

    expect(h.agentWakes("Piper")).toHaveLength(1);
    expect(promptText(h.agentWakes("Piper")[0]!)).toContain("The landlord is Mark Ellis");
    for (const name of ["Piper", "Scout"]) {
      const kinds = agentEntries(name).map((e) => ("toAgent" in e && e.toAgent ? e.toAgent.kind : "fromAgent" in e && e.fromAgent ? e.fromAgent.kind : null));
      expect(kinds, name).toEqual(["question", "result"]);
    }
  });
});
