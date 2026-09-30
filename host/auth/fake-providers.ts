import http from "node:http";
import type { AddressInfo } from "node:net";
import { isProviderId, type ProviderId } from "@synapse/shared";

/**
 * FUZZ / the fake brain (0.1.7): every model provider answered in-process, offline, so a local preview can add keys,
 * pass Test key and run a Bot turn on any provider model with any made-up key — and nothing ever reaches a real
 * provider. The provider proxy's upstream for every provider points here (app.ts); the proxy still adds the key, asks
 * the budget and meters as it does for real. Paths are `/<provider>/v1/…` (the proxy's `api/` and `native/` rewrites
 * land on `/<provider>/api/…` and `/<provider>/v1/models/…:generateContent`).
 *
 * - `models`: a small list (OpenRouter's with prices, so its live list and prices fill in).
 * - Ollama `api/tags` and LM Studio `models`: a made-up list of models "on this Mac".
 * - `chat/completions`: a streamed reply. A Bot turn (SendMessage offered) answers with one SendMessage call, then stops
 *   once it sees the tool result; any other call (helpers, the key test) gets a short text.
 * - OpenAI `responses` and Gemini `generateContent` (web search): a short answer with no sources.
 */
type Provider = Exclude<ProviderId, "anthropic">;
export const FAKE_LOCAL_MODELS: Record<"ollama" | "lmstudio", string[]> = { ollama: ["qwen3:4b", "llama3.2:3b"], lmstudio: ["qwen2.5-7b-instruct"] };

const sse = (res: http.ServerResponse, events: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`);
};
const json = (res: http.ServerResponse, body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const usage = (p: number, c: number) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

function chat(provider: Provider, body: Record<string, unknown>, res: http.ServerResponse): void {
  const msgs = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  const last = msgs.at(-1);
  const tools = Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]).map((t) => t.function?.name) : [];
  const model = String(body.model ?? "a model");
  const text = `Hi — this is a stand-in reply from ${model} (${provider}, offline preview).`;
  if (body.stream === false) { json(res, { id: "fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }); return; }
  if (tools.includes("SendMessage") && last?.role !== "tool") {
    const args = JSON.stringify({ content: text });
    sse(res, [{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `fake_${Date.now()}`, type: "function", function: { name: "SendMessage", arguments: args } }] } }] }, finish("tool_calls"), usage(400, 30)]);
    return;
  }
  sse(res, [{ choices: [{ index: 0, delta: { role: "assistant", content: last?.role === "tool" ? "" : "OK" } }] }, finish("stop"), usage(60, 2)]);
}

function models(provider: Provider, res: http.ServerResponse): void {
  if (provider === "lmstudio") { json(res, { data: FAKE_LOCAL_MODELS.lmstudio.map((id) => ({ id, object: "model" })) }); return; }
  if (provider === "openrouter") {
    json(res, { data: [
      { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", context_length: 128_000, pricing: { prompt: "0.00000015", completion: "0.0000006" }, supported_parameters: ["tools"] },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Meta: Llama 3.3 70B", context_length: 131_072, pricing: { prompt: "0.00000012", completion: "0.0000003" }, supported_parameters: ["tools"] },
    ] });
    return;
  }
  json(res, { object: "list", data: [{ id: `${provider}-fake-model`, object: "model" }] });
}

export async function startFakeProviders(): Promise<{ upstream(p: Provider): string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      const m = /^\/([a-z]+)\/(.*)$/.exec((req.url ?? "/").split("?")[0]!);
      const p = m && isProviderId(m[1]) && m[1] !== "anthropic" ? (m[1] as Provider) : null;
      const rest = m?.[2] ?? "";
      if (!p) { json(res, { error: { message: "not found" } }, 404); return; }
      let body: Record<string, unknown> = {};
      try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { /* keep {} */ }
      if (req.method === "GET" && rest === "api/tags") { json(res, { models: FAKE_LOCAL_MODELS.ollama.map((name) => ({ name, model: name, size: 1 })) }); return; }
      if (req.method === "GET" && /(^|\/)models$/.test(rest)) { models(p, res); return; }
      if (req.method === "POST" && /chat\/completions$/.test(rest)) { chat(p, body, res); return; }
      if (req.method === "POST" && /responses$/.test(rest)) { json(res, { id: "fake", output: [{ type: "message", content: [{ type: "output_text", text: "No live web in the offline preview.", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 8 } }); return; }
      if (req.method === "POST" && /:generateContent$/.test(rest)) { json(res, { candidates: [{ content: { parts: [{ text: "No live web in the offline preview." }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 } }); return; }
      json(res, { error: { message: "not found" } }, 404);
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    upstream: (p) => `${url}/${p}/v1`,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
