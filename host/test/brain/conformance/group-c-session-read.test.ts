import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// CT-15 reads a box-owned session transcript (0600 box:bots) that bothost cannot read directly, even
// via its shared `bots` group membership. sha() must go through the root-owned
// bot-claude-read-session helper (readSessionFile) instead of fs.readFileSync.
vi.mock("../../../brain/conformance/session-file", () => ({
  readSessionFile: vi.fn((f: string) => Buffer.from(`contents-of:${f}`)),
  SESSION_READ_HELPER: "/usr/local/libexec/bot-claude-read-session",
}));

const { readSessionFile } = await import("../../../brain/conformance/session-file");
const { sha } = await import("../../../brain/conformance/checks/group-c");

describe("group-c CT-15 session reads go through the helper, not fs.readFileSync directly", () => {
  it("sha() hashes exactly the bytes readSessionFile returns for the given path", () => {
    const f = "/home/box/.claude/projects/-workspace/abc-123.jsonl";
    const digest = sha(f);
    expect(readSessionFile).toHaveBeenCalledWith(f);
    expect(digest).toBe(createHash("sha256").update(Buffer.from(`contents-of:${f}`)).digest("hex"));
  });
});
