import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os, { homedir, userInfo } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { homeChanges, realHomeForTest, snapshotHome } from "../../../scripts/test-home";

// Bug-log 436: a test ran `rm -rf ~/Downloads/<file>` through the real Mac gate with the owner's REAL home.
// Every test file now runs with a temp HOME (scripts/vitest-test-home.ts).
const real = realHomeForTest("the guard test compares the test home against it; it never writes there");

describe("the test home (bug 436)", () => {
  it("os.homedir(), $HOME and the passwd entry are all the temp home, never the real one", () => {
    expect(os.homedir()).not.toBe(real);
    expect(homedir()).toBe(os.homedir());
    expect(process.env.HOME).toBe(os.homedir());
    expect(os.userInfo().homedir).toBe(os.homedir());
    expect(userInfo().homedir).toBe(os.homedir());
    expect(path.relative(real, os.homedir()).startsWith("..")).toBe(true);
    expect(fs.readdirSync(os.homedir())).toEqual([]);
  });

  it("a spawned shell expands ~ into the temp home", () => {
    expect(execFileSync("/bin/sh", ["-c", "echo ~"], { encoding: "utf8" }).trim()).toBe(os.homedir());
  });

  it("deleting HOME still leaves the temp home, not the passwd entry", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try { expect(os.homedir()).not.toBe(real); } finally { process.env.HOME = saved; }
  });

  it("tool config redirects into the real home are gone", () => {
    for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GIT_CONFIG_GLOBAL", "ZDOTDIR"]) expect(process.env[v]).toBeUndefined();
    expect(process.env.XDG_CONFIG_HOME!.startsWith(os.homedir())).toBe(true);
  });

  it("the escape hatch wants a reason", () => {
    expect(() => realHomeForTest(" ")).toThrow(/why/);
  });

  it("the global guard flags an existing entry removed or rewritten, top level only; a new entry is fine", () => {
    const h = os.homedir();
    fs.mkdirSync(path.join(h, "Downloads"));
    fs.writeFileSync(path.join(h, "Downloads", "keep.txt"), "a");
    fs.writeFileSync(path.join(h, "Downloads", "gone.txt"), "a");
    fs.mkdirSync(path.join(h, ".claude", "projects"), { recursive: true });
    fs.writeFileSync(path.join(h, ".claude", "settings.json"), "{}");
    const before = snapshotHome(h);
    expect(before.Desktop).toEqual({}); // missing is empty, not unreadable
    fs.rmSync(path.join(h, "Downloads", "gone.txt"));
    fs.utimesSync(path.join(h, "Downloads", "keep.txt"), new Date(0), new Date(0));
    fs.writeFileSync(path.join(h, ".claude", "projects", "deep.jsonl"), "x"); // inside a names-only folder: ignored
    fs.writeFileSync(path.join(h, ".claude", "new.json"), "x"); // new: ignored
    fs.writeFileSync(path.join(h, "Downloads", "fresh.pdf"), "x"); // the owner's new download: ignored
    fs.writeFileSync(path.join(h, ".claude", "settings.json"), "{\"a\":1}"); // rewritten in a names-only folder: ignored
    expect(homeChanges(before, snapshotHome(h)).sort()).toEqual([
      "changed  ~/Downloads/keep.txt",
      "removed  ~/Downloads/gone.txt",
    ]);
    fs.rmSync(path.join(h, ".claude", "settings.json"));
    expect(homeChanges(before, snapshotHome(h))).toContain("removed  ~/.claude/settings.json");
  });
});
