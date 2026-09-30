import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../../app";
import { sealTo } from "../../../secrets/crypto";
import { tmpConfig } from "../../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";

/** Spec P2: a provider Bot uses a local command MCP server, and the call goes through the same approval gate. */
const ECHO = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp.mjs");
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await app?.close(); app = null; for (const c of closers.splice(0)) await c(); });
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

let n = 0;
function model(req: FakeRequest): FakeReply {
  if (req.path === "/models") return { status: 200, body: "{\"data\":[]}" };
  if (req.body.model === "gpt-6-luna") return reply({ text: "NONE" }); // helpers
  const msgs = req.body.messages as { role: string; content: unknown }[];
  const last = msgs.at(-1)!;
  if (last.role === "tool" && String(last.content).includes("echo: from the bot")) return { sse: [...toolChunks([{ id: `s${++n}`, name: "SendMessage", args: { content: "The server said it back." } }]), finish("tool_calls"), usageChunk(900, 10)] };
  if (last.role === "tool") return { sse: [finish("stop"), usageChunk(10, 1)] };
  return { sse: [...toolChunks([{ id: `t${++n}`, name: "mcp__echo__whoami", args: {} }, { id: `u${++n}`, name: "mcp__echo__echo", args: { text: "from the bot" } }]), finish("tool_calls"), usageChunk(900, 10)] };
}

describe("MCP servers for provider Bots", () => {
  it("offers the server's tools, gates the call and returns the result", async () => {
    const up = await startFakeChatServer(model);
    closers.push(() => up.close());
    app = await createHostApp(tmpConfig(), { providerUpstream: () => up.url });
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const v = (await h.getProviders!({})) as ProvidersView;
    await h.consentProvider!({ provider: "openai", textVersion: v.providers[0]!.consentVersion });
    await h.setProviderKey!({ provider: "openai", sealed: await sealTo(v.boxPublicKey, "sk-mcp-0123456789abcdef") });
    await h.addMcpServer!({ name: "Echo", command: process.execPath, args: [ECHO] });
    await h.setMcpToolEnabled!({ serverId: "echo", tool: "whoami", enabled: false });
    const { id } = (await h.createAgent!({ name: "Ada", isKickstartRequested: false })) as { id: string };
    await h.updateAgent!({ id, model: "openai:gpt-6.1-sol" });
    const tail = () => app!.services.bots.tail(id, 200);
    const texts = () => tail().flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
    await h.sendPrompt!({ id, text: "Use the echo server.", clientNonce: "n1" });
    // Ask-only on OpenAI (no qualified reviewer yet): a side-effecting MCP call cards, like it does for a Claude Bot.
    const cards = () => tail().flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [(e.message as unknown as { approval: { approvalId: string; status: string } }).approval] : []));
    await until(() => cards().some((c) => c.status === "pending") || texts().length > 0);
    for (const c of cards().filter((x) => x.status === "pending")) app.services.gate.resolve(id, c.approvalId, "once");
    await until(() => texts().includes("The server said it back."));
    const first = up.requests.find((r) => Array.isArray(r.body.tools))!;
    const tools = first.body.tools as { function: { name: string; description: string } }[];
    // 0.1.8: a connector's tools wait behind ToolSearch (names listed), as on the Claude Code path; a call still works.
    const listed = tools.find((t) => t.function.name === "ToolSearch")!.function.description;
    expect(listed).toContain("mcp__echo__echo");
    expect(listed).not.toContain("mcp__echo__whoami"); // turned off by the user
    expect(tools.map((t) => t.function.name)).not.toContain("mcp__echo__whoami");
    const toolMsgs = up.requests.flatMap((r) => (r.body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "tool").map((m) => String(m.content)));
    expect(toolMsgs.some((t) => /No such tool available: mcp__echo__whoami/.test(t))).toBe(true);
    expect(toolMsgs.some((t) => t.includes("echo: from the bot"))).toBe(true);
    expect(cards().map((c) => c.status)).toEqual(["approved"]);
    // 4.4 (0.1.6): the provider key got its connector-health row from the Bot's real calls; removing the key removes it.
    // 0.1.7: one row per saved key (the first key's id is k1).
    type HealthList = { connectors: { id: string; state: string }[] };
    expect(((await h.getConnectorHealth!({})) as HealthList).connectors.find((c) => c.id === "provider:openai:k1")?.state).toBe("ok");
    await h.clearProviderKey!({ provider: "openai" });
    expect(((await h.getConnectorHealth!({})) as HealthList).connectors.some((c) => c.id.startsWith("provider:openai"))).toBe(false);
  }, 30_000);
});
