import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalCardView, ProvidersView, TranscriptEntry } from "@synapse/shared";
import { sealTo } from "../../../secrets/crypto";
import { createHostApp, type HostApp } from "../../../app";
import { credentialsReady } from "../../../auth/auth-env";
import { tmpConfig } from "../../helpers";
import { finish, startFakeChatServer, textChunks, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";

/**
 * Spec §13 end to end, the core "only OpenAI" journey: a host with NO Anthropic key saved, one OpenAI key, a Bot on an
 * OpenAI model. Its turn streams from a (fake) Chat Completions server, makes one tool call that the real gate cards,
 * runs it once the user allows it, and replies — metered into usage like any turn.
 */
let app: HostApp | null = null;
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await app?.close();
  app = null;
  for (const s of servers.splice(0)) await s.close();
});
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

const CMD = "rm -f scratch-e2e.txt; echo e2e-ran";
const OPENAI_KEY = "sk-e2e-openai-0123456789abcdef";
function model(req: FakeRequest): FakeReply {
  if (req.path === "/models") return { status: 200, body: JSON.stringify({ object: "list", data: [{ id: "gpt-e2e" }] }) };
  if (req.body.model === "gpt-6-luna") return { sse: [...textChunks("OK"), finish("stop"), usageChunk(9, 1)] }; // the key test's tiny call
  const msgs = req.body.messages as { role: string; content: unknown }[];
  const last = msgs.at(-1)!;
  if (last.role === "user" && String(last.content).includes("tidy up")) {
    return { sse: [...textChunks("Tidying."), ...toolChunks([{ id: "call_rm", name: "Shell", args: { command: CMD } }]), finish("tool_calls"), usageChunk(1200, 40, { prompt_tokens_details: { cached_tokens: 1000 } })], chunkBytes: 37 };
  }
  if (last.role === "tool" && (last as { tool_call_id?: string }).tool_call_id === "call_rm") {
    return { sse: [...toolChunks([{ id: "call_send", name: "SendMessage", args: { content: "Removed the scratch file." } }]), finish("tool_calls"), usageChunk(1300, 20)], chunkBytes: 23 };
  }
  return { sse: [finish("stop"), usageChunk(1350, 1)] };
}

describe("only OpenAI: a Bot turn with no Anthropic key saved", () => {
  it("streams a reply with one gated tool call through the real gate, and meters the turn", async () => {
    const server = await startFakeChatServer(model);
    servers.push(server);
    app = await createHostApp(tmpConfig(), { providerUpstream: (p) => (p === "openai" ? server.url : undefined) });
    expect(credentialsReady()).toBe(false); // no Anthropic key saved
    const { port } = await app.listen();
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
      return j.result as T;
    };
    const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
    const card = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [e.message.approval as ApprovalCardView] : [])).at(-1);
    const texts = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));

    const { id } = await api<{ id: string }>("createAgent", { name: "Olive", isKickstartRequested: false });
    // Settings → Account: consent first, then the key (sealed to the box, as the Mac's main process sends it).
    const before = await api<ProvidersView>("getProviders", {});
    const openai = before.providers.find((p) => p.id === "openai")!;
    expect(openai).toMatchObject({ key: null, consented: false, local: false });
    await expect(api("setProviderKey", { provider: "openai", sealed: await sealTo(before.boxPublicKey, OPENAI_KEY) })).rejects.toThrow(/NO_CONSENT/);
    await expect(api("updateAgent", { id, model: "openai:gpt-e2e" })).rejects.toThrow(/BAD_MODEL/); // not consented, no key
    await api("consentProvider", { provider: "openai", textVersion: openai.consentVersion });
    await expect(api("updateAgent", { id, model: "openai:gpt-e2e" })).rejects.toThrow(/BAD_MODEL/); // consented, still no key
    const saved = await api<ProvidersView>("setProviderKey", { provider: "openai", sealed: await sealTo(before.boxPublicKey, OPENAI_KEY) });
    expect(saved.providers.find((p) => p.id === "openai")).toMatchObject({ consented: true, key: { masked: "sk-…cdef" } });
    expect(JSON.stringify(saved)).not.toContain(OPENAI_KEY);
    expect(await api("testProviderKey", { provider: "openai" })).toMatchObject({ ok: true, kind: "ok" });
    await expect(api("updateAgent", { id, model: "gemini:gemini-3.5-flash" })).rejects.toThrow(/BAD_MODEL/); // no Gemini consent or key
    await api("updateAgent", { id, model: "openai:gpt-e2e" });
    expect(app.services.bots.summary(id).profile.model).toBe("openai:gpt-e2e");

    const partials: string[] = [];
    app.hub.subscribe((e) => {
      const p = e.payload as { botId?: string; op?: string; partialText?: string | null };
      if (e.channel === "transcript" && p.op === "typing" && p.botId === id && p.partialText) partials.push(p.partialText);
    });
    await api("sendPrompt", { id, text: "please tidy up the scratch file", clientNonce: "n1" });
    await until(async () => (await card(id))?.status === "pending");
    const c = (await card(id))!;
    // No Anthropic key and the OpenAI reviewer not yet qualified: ask-only (spec §7a), the card says why.
    expect(c).toMatchObject({ title: "Your Bot would like to run a command", command: CMD, reason: "Asked because automatic review isn't available for this model." });
    expect(server.requests.filter((r) => r.body.model === "gpt-e2e")).toHaveLength(1); // nothing more was asked while the card waits
    await api("resolveAutoReviewApproval", { id, approvalId: c.approvalId, choice: "once" });
    await until(async () => (await texts(id)).includes("Removed the scratch file."));
    await until(() => app!.services.runner.isIdle(id));

    // the reply streamed to the typing indicator as the model wrote SendMessage's arguments (CT-01's equivalent)
    expect(partials.length).toBeGreaterThan(1);
    expect(partials.at(-1)).toBe("Removed the scratch file.");
    expect(partials[0]!.length).toBeLessThan("Removed the scratch file.".length);
    // the tool ran after the approval, and its output went back to the model
    const toolMsg = (server.requests.filter((r) => r.body.model === "gpt-e2e")[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("e2e-ran");
    expect((await card(id))!.status).toBe("approved");
    // the provider saw the OpenAI key and the Bot's own model; no Anthropic call was ever attempted
    const turnCalls = server.requests.filter((r) => r.body.model === "gpt-e2e");
    expect(turnCalls).toHaveLength(3);
    for (const r of server.requests) expect(r.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`); // the proxy's swap
    for (const r of turnCalls) expect(r.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, prompt_cache_key: id });
    expect(app.services.bots.sessionId(id)).toMatch(/^prov-/);
    // metered like any turn: usage.db has the turn on the provider model, cached tokens split out
    const view = await api<{ rows: { botId: string; turns: number; tokens: number; costUsd: number }[] }>("getUsage", {});
    const row = view.rows.find((r) => r.botId === id)!;
    // 3 model calls: input 200 + 1300 + 1350, cached 1000, output 40 + 20 + 1
    expect(row).toMatchObject({ turns: 1, tokens: 3911 });
    expect(row.costUsd).toBeGreaterThan(0);
  }, 30_000);
});
