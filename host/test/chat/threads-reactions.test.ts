import { describe, expect, it } from "vitest";
import { createReactionCommands, createReactionToolExtension, toggleReaction } from "../../chat/reactions";
import { createThreadCommands, createThreadHooks, validateReplyTo } from "../../chat/threads";
import { composeHooks } from "../../runner/hooks";
import { makeRunnerHarness } from "../runner/harness";

describe("threads (CHAT-11)", () => {
  it("tells the model what the user replied to and returns the thread", async () => {
    const h = await makeRunnerHarness({ hooksFactory: (bots) => composeHooks([createThreadHooks({ bots })]), script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "Here is the Denver plan with three options for you." } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "plan Denver", "n1");
    await h.untilIdle(id);
    h.runner.sendPrompt(id, "pick the second", "n2", { replyToId: validateReplyTo(h.bots, id, "t1s1") });
    await h.untilIdle(id);
    expect(JSON.stringify(h.brain(id).inputs.at(-1)!.prompt)).toContain('[In reply to t1s1: \\"Here is the Denver plan with three options for you.\\"]');
    const t = await createThreadCommands({ bots: h.bots }).getAgentThread!({ id, entryId: "t1s1" });
    expect(t.root?.id).toBe("t1s1");
    expect(t.replies.map((e) => e.id)).toEqual(["t2u", "t2s1"]);
    expect(() => validateReplyTo(h.bots, id, "t9u")).toThrow("You can only reply to a message in this conversation.");
  });
});

describe("reactions (CHAT-12)", () => {
  it("toggles", () => {
    const a = toggleReaction(undefined, { emoji: "👍", by: "user" });
    expect(a).toEqual({ list: [{ emoji: "👍", by: "user" }], added: true });
    expect(toggleReaction(a.list, { emoji: "👍", by: "user" })).toEqual({ list: [], added: false });
  });

  it("a user reaction on a Bot message wakes it silently; on a user message it doesn't", async () => {
    const woke: string[] = [];
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "Booked the 9:10 flight for you." } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "book it", "n1");
    await h.untilIdle(id);
    const cmd = createReactionCommands({ bots: h.bots, wake: (_b, t) => woke.push(t) });
    expect((await cmd.reactToMessage!({ id, entryId: "t1s1", emoji: "🎉" })).reactions).toEqual([{ emoji: "🎉", by: "user" }]);
    expect(woke).toEqual(['[The user reacted 🎉 to your message: "Booked the 9:10 flight for you.". You don\'t need to reply unless it changes what you should do.]']);
    await cmd.reactToMessage!({ id, entryId: "t1u", emoji: "👍" });
    await cmd.reactToMessage!({ id, entryId: "t1s1", emoji: "🎉" }); // removing never wakes
    expect(woke).toHaveLength(1);
    await expect(cmd.reactToMessage!({ id, entryId: "t1s1", emoji: "this is not an emoji at all" })).rejects.toThrow(/16/);
  });

  it("ReactToMessage lets the Bot react to a user message and counts as the reply (OUT-08)", async () => {
    const h = await makeRunnerHarness({
      toolExtensionsFactory: (bots) => createReactionToolExtension({ bots, acks: { clear: () => {} } }),
      script: () => [{ tool: "mcp__bot__ReactToMessage", input: { message_address: "t1u", emoji: "👍" } }],
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "thanks, that's all", "n1");
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t1u")).toMatchObject({ reactions: [{ emoji: "👍", by: id }] });
    expect(h.bots.confirmedUserSeq(id)).toBe(1);
  });
});
