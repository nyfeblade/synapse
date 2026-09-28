import { describe, expect, it } from "vitest";
import { STR5, type LocalExecRequest } from "@synapse/shared";
import type { FakeScript } from "../../brain/fake-brain";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { createLocalTools } from "../../local/local-tools";
import { groupHarness, promptText, say, until } from "../groups/harness";

// Bug 94: a Mac card the user never answers must not hold a running slot. The Mac tool posts the card and the turn
// ends (the supervisor lease is released while it waits); the answer wakes the Bot, and its re-run carries the
// one-time approval. Driven through the real TurnRunner, Supervisor and FakeBrain.

const computer = { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex/W", home: "/Users/alex" };

describe("an unanswered Mac card frees the Bot's running slot (bug 94)", () => {
  it("the turn ends at the card, nothing waits on the Mac, and the answer resumes the Bot with the approval", async () => {
    const sent: LocalExecRequest[] = [];
    const script: FakeScript = (input) => {
      const p = promptText(input);
      if (p.includes(STR5.localAskResumed("brew upgrade"))) return [{ tool: "mcp__bot__ExternalShell", input: { command: "brew upgrade", block_ms: 0 } }, say("Running it now.")];
      return [{ tool: "mcp__bot__ExternalShell", input: { command: "brew upgrade" } }, say("should not get here")];
    };
    const h = groupHarness(() => script);
    const hub = { publish: (e: { channel: string; payload: unknown }) => { if (e.channel === "local-exec") sent.push(e.payload as LocalExecRequest); } } as never;
    const bridge = new LocalBridge({ hub, now: Date.now, workspace: h.cfg.workspace });
    bridge.register(computer);
    const asks = new LocalAsks({ bots: h.bots, now: Date.now, wake: (botId, text) => h.runner.enqueueHidden(botId, { source: "widget-answer", lane: "user", silenceAllowed: false, text }) });
    h.runner.registerToolProvider((botId, slot) => createLocalTools({ botId, slot, bridge, asks, now: Date.now, permMode: () => "ask", autoReviewOn: () => true }));
    const a = h.mk("Nova");
    h.runner.sendPrompt(a, "upgrade my brew packages", "n1");
    await until(() => (h.brains.get(a)?.inputs.length ?? 0) >= 1 && h.runner.recipientState(a) !== "user");
    await until(() => h.runner.slot(a) === null);
    // The card is pending, the Mac was sent nothing, and the Bot holds no slot while the user decides.
    const cards = h.bots.tail(a, 50).flatMap((e) => (e.kind === "send-message" && "card" in e.message ? [(e.message as { card: { askId?: string; status?: string } }).card] : []));
    const ask = cards.find((c) => typeof c.askId === "string");
    expect(ask, "the Mac card was posted").toBeTruthy();
    expect(ask!.status).toBe("pending");
    expect(sent).toHaveLength(0);
    expect(h.runner.slot(a)).toBeNull();
    // The answer wakes the Bot; its re-run carries the one-time approval to the Mac.
    asks.resolve(a, ask!.askId!, "once");
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ op: "run-command", command: "brew upgrade", approvalId: ask!.askId });
  });
});
