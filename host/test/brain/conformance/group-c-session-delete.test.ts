import { describe, expect, it, vi } from "vitest";

// Gate L-5 / M-2: CT-14's cleanup of its synthesized sessions defaults to the root-owned delete helper
// (removeBoxSession → bot-claude-delete-session), so no stray box-owned .jsonl files are left behind.
vi.mock("../../../brain/conformance/session-file", () => ({
  readSessionFile: vi.fn(),
  writeSessionFile: vi.fn(),
  removeBoxSession: vi.fn(() => true),
}));

const { removeBoxSession } = await import("../../../brain/conformance/session-file");
const { cleanupSynthesizedSession } = await import("../../../brain/conformance/checks/group-c");

describe("CT-14 cleanup via the delete helper (L-5)", () => {
  it("cleanupSynthesizedSession(dst) with no injected rm removes dst through removeBoxSession", () => {
    const dst = "/home/box/.claude/projects/-workspace/0393b532-c3c8-448c-b375-f9851dc52ed9.jsonl";
    cleanupSynthesizedSession(dst);
    expect(removeBoxSession).toHaveBeenCalledWith(dst);
  });
});
