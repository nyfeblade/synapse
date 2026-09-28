import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventTranslator } from "../../brain/event-translator";
import { log } from "../../util/log";
import { loadRecordings, sseEvents } from "./replay-anthropic";

/**
 * Bug 280: every event type Anthropic actually streamed (the sanitized recordings, replay-anthropic.ts) goes through
 * the host's EventTranslator the way the SDK hands it on (a `stream_event` per SSE event). Nothing throws, nothing is
 * logged as unknown, text and thinking come out as recorded, and every stop reason is one the API documents.
 */
afterEach(() => vi.restoreAllMocks());

const sse = loadRecordings().filter((r) => r.response.kind === "sse");
const EVENT_TYPES = new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"]);
const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "signature_delta", "input_json_delta", "citations_delta"]);
const BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use", "web_search_tool_result"]);
/** The Messages API's documented stop reasons. */
const STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]);
/** What INDEX.md says each streamed recording ended on. */
const TOOL_USE_STOPS = new Set(["0005-s02-tooluse-sonnet5", "0019-s08-websearch-sonnet5"]);

const asSdk = (event: Record<string, unknown>): SDKMessage => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }) as unknown as SDKMessage;

describe("recorded streams through the EventTranslator", () => {
  it.each(sse.map((r) => [r.file, r] as const))("%s: every event is a known type and translates", (_f, r) => {
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    const events = sseEvents(r);
    for (const e of events) {
      expect(EVENT_TYPES).toContain(e.type);
      if (e.type === "content_block_start") expect(BLOCK_TYPES).toContain(e.content_block.type);
      if (e.type === "content_block_delta") expect(DELTA_TYPES).toContain(e.delta.type);
    }
    const tr = new EventTranslator();
    const out = events.flatMap((e) => tr.translate(asSdk(e)));
    expect(out[0]).toEqual({ kind: "dispatched" });
    // The text a Bot's reply streams is the recorded text, delta for delta.
    const recordedText = events.filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta").map((e) => e.delta.text as string).join("");
    expect(out.filter((e) => e.kind === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe(recordedText);
    // Each thinking block opens and closes the thinking indicator once.
    const thinkingBlocks = events.filter((e) => e.type === "content_block_start" && e.content_block.type === "thinking").length;
    const thinking = out.filter((e) => e.kind === "thinking").map((e) => (e as { active: boolean }).active);
    expect(thinking).toEqual(Array.from({ length: thinkingBlocks }, () => [true, false]).flat());
    // The stop reason is documented and is the one the recording ended on.
    const stops = events.filter((e) => e.type === "message_delta").map((e) => e.delta?.stop_reason as string);
    expect(stops).toHaveLength(1);
    expect(STOP_REASONS).toContain(stops[0]);
    expect(stops[0]).toBe(TOOL_USE_STOPS.has(r.file) ? "tool_use" : "end_turn");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("the web search call (0020) streams its server tool, results and citations without a tool_start for the host", () => {
    const events = sseEvents(loadRecordings().find((r) => r.file.startsWith("0020"))!);
    const kinds = new Set(events.map((e) => [e.type, e.content_block?.type ?? e.delta?.type].filter(Boolean).join(":")));
    expect(kinds).toContain("content_block_start:server_tool_use");
    expect(kinds).toContain("content_block_start:web_search_tool_result");
    expect(kinds).toContain("content_block_delta:citations_delta");
    const out = events.flatMap((e) => new EventTranslator().translate(asSdk(e)));
    expect(out.some((e) => e.kind === "tool_start")).toBe(false);
  });
});

describe("the CLI's own system messages seen during the replayed turns", () => {
  // The real CLI sent these while replaying the recordings (replay.cli.integration.test.ts): a request status and a
  // thinking-token count. They carry nothing a Bot's turn shows, and are not unknown.
  it.each([
    [{ type: "system", subtype: "status", status: "requesting", uuid: "u", session_id: "s" }],
    [{ type: "system", subtype: "thinking_tokens", tokens: 96, uuid: "u", session_id: "s" }],
  ])("%o is known: no event, no warning", (m) => {
    const warn = vi.spyOn(log, "warn");
    expect(new EventTranslator().translate(m as unknown as SDKMessage)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a system subtype nobody knows is still logged", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    new EventTranslator().translate({ type: "system", subtype: "brand_new_thing", uuid: "u", session_id: "s" } as unknown as SDKMessage);
    expect(warn).toHaveBeenCalledWith("unhandled SDK system subtype", { subtype: "brand_new_thing" });
  });
});
