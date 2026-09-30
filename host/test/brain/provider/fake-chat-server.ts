import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake OpenAI Chat Completions server for provider-brain tests: every POST …/chat/completions is recorded and
 * answered by the script (streamed SSE, an error status, or a connection cut partway).
 */
export interface FakeRequest { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
export type FakeReply =
  | { sse: unknown[]; /** split every SSE byte stream into pieces this size (fuzzing chunk boundaries) */ chunkBytes?: number; /** drop the connection after this many events */ cutAfter?: number; delayMs?: number }
  | { status: number; body: string; headers?: Record<string, string> }
  | { hang: true };

export async function startFakeChatServer(script: (req: FakeRequest, n: number) => FakeReply) {
  const requests: FakeRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
      const r: FakeRequest = { path: req.url ?? "", headers: req.headers, body };
      requests.push(r);
      const reply = script(r, requests.length - 1);
      if ("hang" in reply) return; // never answers
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = reply.sse.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
      const cut = reply.cutAfter;
      const all = (cut === undefined ? [...events, "data: [DONE]\n\n"] : events.slice(0, cut)).join("");
      const size = reply.chunkBytes ?? all.length;
      const buf = Buffer.from(all);
      const pieces: Buffer[] = [];
      for (let i = 0; i < buf.length; i += Math.max(1, size)) pieces.push(buf.subarray(i, i + size));
      const send = async () => {
        for (const p of pieces) {
          res.write(p);
          if (reply.delayMs) await new Promise((x) => setTimeout(x, reply.delayMs));
        }
        if (cut !== undefined) res.destroy();
        else res.end();
      };
      void send();
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---- chunk builders (the OpenAI streaming shape) ----
export const textChunks = (text: string, pieces = 3): unknown[] => {
  const n = Math.max(1, Math.ceil(text.length / pieces));
  const out: unknown[] = [{ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }];
  for (let i = 0; i < text.length; i += n) out.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + n) } }] });
  return out;
};
export const toolChunks = (calls: { id: string; name: string; args: Record<string, unknown>; extra?: Record<string, unknown> }[]): unknown[] => {
  const out: unknown[] = [];
  calls.forEach((c, index) => {
    const a = JSON.stringify(c.args);
    const half = Math.floor(a.length / 2);
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: a.slice(0, half) }, ...(c.extra ?? {}) }] } }] });
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: a.slice(half) } }] } }] });
  });
  return out;
};
export const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
export const usageChunk = (prompt: number, completion: number, extra: Record<string, unknown> = {}) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra } });

/** A whole reply: optional text, optional tool calls, then finish and usage. */
export function reply(o: { text?: string; calls?: Parameters<typeof toolChunks>[0]; usage?: [number, number]; chunkBytes?: number }): FakeReply {
  const sse = [...(o.text ? textChunks(o.text) : []), ...(o.calls ? toolChunks(o.calls) : []), finish(o.calls?.length ? "tool_calls" : "stop"), usageChunk(...(o.usage ?? [100, 10]))];
  return { sse, ...(o.chunkBytes ? { chunkBytes: o.chunkBytes } : {}) };
}
