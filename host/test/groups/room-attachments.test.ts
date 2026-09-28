import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UserAttachmentEntry, UserMessageEntry } from "@synapse/shared";
import type { FakeScript } from "../../brain/fake-brain";
import type { ModelMessage } from "../../brain/types";
import { routeSendPrompt } from "../../groups/orchestrator";
import type { AttachmentInput } from "../../runner/turn-runner";
import { groupHarness, promptText, say, until } from "./harness";

// Bug 126: a group call, or a 1:1 call with an added Bot (a call room), carries a shared screen: the still
// sent with a spoken post reaches the Bots on the call, like it does on a 1:1 call.

const isMemberTurn = (p: string) => p.includes("[Group chat:");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function setup() {
  const h = groupHarness(() => ((input) => (isMemberTurn(promptText(input)) ? [say("I can see it.")] : [say("dm")])) as FakeScript);
  const still = path.join(h.cfg.dataRoot, "still.png");
  fs.writeFileSync(still, PNG);
  const ref: AttachmentInput = { attachmentId: "abc.png", name: "Screen 10.02.png", size: PNG.length, mime: "image/png", storePath: still, boxPath: "/workspace/.host-out/uploads/x/Screen 10.02.png" };
  const resolved: { chatId: string; ids: string[] }[] = [];
  const resolve = (chatId: string, ids: string[]) => { resolved.push({ chatId, ids }); return ids.map(() => ref); };
  const images = (id: string) => (h.brains.get(id)?.inputs ?? []).filter((i) => isMemberTurn(promptText(i))).flatMap((i) => i.prompt.filter((m): m is Extract<ModelMessage, { image: unknown }> => "image" in m));
  const memberTexts = (id: string) => (h.brains.get(id)?.inputs ?? []).map(promptText).filter(isMemberTurn);
  return { h, resolve, resolved, images, memberTexts };
}

describe("a shared screen on a group call or a call room (bug 126)", () => {
  it("a group call post with a still: the post records it and every Bot that answers sees the image", async () => {
    const { h, resolve, resolved, images, memberTexts } = setup();
    const a = h.mk("Nova"), b = h.mk("Ledger");
    const { id: g } = h.groups.create([a, b], { origin: "user" });
    const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls, resolve);
    await send({ id: g, text: "Nova and Ledger, look at my screen", clientNonce: "n1", attachmentIds: ["abc.png"], voice: { durationMs: 900, call: true } });
    await h.orch.whenIdle(g);
    expect(resolved).toEqual([{ chatId: g, ids: ["abc.png"] }]);
    const user = h.groupEntries(g).find((e): e is UserMessageEntry => e.kind === "message" && e.role === "user")!;
    expect(user.attachmentEntryIds).toHaveLength(1);
    const att = h.groupEntries(g).find((e): e is UserAttachmentEntry => e.kind === "user-attachment")!;
    expect(att).toMatchObject({ id: user.attachmentEntryIds![0], batchId: user.id, name: "Screen 10.02.png", mime: "image/png" });
    for (const m of [a, b]) {
      expect(images(m)).toEqual([{ image: { mediaType: "image/png", dataBase64: PNG.toString("base64") } }]);
      expect(memberTexts(m)[0]).toContain("<attached_files>");
      expect(memberTexts(m)[0]).toContain("Screen 10.02.png");
    }
  });

  it("a 1:1 call with an added Bot: the addressed Bot sees the still", async () => {
    const { h, resolve, images } = setup();
    const nova = h.mk("Nova"), scout = h.mk("Scout");
    const v = h.calls.start(nova);
    h.calls.add(v.callId, scout);
    const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls, resolve);
    await send({ id: nova, text: "Scout, look at this", clientNonce: "n1", attachmentIds: ["abc.png"], voice: { durationMs: 900, call: true } });
    await h.orch.whenIdle(nova);
    expect(images(scout)).toHaveLength(1);
    expect(images(nova)).toHaveLength(0); // Nova wasn't addressed, so it didn't run
  });

  it("the image rides only the post that carried it: a later post without one sends none", async () => {
    const { h, resolve, images } = setup();
    const a = h.mk("Nova");
    const { id: g } = h.groups.create([a, h.mk("Ledger")], { origin: "user" });
    const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls, resolve);
    await send({ id: g, text: "Nova, look", clientNonce: "n1", attachmentIds: ["abc.png"] });
    await h.orch.whenIdle(g);
    await send({ id: g, text: "Nova, thanks", clientNonce: "n2" });
    await h.orch.whenIdle(g);
    await until(() => (h.brains.get(a)?.inputs.length ?? 0) >= 2);
    expect(images(a)).toHaveLength(1);
  });

  it("a still alone (no words) is a valid post", async () => {
    const { h, resolve } = setup();
    const { id: g } = h.groups.create([h.mk("Nova"), h.mk("Ledger")], { origin: "user" });
    const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls, resolve);
    expect(() => send({ id: g, text: "", clientNonce: "n1", attachmentIds: ["abc.png"] })).not.toThrow();
    await h.orch.whenIdle(g);
  });

  it("never drops a still silently: without a resolver, a room post with attachments is refused", () => {
    const { h } = setup();
    const { id: g } = h.groups.create([h.mk("Nova"), h.mk("Ledger")], { origin: "user" });
    const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls);
    expect(() => send({ id: g, text: "look", clientNonce: "n1", attachmentIds: ["abc.png"] })).toThrow();
  });
});
