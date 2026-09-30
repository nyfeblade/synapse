import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../../app";
import { sealTo } from "../../../secrets/crypto";
import { tmpConfig } from "../../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";

/**
 * No feature needs Claude: a provider Bot's computer helper runs on the Bot's own model (ProviderBrain), with no
 * Anthropic key saved, through the same gate and cards, and is metered for the parent. A model that can't read images
 * gets text reads of the screen instead of screenshots.
 */
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await app?.close(); app = null; for (const c of closers.splice(0)) await c(); });
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

type Msg = { role: string; content: unknown; tool_calls?: unknown[] };
const isChild = (r: FakeRequest) => String((r.body.messages as Msg[])[0]!.content).includes("computerUse subagent");
let n = 0;
function model() {
  return (req: FakeRequest): FakeReply => {
    if (req.path === "/models") return { status: 200, body: "{\"data\":[]}" };
    const msgs = req.body.messages as Msg[];
    const body = JSON.stringify(msgs);
    if (isChild(req)) {
      const acted = msgs.filter((m) => m.role === "assistant").length;
      if (acted === 0) return { sse: [...toolChunks([{ id: `k${++n}`, name: "Computer", args: { action: "click", x: 600, y: 300, description: "Open the report" } }]), finish("tool_calls"), usageChunk(700, 10)] };
      return reply({ text: "Child report: opened the report." });
    }
    if (!Array.isArray(req.body.tools)) return reply({ text: "NONE" }); // helpers (no tools; DeepSeek's run on the Bot's own model)
    const last = msgs.at(-1)!;
    if (last.role === "tool") return { sse: [finish("stop"), usageChunk(10, 1)] };
    if (body.includes("Child report")) return { sse: [...toolChunks([{ id: `s${++n}`, name: "SendMessage", args: { content: "Opened it." } }]), finish("tool_calls"), usageChunk(900, 10)] };
    if (body.includes("Started computerUse subagent")) return { sse: [...toolChunks([{ id: `o${++n}`, name: "SendMessage", args: { content: "On it." } }]), finish("tool_calls"), usageChunk(900, 5)] };
    return { sse: [...toolChunks([{ id: `t${++n}`, name: "Task", args: { description: "Open the report", prompt: "Open the report on the screen.", subagent_type: "computerUse" } }]), finish("tool_calls"), usageChunk(900, 10)] };
  };
}

async function runOn(provider: "openai" | "deepseek", ref: string) {
  const up = await startFakeChatServer(model());
  closers.push(() => up.close());
  app = await createHostApp(tmpConfig(), { providerUpstream: () => up.url });
  const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
  const v = (await h.getProviders!({})) as ProvidersView;
  const row = v.providers.find((p) => p.id === provider)!;
  await h.consentProvider!({ provider, textVersion: row.consentVersion });
  await h.setProviderKey!({ provider, sealed: await sealTo(v.boxPublicKey, "sk-computer-0123456789abcdef") });
  const { id } = (await h.createAgent!({ name: "Ada", isKickstartRequested: false })) as { id: string };
  await h.updateAgent!({ id, model: ref });
  const tail = () => app!.services.bots.tail(id, 300) as TranscriptEntry[];
  const texts = () => tail().flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  const cards = () => tail().flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [(e.message as unknown as { approval: { approvalId: string; status: string; surface: string; summary: string } }).approval] : []));
  await h.sendPrompt!({ id, text: "Please open the report on your screen.", clientNonce: "n1" });
  // No qualified reviewer on this provider: ask-only, so the Task and then the child's click card; allow each once.
  const approved = new Set<string>();
  await until(() => {
    for (const c of cards()) if (c.status === "pending" && !approved.has(c.approvalId)) { approved.add(c.approvalId); app!.services.gate.resolve(id, c.approvalId, "once"); }
    return texts().includes("Opened it.");
  }, 20_000);
  return { up, id, h, cards, childReqs: up.requests.filter(isChild) };
}

describe("computer helpers on ProviderBrain (no Anthropic key)", () => {
  it("an OpenAI Bot's computerUse child runs on its own model with the screen tools, a card for the click, screenshots at OpenAI's size", async () => {
    const { childReqs, cards, h } = await runOn("openai", "openai:gpt-6.1-sol");
    expect(childReqs.length).toBeGreaterThanOrEqual(2);
    const first = childReqs[0]!;
    expect(first.body.model).toBe("gpt-6.1-sol");
    const tools = (first.body.tools as { function: { name: string } }[]).map((t) => t.function.name).sort();
    expect(tools).toEqual(["AwaitShell", "Computer", "Read", "Shell"]); // TOOL-02: Read is the only built-in
    const system = String((first.body.messages as Msg[])[0]!.content);
    expect(system).toContain("(1229×768, Linux desktop"); // OpenAI shrinks a 1280×800 image to 1229×768: the child sees that
    // The click was reviewed exactly as on the Claude path: one card, approved, for the Computer tool.
    expect(cards().filter((c) => c.surface === "computer").map((c) => [c.status, c.summary])).toEqual([["approved", "Click at (600, 300) on Bots' computer to open the report"]]);
    // Its screenshot reached the model as a follow-up user message after the tool result (ProviderBrain's tool-image quirk).
    const second = childReqs[1]!.body.messages as Msg[];
    const toolAt = second.findIndex((m) => m.role === "tool");
    expect(toolAt).toBeGreaterThan(0);
    expect(JSON.stringify(second.slice(toolAt + 1))).toContain("image_url");
    // Metered for the parent as "subagent".
    const usage = (await h.getUsage!({})) as { byPurpose?: { group: string; calls: number }[] };
    expect(usage.byPurpose?.find((g) => g.group === "helpers")?.calls ?? 0).toBeGreaterThanOrEqual(2);
  }, 40_000);

  it("a DeepSeek Bot (no image input) gets ReadScreen and text reads, never an image", async () => {
    const { childReqs } = await runOn("deepseek", "deepseek:deepseek-flash");
    const first = childReqs[0]!;
    expect(first.body.model).toBe("deepseek-flash");
    expect((first.body.tools as { function: { name: string } }[]).map((t) => t.function.name).sort()).toEqual(["AwaitShell", "Computer", "Read", "ReadScreen", "Shell"]);
    expect(String((first.body.messages as Msg[])[0]!.content)).toContain("Start with ReadScreen");
    for (const r of childReqs) expect(JSON.stringify(r.body.messages)).not.toContain("image_url");
    const toolMsg = (childReqs[1]!.body.messages as Msg[]).find((m) => m.role === "tool")!;
    expect(JSON.stringify(toolMsg.content)).toContain("Done on the box desktop. Pointer at");
    expect(JSON.stringify(toolMsg.content)).toContain("text on screen (OCR)");
  }, 40_000);
});
