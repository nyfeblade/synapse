import { describe, expect, it } from "vitest";
import type { UserMessageEntry } from "@synapse/shared";
import { originOf } from "../../approvals/origin";
import { makeRunnerHarness } from "./harness";

// Bug 142 (voice fast path), the runner's side: on a fast-path call the Bot's voice (a lean front session)
// answers each utterance, so the utterance is recorded in the chat WITHOUT a full-session turn; the real
// work arrives as a "voice-delegate" wake on the full session (user lane, low effort, the user's own origin);
// and while the call is live the full session's streamed text is not published (only its voice speaks).

describe("the runner's voice fast-path seams", () => {
  it("recordVoiceUtterance: a voice-call user message in the chat, owed to nobody, no turn, nothing interrupted", async () => {
    const h = await makeRunnerHarness({ script: () => [{ wait: 200 }, { tool: "mcp__bot__SendMessage", input: { content: "done" } }] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Nova" });
    h.runner.sendPrompt(id, "write the report", "n0");
    await new Promise((r) => setTimeout(r, 50)); // the full session is mid-turn
    const { entryId } = h.runner.recordVoiceUtterance(id, "how's it going?", "n1", { durationMs: 1200 });
    const e = h.bots.getEntry(id, entryId) as UserMessageEntry;
    expect(e).toMatchObject({ kind: "message", role: "user", content: "how's it going?", voice: { durationMs: 1200, call: true } });
    expect(h.bots.confirmedUserSeq(id)).toBe(h.bots.latestUserSeq(id));
    expect(h.runner.recordVoiceUtterance(id, "how's it going?", "n1", {}).entryId).toBe(entryId); // same nonce: same entry
    await h.untilIdle(id);
    // One turn only: the typed request. The utterance never became a full-session turn, and didn't cut it off.
    expect(h.brain(id).inputs).toHaveLength(1);
    expect(h.bots.tail(id, 20).some((x) => x.kind === "send-message" && x.message.type === "text" && x.message.content === "done")).toBe(true);
  });

  it("a voice-delegate wake runs on the user lane at low effort, and counts as the user's own request for review", async () => {
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "Sent." } }] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Nova" });
    let sent: string[] = [];
    h.runner.enqueueWake(id, { source: "voice-delegate", lane: "user", silenceAllowed: false, voiceCall: true, prompt: () => [{ text: "Text Sam: running late" }], onSettle: (slot) => { sent = slot.sentTexts; } });
    await h.untilIdle(id);
    const input = h.brain(id).inputs[0]!;
    expect(input).toMatchObject({ lane: "user", source: "voice-delegate", voiceTurn: true, hidden: true });
    expect(sent).toEqual(["Sent."]);
    expect(originOf("voice-delegate")).toBe("user");
  });

  it("while quiet, the full session's streamed text is not published (typing stays on, with no text)", async () => {
    const h = await makeRunnerHarness({ script: () => [{ emit: { kind: "send_message_delta", toolUseId: "x", partialJson: "{\"content\":\"Hello the" } }, { tool: "mcp__bot__SendMessage", input: { content: "Hello there" } }] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Nova" });
    const typing: (string | null)[] = [];
    h.hub.subscribe((e) => { const p = e.payload as { op?: string; typing?: boolean; partialText?: string | null }; if (e.channel === "transcript" && p.op === "typing" && p.typing) typing.push(p.partialText ?? null); });
    let quiet = true;
    h.runner.setQuietPartials((b) => b === id && quiet);
    h.runner.sendPrompt(id, "hi", "q1");
    await h.untilIdle(id);
    expect(typing.filter((t) => t !== null)).toEqual([]);
    quiet = false;
    h.runner.sendPrompt(id, "hi again", "q2");
    await h.untilIdle(id);
    expect(typing).toContain("Hello the");
  });
});
