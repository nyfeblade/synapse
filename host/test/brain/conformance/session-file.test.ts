import { describe, expect, it, vi } from "vitest";
import { deleteSessionFile, readSessionFile, removeBoxSession, SESSION_DELETE_HELPER, SESSION_READ_HELPER, writeSessionFile, SESSION_WRITE_HELPER } from "../../../brain/conformance/session-file";
import { log } from "../../../util/log";

// CT-15: the CLI writes session transcripts 0600 box:bots, so bothost (though a member of the bots
// group) has no read bits on them. readSessionFile shells out to the root-owned
// bot-claude-read-session helper via `sudo -n` instead of reading the file directly.
describe("readSessionFile (CT-15: box session transcripts via the root-owned helper)", () => {
  it("shells out to sudo -n bot-claude-read-session with exactly the requested path", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from("line1\nline2\n"));
    const target = "/home/box/.claude/projects/-workspace/abc-123.jsonl";
    const out = readSessionFile(target, exec as never);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SESSION_READ_HELPER, target], expect.any(Object));
    expect(out.toString("utf8")).toBe("line1\nline2\n");
  });

  it("propagates the helper's failure (e.g. path rejected) rather than swallowing it", () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error("bot-claude-read-session: path must be under /home/box/.claude/projects/"); });
    expect(() => readSessionFile("/etc/passwd", exec as never)).toThrow(/path must be under/);
  });
});

// CT-14: synthesizing a rollover-sized session writes a NEW box-owned .jsonl into
// ~/.claude/projects/. bothost (running as itself, not box) has no write bits there, so
// writeSessionFile shells out to the root-owned bot-claude-write-session helper via `sudo -n`,
// piping the content on stdin rather than passing it as an argument.
describe("writeSessionFile (CT-14: synthesized session rollover via the root-owned helper)", () => {
  it("shells out to sudo -n bot-claude-write-session with exactly the target path, piping content on stdin", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    const target = "/home/box/.claude/projects/-workspace/new-456.jsonl";
    writeSessionFile(target, "line1\nline2\n", exec as never);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SESSION_WRITE_HELPER, target], expect.objectContaining({ input: "line1\nline2\n" }));
  });

  it("propagates the helper's failure (e.g. refusing to overwrite) rather than swallowing it", () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error("bot-claude-write-session: refusing to overwrite an existing file"); });
    expect(() => writeSessionFile("/home/box/.claude/projects/-workspace/x.jsonl", "x", exec as never)).toThrow(/refusing to overwrite/);
  });
});

// Gate M-2 / L-5: deleting a Bot (BOT-11) and CT-14's cleanup must really remove box-owned session files.
describe("deleteSessionFile / removeBoxSession (M-2: the root-owned delete helper)", () => {
  const target = "/home/box/.claude/projects/-workspace/0393b532-c3c8-448c-b375-f9851dc52ed9.jsonl";
  it("shells out to sudo -n bot-claude-delete-session with exactly the target path", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    deleteSessionFile(target, exec as never);
    expect(SESSION_DELETE_HELPER).toBe("/usr/local/libexec/bot-claude-delete-session");
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SESSION_DELETE_HELPER, target], expect.any(Object));
  });

  it("removeBoxSession is best-effort: true on success, a warning and false on a helper failure", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(removeBoxSession(target, vi.fn() as never)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(removeBoxSession(target, vi.fn(() => { throw new Error("bot-claude-delete-session: not a session file name"); }) as never)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

