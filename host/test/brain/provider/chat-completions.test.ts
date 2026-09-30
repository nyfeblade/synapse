import { describe, expect, it } from "vitest";
import { ChatCompletionsAdapter } from "../../../brain/provider/adapters/chat-completions";
import type { CanonMessage, CanonRequest } from "../../../brain/provider/adapters/types";

const SIG = { google: { thought_signature: "c2lnLTE=" } };
const HISTORY: CanonMessage[] = [
  { role: "user", parts: [{ type: "text", text: "list my files" }] },
  { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "mcp__bot__Shell", arguments: "{\"command\":\"ls\"}", providerMeta: { extra_content: SIG } }] },
  { role: "tool", toolCallId: "call_1", name: "mcp__bot__Shell", text: "a.txt", isError: false, images: [{ mimeType: "image/png", data: "iVBOR" }] },
  { role: "user", parts: [{ type: "text", text: "and?" }, { type: "image", mediaType: "image/jpeg", dataBase64: "/9j/" }] },
];
const req = (o: Partial<CanonRequest> = {}): CanonRequest => ({
  model: "m-1", system: "SYS", messages: HISTORY, wireName: (n) => n.replace(/^mcp__bot__/, ""), cacheKey: "bot_1",
  tools: [{ name: "Shell", description: "Run", parameters: { type: "object", properties: {} }, strict: true }], effort: "low", maxOutputTokens: 500, ...o,
});

describe("Chat Completions encoding: golden requests per provider", () => {
  it("OpenAI: strict tools, max_completion_tokens, reasoning_effort, prompt_cache_key, tool images in a follow-up user message", () => {
    expect(new ChatCompletionsAdapter("openai").encode(req())).toEqual({
      model: "m-1", stream: true, stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "list my files" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Shell", arguments: "{\"command\":\"ls\"}" }, extra_content: SIG }] },
        { role: "tool", tool_call_id: "call_1", content: "a.txt" },
        { role: "user", content: [{ type: "text", text: "The images returned by the tool calls above:" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] },
        { role: "user", content: [{ type: "text", text: "and?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }] },
      ],
      tools: [{ type: "function", function: { name: "Shell", description: "Run", parameters: { type: "object", properties: {} }, strict: true } }],
      parallel_tool_calls: true, max_completion_tokens: 500, reasoning_effort: "low", prompt_cache_key: "bot_1",
    });
  });

  it("Gemini: never strict (phase 0 3c), max_tokens, thought signatures echoed on the call, images as a follow-up (phase 0 4)", () => {
    const b = new ChatCompletionsAdapter("gemini").encode(req()) as { tools: { function: Record<string, unknown> }[]; messages: Record<string, unknown>[] } & Record<string, unknown>;
    expect(b.tools[0]!.function).not.toHaveProperty("strict");
    expect(b.max_tokens).toBe(500);
    expect(b).not.toHaveProperty("prompt_cache_key");
    expect(b.reasoning_effort).toBe("low");
    expect((b.messages[2]!.tool_calls as Record<string, unknown>[])[0]!.extra_content).toEqual(SIG);
    expect(b.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.txt" });
    expect((b.messages[4]!.content as unknown[])[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } });
  });

  it("OpenRouter: data collection denied, usage accounting on, its reasoning object", () => {
    const b = new ChatCompletionsAdapter("openrouter").encode(req()) as Record<string, unknown>;
    expect(b.provider).toEqual({ data_collection: "deny" });
    expect(b.usage).toEqual({ include: true });
    expect(b.reasoning).toEqual({ effort: "low" });
    expect(b).not.toHaveProperty("reasoning_effort");
    expect(b.max_tokens).toBe(500);
  });

  it("Ollama and LM Studio: loose tools, no cache key; LM Studio sends no reasoning field", () => {
    const o = new ChatCompletionsAdapter("ollama").encode(req()) as Record<string, unknown>;
    expect(((o.tools as { function: Record<string, unknown> }[])[0]!.function)).not.toHaveProperty("strict");
    expect(o).not.toHaveProperty("prompt_cache_key");
    const l = new ChatCompletionsAdapter("lmstudio").encode(req()) as Record<string, unknown>;
    expect(l).not.toHaveProperty("reasoning_effort");
    expect(l).not.toHaveProperty("reasoning");
  });

  it("DeepSeek: tool images become a note (no image input); Mistral: no stream_options", () => {
    const d = new ChatCompletionsAdapter("deepseek").encode(req()) as { messages: { role: string; content: unknown }[] };
    expect(d.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.txt\n[1 image(s) omitted: this model can't read images]" });
    expect(d.messages.some((m) => JSON.stringify(m.content).includes("image_url") && m.role !== "user")).toBe(false);
    const m = new ChatCompletionsAdapter("mistral").encode(req()) as Record<string, unknown>;
    expect(m).not.toHaveProperty("stream_options");
    expect(m).not.toHaveProperty("reasoning_effort");
    expect(m.max_tokens).toBe(500);
  });

  it("an empty assistant reply (no text, no calls) is left out", () => {
    const b = new ChatCompletionsAdapter("gemini").encode(req({ messages: [{ role: "user", parts: [{ type: "text", text: "a" }] }, { role: "assistant", text: "", toolCalls: [] }, { role: "user", parts: [{ type: "text", text: "b" }] }] })) as { messages: { role: string }[] };
    expect(b.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("no tools: no tools, no parallel_tool_calls; empty arguments are sent as {}", () => {
    const b = new ChatCompletionsAdapter("openai").encode(req({ tools: [], messages: [{ role: "assistant", text: "hi", toolCalls: [{ id: "c", name: "mcp__bot__X", arguments: "" }] }] })) as Record<string, unknown>;
    expect(b).not.toHaveProperty("tools");
    expect(b).not.toHaveProperty("parallel_tool_calls");
    expect(((b.messages as Record<string, unknown>[])[1]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments).toBe("{}");
  });
});

describe("Chat Completions decoding", () => {
  it("assembles text, streamed tool arguments and the Gemini thought signature (echoed opaque)", () => {
    const d = new ChatCompletionsAdapter("gemini").decoder();
    const ev = [
      ...d.push({ choices: [{ index: 0, delta: { role: "assistant", content: "Look" } }] }),
      ...d.push({ choices: [{ index: 0, delta: { content: "ing." } }] }),
      ...d.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "Shell", arguments: "{\"comm" }, extra_content: SIG }] } }] }),
      ...d.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "and\":\"ls\"}" } }] }, finish_reason: "tool_calls" }] }),
      ...d.push({ choices: [], usage: { prompt_tokens: 1592, completion_tokens: 48, total_tokens: 2018 } }),
    ];
    expect(ev.filter((e) => e.kind === "tool_delta")).toEqual([
      { kind: "tool_delta", index: 0, id: "call_9", name: "Shell", delta: "{\"comm" },
      { kind: "tool_delta", index: 0, delta: "and\":\"ls\"}" },
    ]);
    const m = d.finish();
    expect(m.text).toBe("Looking.");
    expect(m.finishReason).toBe("tool_calls");
    expect(m.toolCalls).toEqual([{ index: 0, id: "call_9", name: "Shell", arguments: "{\"command\":\"ls\"}", providerMeta: { extra_content: SIG } }]);
    // Phase 0: Gemini's hidden reasoning is metered from total_tokens.
    expect(m.usage).toEqual({ inputTokens: 1592, outputTokens: 426, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 1592 });
  });

  it("tells apart several calls sent at the same index (Ollama) by their ids; gives an id to a call that had none", () => {
    const d = new ChatCompletionsAdapter("ollama").decoder();
    d.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] } }] });
    d.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "b", function: { name: "Write", arguments: { x: 1 } } }] } }] });
    d.push({ choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "Edit", arguments: "{}" } }] } }] });
    const calls = d.finish().toolCalls;
    expect(calls.map((c) => [c.id, c.name, c.arguments])).toEqual([["a", "Read", "{}"], ["b", "Write", "{\"x\":1}"], [expect.stringMatching(/^call_/), "Edit", "{}"]]);
  });

  it("reasoning deltas, cached tokens (OpenAI), prompt_cache_hit_tokens (DeepSeek) and usage.cost (OpenRouter)", () => {
    const o = new ChatCompletionsAdapter("openai");
    expect(o.decoder().push({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] })).toEqual([{ kind: "reasoning", delta: "hmm" }]);
    expect(o.usage({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } })).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0, promptTokens: 1000 });
    expect(new ChatCompletionsAdapter("deepseek").usage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 })).toMatchObject({ inputTokens: 40, cacheReadTokens: 60 });
    expect(new ChatCompletionsAdapter("openrouter").usage({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 })).toMatchObject({ costUsd: 0.0012 });
    expect(o.usage(null)).toBeNull();
    expect(o.usage({ prompt_tokens: 0, completion_tokens: 0 })).toBeNull();
  });
});
