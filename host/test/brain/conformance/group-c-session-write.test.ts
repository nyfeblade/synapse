import { describe, expect, it, vi } from "vitest";

// CT-14 (session rollover) synthesizes a new, larger session and writes it under the box's
// ~/.claude/projects/, a tree the CLI owns 0600 box:bots. bothost has no write bits there, so
// synthesizeSession's default writer must go through the root-owned bot-claude-write-session
// helper (writeSessionFile), not fs.writeFileSync directly.
vi.mock("../../../brain/conformance/session-file", () => ({
  readSessionFile: vi.fn((f: string) => Buffer.from(`contents-of:${f}`)),
  writeSessionFile: vi.fn(),
  SESSION_READ_HELPER: "/usr/local/libexec/bot-claude-read-session",
  SESSION_WRITE_HELPER: "/usr/local/libexec/bot-claude-write-session",
}));

const { writeSessionFile } = await import("../../../brain/conformance/session-file");
const { synthesizeSession } = await import("../../../brain/conformance/checks/group-c");

describe("group-c CT-14 default session writes go through the helper, not fs.writeFileSync directly", () => {
  it("synthesizeSession's default writer calls writeSessionFile(dst, content) instead of writing dst itself", () => {
    const src = "/home/box/.claude/projects/-workspace/template-123.jsonl";
    const dst = "/home/box/.claude/projects/-workspace/new-456.jsonl";
    const readSrc = () =>
      [
        JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "old", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "old", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      ].join("\n") + "\n";
    synthesizeSession(src, dst, "new-456", 1000, readSrc);
    expect(writeSessionFile).toHaveBeenCalledTimes(1);
    const [calledDst, calledContent] = vi.mocked(writeSessionFile).mock.calls[0]!;
    expect(calledDst).toBe(dst);
    expect(typeof calledContent).toBe("string");
    expect(calledContent.trim().split("\n").length).toBeGreaterThan(0);
    for (const line of calledContent.trim().split("\n")) expect(JSON.parse(line).sessionId).toBe("new-456");
  });
});
