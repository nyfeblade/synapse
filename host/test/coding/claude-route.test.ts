import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setAuthProxy } from "../../auth/auth-env";
import { AuthProxy } from "../../auth/proxy";
import { providerLoopEngine } from "../../coding/engines/provider-loop";
import { localShell } from "../../coding/engines/shells";
import { cleanup, cleanups, drain, project, recordingGate, toolResults, usageRecorder } from "./engine-harness";

/**
 * A Claude Bot set to Synapse's own coding loop: the same loop, tools and gate as every provider, with Claude spoken to
 * in its Messages dialect, only through the Claude auth proxy (the key is added there, never seen by the loop), metered
 * as "coding" at Claude's list price, and reported to the proxy so nothing is counted twice.
 */
afterEach(async () => { setAuthProxy(null); await cleanup(); });
const KEY = `sk-ant-api03-${"K".repeat(80)}real`;

type Ev = Record<string, unknown>;
const sse = (events: Ev[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = (input: number, read = 0) => ({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 1 } } });
const toolUse = (id: string, name: string, input: Record<string, unknown>): Ev[] => {
  const json = JSON.stringify(input);
  return [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(5) } },
    { type: "content_block_stop", index: 0 },
  ];
};
const text = (t: string): Ev[] => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  { type: "content_block_stop", index: 0 },
];
const end = (stop: string, out: number): Ev[] => [{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: out } }, { type: "message_stop" }];

async function fakeMessages(replies: Ev[][]) {
  const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(replies[seen.length - 1] ?? [start(10), ...text("done"), ...end("end_turn", 1)]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("provider-loop on a Claude model (a Claude Bot set to Synapse's loop)", () => {
  it("reads, edits, runs the tests and reports; through the auth proxy only; metered once, as coding", async () => {
    const p = project();
    const rows = usageRecorder();
    const up = await fakeMessages([
      [start(3000), ...toolUse("toolu_1", "Read", { file_path: "src/add.js" }), ...end("tool_use", 40)],
      [start(200, 3000), ...toolUse("toolu_2", "Edit", { file_path: "src/add.js", old_string: "a - b", new_string: "a + b" }), ...end("tool_use", 60)],
      [start(150, 3200), ...toolUse("toolu_3", "Bash", { command: "node test.js" }), ...end("tool_use", 20)],
      [start(120, 3400), ...text("Fixed add; node test.js: 1 passed."), ...end("end_turn", 15)],
    ]);
    const unreported: unknown[] = [];
    const proxy = new AuthProxy({ upstream: up.url, port: 0, credential: () => KEY, onUnreported: (...a) => unreported.push(a) });
    await proxy.start();
    cleanups.push(() => proxy.stop());
    setAuthProxy(proxy);
    const g = recordingGate();
    const { messages, result } = await drain(providerLoopEngine({ hostPrivate: p.hostPrivate, gate: g.gate, files: p.files, shell: localShell(), store: p.store })
      .start({ botId: "bot-c", agentId: "coding-c1", cwd: p.wt, model: "claude-sonnet-5", prompt: "Task:\nFix add." }));

    expect(result).toMatchObject({ subtype: "success", result: "Fixed add; node test.js: 1 passed.", engine: "provider-loop", model: "claude-sonnet-5" });
    expect(fs.readFileSync(path.join(p.wt, "src/add.js"), "utf8")).toBe("exports.add = (a, b) => a + b;\n");
    expect(toolResults(messages).map((r) => [r.name, r.isError])).toEqual([["Read", false], ["Edit", false], ["Bash", false]]);
    expect(g.calls).toEqual([{ toolName: "Bash", input: { command: "node test.js" } }]);
    // Anthropic saw the real key (added by the proxy) and never a proxy token; the loop never held the key.
    for (const r of up.seen) expect(r.headers["x-api-key"]).toBe(KEY);
    const first = up.seen[0]!.body;
    expect(first).toMatchObject({ model: "claude-sonnet-5", stream: true });
    expect((first.system as { text: string; cache_control: unknown }[])[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect((first.system as { text: string }[])[0]!.text).toContain("You are a coding agent inside Synapse.");
    expect((first.tools as { name: string }[]).map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "WebFetch"]);
    // Tool results go back as tool_result blocks in one user turn, the last block marked for the cache.
    const second = up.seen[1]!.body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(second[2]!.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    // Metered here, once per call, as coding for the Bot on Claude; the proxy has nothing unreported to add.
    expect(rows.map((r) => [r.purpose, r.botId, r.model])).toEqual(Array.from({ length: 4 }, () => ["coding", "bot-c", "claude-sonnet-5"]));
    expect(rows.map((r) => r.usage.cacheReadTokens)).toEqual([0, 3000, 3200, 3400]);
    expect(rows.map((r) => r.usage.outputTokens)).toEqual([40, 60, 20, 15]);
    expect(rows.every((r) => (r.usage.costUsd ?? 0) > 0)).toBe(true);
    expect(unreported).toEqual([]);
  }, 30_000);

  it("without the auth proxy (no Anthropic key), nothing is sent and the agent says why", async () => {
    const p = project();
    const { result } = await drain(providerLoopEngine({ hostPrivate: p.hostPrivate, gate: recordingGate().gate, files: p.files, shell: localShell(), store: p.store })
      .start({ botId: "bot-c", agentId: "coding-c2", cwd: p.wt, model: "claude-sonnet-5", prompt: "go" }));
    expect(result).toMatchObject({ subtype: "error" });
    expect(String(result!.result)).toMatch(/key/i);
  });
});
