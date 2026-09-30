import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../../app";
import { sealTo } from "../../../secrets/crypto";
import { tmpConfig } from "../../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";

/** Spec P2: a provider Bot's Task subagent runs on ProviderBrain, not Claude, and its report wakes the parent. */
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await app?.close(); app = null; for (const c of closers.splice(0)) await c(); });
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

let n = 0;
function model(req: FakeRequest): FakeReply {
  if (req.path === "/models") return { status: 200, body: "{\"data\":[]}" };
  const msgs = req.body.messages as { role: string; content: unknown }[];
  const system = String(msgs[0]!.content);
  const body = JSON.stringify(msgs);
  if (system.includes("generalPurpose subagent")) return reply({ text: "Child report: the answer is 42." }); // the child
  if (req.body.model === "gpt-6-luna") return reply({ text: "NONE" }); // helpers
  const last = msgs.at(-1)!;
  if (last.role === "tool") return { sse: [finish("stop"), usageChunk(10, 1)] };
  if (body.includes("Started generalPurpose subagent") && !body.includes("Child report")) return { sse: [...toolChunks([{ id: `o${++n}`, name: "SendMessage", args: { content: "On it." } }]), finish("tool_calls"), usageChunk(900, 5)] };
  if (body.includes("Child report")) return { sse: [...toolChunks([{ id: `s${++n}`, name: "SendMessage", args: { content: "The subagent says 42." } }]), finish("tool_calls"), usageChunk(900, 10)] };
  return { sse: [...toolChunks([{ id: `t${++n}`, name: "Task", args: { description: "Find the answer", prompt: "Work out the answer.", subagent_type: "generalPurpose" } }]), finish("tool_calls"), usageChunk(900, 10)] };
}

describe("Task subagents on ProviderBrain", () => {
  it("runs the child on the parent's provider, keeps its session under the parent, and wakes the parent with its report", async () => {
    const up = await startFakeChatServer(model);
    closers.push(() => up.close());
    const cfg = tmpConfig();
    app = await createHostApp(cfg, { providerUpstream: () => up.url });
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const v = (await h.getProviders!({})) as ProvidersView;
    await h.consentProvider!({ provider: "openai", textVersion: v.providers[0]!.consentVersion });
    await h.setProviderKey!({ provider: "openai", sealed: await sealTo(v.boxPublicKey, "sk-subagent-0123456789abcdef") });
    const { id } = (await h.createAgent!({ name: "Ada", isKickstartRequested: false })) as { id: string };
    await h.updateAgent!({ id, model: "openai:gpt-6.1-sol" });
    const texts = () => app!.services.bots.tail(id, 200).flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
    await h.sendPrompt!({ id, text: "Please delegate: find the answer.", clientNonce: "n1" });
    // No qualified reviewer on OpenAI yet: ask-only, so the Task cards; the user allows it once.
    const card = () => app!.services.bots.tail(id, 200).flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [(e.message as unknown as { approval: { approvalId: string; status: string } }).approval] : [])).at(-1);
    await until(() => card()?.status === "pending");
    app.services.gate.resolve(id, card()!.approvalId, "once");
    await until(() => texts().includes("The subagent says 42."));
    const child = up.requests.find((r) => String((r.body.messages as { content: unknown }[])[0]!.content).includes("generalPurpose subagent"))!;
    expect(child.body.model).toBe("gpt-6.1-sol"); // the parent's own provider model, not Claude
    expect((child.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(expect.arrayContaining(["Shell", "Read", "Write", "WebFetch"]));
    expect((child.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).not.toContain("SendMessage");
    const dir = path.join(cfg.hostPrivate, "provider-sessions", id);
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(2); // the parent's session and the child's
    const view = (await h.getUsage!({})) as { byPurpose?: { group: string; calls: number }[] };
    // The child's model calls are metered for the parent Bot as "subagent" (a helper group), not lost as a non-runner turn.
    expect(view.byPurpose?.find((g) => g.group === "helpers")?.calls ?? 0).toBeGreaterThanOrEqual(1);
    await h.deleteAgent!({ id });
    expect(fs.existsSync(dir)).toBe(false);
  }, 30_000);
});
