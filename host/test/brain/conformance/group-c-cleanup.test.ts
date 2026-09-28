import { describe, expect, it, vi } from "vitest";
import { log } from "../../../util/log";

// CT-14 synthesizes a session directly inside the box's ~/.claude/projects/ tree; once written via
// the root-owned bot-claude-write-session helper (box/files/bot-claude-write-session), that file is
// box:box 0600 inside a directory bothost provably cannot write into (the entire premise of that
// helper). unlink() is subject to the same directory-permission barrier as open(O_CREAT), so the
// post-probe cleanup can throw EACCES against the real box; `{ force: true }` only suppresses
// ENOENT, not EACCES. cleanupSynthesizedSession makes that cleanup best-effort: EACCES is caught
// and downgraded to a log.warn instead of failing the check; any other error still propagates.
const { cleanupSynthesizedSession } = await import("../../../brain/conformance/checks/group-c");

describe("group-c CT-14 cleanupSynthesizedSession", () => {
  it("downgrades EACCES to a log.warn instead of throwing", () => {
    const err = Object.assign(new Error("EACCES: permission denied, unlink '/home/box/.claude/projects/x/y.jsonl'"), { code: "EACCES" });
    const rm = vi.fn(() => {
      throw err;
    });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(() => cleanupSynthesizedSession("/home/box/.claude/projects/x/y.jsonl", rm)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/could not remove/i);
    warnSpy.mockRestore();
  });

  it("still propagates non-EACCES errors", () => {
    const err = Object.assign(new Error("boom"), { code: "EIO" });
    const rm = vi.fn(() => {
      throw err;
    });
    expect(() => cleanupSynthesizedSession("/home/box/.claude/projects/x/y.jsonl", rm)).toThrow("boom");
  });

  it("calls rm(dst, { force: true }) on the happy path and does not warn", () => {
    const rm = vi.fn();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    cleanupSynthesizedSession("/home/box/.claude/projects/x/y.jsonl", rm);
    expect(rm).toHaveBeenCalledWith("/home/box/.claude/projects/x/y.jsonl", { force: true });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
