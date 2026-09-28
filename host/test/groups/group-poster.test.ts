import { describe, expect, it, vi } from "vitest";
import type { AgentMessageEntry, SendMessageEntry } from "@synapse/shared";
import { BotGroupPoster } from "../../groups/group-poster";
import { SideExchangeMirror } from "../../groups/side-exchanges";
import { log } from "../../util/log";
import { groupHarness, promptText, say } from "./harness";

const isGroupTurn = (t: string) => t.includes("[Group chat:");

function setup(post = (_name: string) => "(pass)") {
  const lanes: Record<string, string[]> = {};
  const h = groupHarness((_id, name) => (input) => {
    if (!isGroupTurn(promptText(input))) return [];
    (lanes[name] ??= []).push(input.lane);
    return [say(post(name))];
  });
  const [p, s, l] = ["Planner", "Scout", "Ledger"].map(h.mk);
  const { id: g } = h.groups.create([p!, s!, l!], { origin: "user" });
  const poster = new BotGroupPoster({ groups: h.groups, orchestrator: h.orch, bots: h.bots, now: Date.now, metrics: h.metrics });
  const chain = h.chains.start("user", p!).chainId;
  return { h, p: p!, s: s!, l: l!, g, poster, lanes, chain };
}
const botPosts = (entries: unknown[]) => (entries as SendMessageEntry[]).filter((e) => e.kind === "send-message").map((e) => `${e.author?.name}: ${(e.message as { content: string }).content}`);

describe("BotGroupPoster (GRP-09, B2B-06)", () => {
  it("a request post appears as the member's post and starts a room turn on the agent lane without the sender", async () => {
    const { h, p, g, poster, lanes, chain } = setup();
    const r = await poster.postFromBot(g, p, { target_id: g, kind: "request", message: "I blocked Oct 24–25. Can someone confirm the train times?", expects: "train times for Oct 24" }, chain);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("will take turns");
    await h.orch.whenIdle(g);
    expect(botPosts(h.groupEntries(g))).toEqual(["Planner: I blocked Oct 24–25. Can someone confirm the train times?"]);
    expect(lanes.Planner).toBeUndefined();
    expect(new Set([...(lanes.Scout ?? []), ...(lanes.Ledger ?? [])])).toEqual(new Set(["agent"]));
    expect(h.bots.summary(g).statusLine).toBe("Planner: I blocked Oct 24–25. Can someone confirm the train times?");
  });

  it("a result post is appended without waking anyone", async () => {
    const { h, p, g, poster, lanes, chain } = setup();
    const r = await poster.postFromBot(g, p, { target_id: g, kind: "result", message: "Calendar updated: Oct 24–25 is blocked for the trip." }, chain);
    expect(r.text).toContain("no one was woken");
    await h.orch.whenIdle(g);
    expect(Object.keys(lanes)).toEqual([]);
    expect(botPosts(h.groupEntries(g))).toHaveLength(1);
  });

  it("refuses (pass), non-members and acknowledgement-only posts; drops images and priority with a note", async () => {
    const { h, p, g, poster, chain } = setup();
    const outsider = h.mk("Outsider");
    expect((await poster.postFromBot(g, p, { target_id: g, kind: "result", message: "(pass)" }, chain)).isError).toBe(true);
    expect((await poster.postFromBot(g, outsider, { target_id: g, kind: "result", message: "Here are the totals: $392." }, chain)).text).toContain("not a member");
    const ack = await poster.postFromBot(g, p, { target_id: g, kind: "result", message: "Thanks, sounds good!" }, chain);
    expect(ack.text).toContain("Not sent");
    const img = await poster.postFromBot(g, p, { target_id: g, kind: "result", message: "The route map is at /workspace/trip/route.pdf.", images: [{ url: "file:///workspace/map.png" }], priority: true }, chain);
    expect(img.text).toContain("Images aren't posted to groups");
    expect(img.text).toContain("Priority doesn't apply to group posts");
    expect(botPosts(h.groupEntries(g))).toEqual(["Planner: The route map is at /workspace/trip/route.pdf."]);
    expect(h.metrics.efficiency().messagesDropped).toBe(1);
  });

  it("doesn't start a second room turn while one is running", async () => {
    const { h, p, s, g, poster, chain } = setup((name) => (name === "Scout" ? "Found a cabin for $142 a night near Hudson." : "(pass)"));
    h.orch.userPost(g, "@Scout find a cabin", "n1");
    expect(h.orch.isActive(g)).toBe(true);
    const r = await poster.postFromBot(g, p, { target_id: g, kind: "question", message: "Should it allow dogs? The user mentioned a dog last week.", expects: "yes or no" }, chain);
    expect(r.text).toContain("already talking");
    await h.orch.whenIdle(g);
    expect(h.brains.get(s)!.inputs.map(promptText).some((t) => t.includes("Should it allow dogs?"))).toBe(true);
  });

  it("logs (not throws) when startRoomTurn rejects after a waking post, instead of an unhandled rejection", async () => {
    const { h, p, g, chain } = setup();
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const boom = new Error("room turn boom");
    const orchestrator = Object.assign(Object.create(Object.getPrototypeOf(h.orch)), h.orch, { isActive: () => false, startRoomTurn: () => Promise.reject(boom) });
    const poster = new BotGroupPoster({ groups: h.groups, orchestrator: orchestrator as unknown as typeof h.orch, bots: h.bots, now: Date.now, metrics: h.metrics });
    const r = await poster.postFromBot(g, p, { target_id: g, kind: "request", message: "Can someone confirm the train times?", expects: "train times" }, chain);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("will take turns");
    await new Promise((res) => setTimeout(res, 0));
    expect(errSpy).toHaveBeenCalledWith("group room turn failed", { groupId: g, error: "room turn boom" });
  });
});

describe("SideExchangeMirror (GRP-14)", () => {
  it("copies outbound messages of a group-rooted chain into the group transcript with sender and recipient", () => {
    const { h, p, s, g } = setup();
    const mirror = new SideExchangeMirror({ bots: h.bots, chains: h.chains, groups: h.groups, now: Date.now });
    const groupChain = h.chains.start("user", g, { groupId: g }).chainId;
    const out: AgentMessageEntry = { kind: "message", id: "t9a1", role: "assistant", content: "Can you hold the cabin?", toAgent: { id: s, name: "Scout", kind: "request", rid: "r_abcdefgh" }, chainId: groupChain, createdAt: 5 };
    mirror.onAgentMessage(groupChain, out, p);
    const copies = h.groupEntries(g).filter((e): e is AgentMessageEntry => e.kind === "message" && "toAgent" in e && !!e.toAgent);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ content: "Can you hold the cabin?", fromAgent: { id: p, name: "Planner", kind: "request" }, toAgent: { id: s }, chainId: groupChain });
    expect(copies[0]!.id).not.toBe("t9a1");
  });

  it("ignores inbound copies, chains not rooted in a group, and deleted groups", () => {
    const { h, p, s, g, chain } = setup();
    const mirror = new SideExchangeMirror({ bots: h.bots, chains: h.chains, groups: h.groups, now: Date.now });
    const before = h.groupEntries(g).length;
    mirror.onAgentMessage(chain, { kind: "message", id: "t1a1", role: "assistant", content: "x", toAgent: { id: s, name: "Scout", kind: "request" }, chainId: chain, createdAt: 1 }, p);
    const gc = h.chains.start("user", g, { groupId: g }).chainId;
    mirror.onAgentMessage(gc, { kind: "message", id: "t2a1", role: "user", content: "y", fromAgent: { id: p, name: "Planner", kind: "result" }, chainId: gc, createdAt: 1 }, s);
    expect(h.groupEntries(g)).toHaveLength(before);
  });
});
