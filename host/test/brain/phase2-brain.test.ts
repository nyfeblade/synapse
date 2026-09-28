import { describe, expect, it } from "vitest";
import { EventTranslator } from "../../brain/event-translator";
import { toSdkUserMessage } from "../../brain/sdk-wiring";

describe("EventTranslator context tokens (ORIG-07 §07.1)", () => {
  it("emits input + cache read + cache creation of a main-thread assistant message", () => {
    const t = new EventTranslator();
    const ev = t.translate({
      type: "assistant", parent_tool_use_id: null,
      message: { id: "m1", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 } },
    } as never);
    expect(ev).toContainEqual({ kind: "context", tokens: 1100 });
  });
  it("ignores subagent messages", () => {
    const t = new EventTranslator();
    const ev = t.translate({ type: "assistant", parent_tool_use_id: "x", message: { id: "m", content: [], usage: { input_tokens: 5 } } } as never);
    expect(ev.find((e) => e.kind === "context")).toBeUndefined();
  });
});

describe("toSdkUserMessage (CHAT-09)", () => {
  it("sends image parts as base64 image blocks", () => {
    const m = toSdkUserMessage([{ text: "look" }, { image: { mediaType: "image/png", dataBase64: "AAAA" } }]);
    expect(m.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });
});
