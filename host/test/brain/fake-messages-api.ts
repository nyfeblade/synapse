import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted stand-in for the Anthropic Messages API, for driving the real Claude Code CLI with no
 * model and no key (ANTHROPIC_BASE_URL points here). Every POST /v1/messages that carries tools is a
 * model call of the conversation: it is counted, and answered with the next scripted reply (the last
 * one repeats). Anything else (token counting, side helpers) gets a minimal text reply, uncounted.
 */
export type ScriptedBlock = { text: string } | { tool: string; input: Record<string, unknown> };
export interface FakeMessagesApi { url: string; calls: { tools: string[]; lastUser: unknown }[]; requests: { tools: number; lastUser: string }[]; /** Raw JSON body of every conversational call (the wire-prefix probe reads them). */ bodies: string[]; close(): Promise<void> }
/** Options: the prompt size every conversational reply reports (drives the CLI's auto-compact check). */
export interface FakeApiOptions { contextTokens?: number }

const sse = (res: http.ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function stream(res: http.ServerResponse, model: string, blocks: ScriptedBlock[], n: number, contextTokens = 0): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: contextTokens, cache_creation_input_tokens: 0 };
  sse(res, "message_start", { type: "message_start", message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  blocks.forEach((b, i) => {
    if ("text" in b) {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_fake_${n}_${i}`, name: b.tool, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: i });
  });
  const stop = blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn";
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

export async function startFakeMessagesApi(script: ScriptedBlock[][], o: FakeApiOptions = {}): Promise<FakeMessagesApi> {
  const calls: FakeMessagesApi["calls"] = [];
  const requests: FakeMessagesApi["requests"] = [];
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let j: { model?: string; tools?: { name: string }[]; messages?: { content: unknown }[]; stream?: boolean } = {};
      try { j = JSON.parse(body) as typeof j; } catch { /* not JSON */ }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const conversational = (j.tools ?? []).length > 0;
      requests.push({ tools: (j.tools ?? []).length, lastUser: JSON.stringify(j.messages?.at(-1)?.content ?? "").slice(0, 300) });
      const blocks = conversational ? (script[Math.min(calls.length, script.length - 1)] ?? [{ text: "ok" }]) : [{ text: "ok" }];
      if (conversational) bodies.push(body);
      if (conversational) calls.push({ tools: (j.tools ?? []).map((t) => t.name), lastUser: j.messages?.at(-1)?.content });
      if (j.stream !== true) { // a plain (non-streaming) request, e.g. the CLI validating a model for setModel
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }));
        return;
      }
      stream(res, j.model ?? "claude-haiku-4-5-20251001", blocks, calls.length, conversational ? o.contextTokens : 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, requests, bodies, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
