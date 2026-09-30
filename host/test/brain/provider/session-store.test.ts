import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CanonMessage } from "../../../brain/provider/adapters/types";
import { isProviderSessionPath, newProviderSessionId, providerSessionFile, ProviderSessionStore } from "../../../brain/provider/session-store";

const MSGS: CanonMessage[] = [
  { role: "user", parts: [{ type: "text", text: "hi" }, { type: "image", mediaType: "image/png", dataBase64: "AAA" }] },
  { role: "assistant", text: "checking", toolCalls: [{ id: "c1", name: "mcp__bot__Shell", arguments: "{\"command\": \"ls\"}", providerMeta: { extra_content: { google: { thought_signature: "s" } } } }], providerMeta: { extra_content: { x: 1 } } },
  { role: "tool", toolCallId: "c1", name: "mcp__bot__Shell", text: "a\nb", isError: false, images: [{ mimeType: "image/png", data: "BBB" }] },
  { role: "assistant", text: "done", toolCalls: [] },
];

describe("ProviderSessionStore", () => {
  it("round-trips canonical messages through Claude-shaped JSONL records (canonical tool names, exact argument strings)", () => {
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "pss-"));
    const store = new ProviderSessionStore(hp);
    const sid = newProviderSessionId();
    store.append("bot_1", sid, MSGS.slice(0, 2), { model: "openai:x", usage: { input_tokens: 5 } });
    store.append("bot_1", sid, MSGS.slice(2));
    expect(new ProviderSessionStore(hp).load("bot_1", sid)).toEqual(MSGS);
    const file = providerSessionFile(hp, "bot_1", sid);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const recs = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(recs.map((r) => r.type)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(recs[1]!.message).toMatchObject({ role: "assistant", model: "openai:x", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "c1", name: "mcp__bot__Shell", input: { command: "ls" } }] });
    expect(recs[2]!.message).toMatchObject({ content: [{ type: "tool_result", tool_use_id: "c1", is_error: false }] });
    expect(recs.every((r, i) => r.sessionId === sid && (i === 0 ? r.parentUuid === null : r.parentUuid === recs[i - 1]!.uuid))).toBe(true);
    expect(isProviderSessionPath(hp, file)).toBe(true);
    expect(isProviderSessionPath(hp, path.join(hp, "other.jsonl"))).toBe(false);
  });

  it("loads only what follows the last compact boundary; a torn last line is skipped", () => {
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "pss-"));
    const store = new ProviderSessionStore(hp);
    const sid = newProviderSessionId();
    store.append("bot_1", sid, MSGS);
    store.appendBoundary("bot_1", sid);
    store.append("bot_1", sid, [{ role: "user", parts: [{ type: "text", text: "summary" }] }]);
    fs.appendFileSync(providerSessionFile(hp, "bot_1", sid), "{\"type\":\"assis");
    expect(new ProviderSessionStore(hp).load("bot_1", sid)).toEqual([{ role: "user", parts: [{ type: "text", text: "summary" }] }]);
    expect(store.load("bot_1", "prov-missing")).toEqual([]);
  });

  it("refuses paths that could leave the sessions folder", () => {
    expect(() => providerSessionFile("/hp", "../x", "prov-1")).toThrow();
    expect(() => providerSessionFile("/hp", "bot_1", "prov-../../x")).toThrow();
    expect(() => providerSessionFile("/hp", "bot_1", "0b6c-uuid")).toThrow();
  });
});
