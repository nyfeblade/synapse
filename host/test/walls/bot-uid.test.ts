import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import {
  BOT_UID_MAX, BOT_UID_MIN, allocateUid, botLayoutPlan, botOsUser, botUserName, cliConfigDirFor, cliSessionFile,
} from "../../walls/bot-uid";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ BOX_HOME: "/home/box", WORKSPACE: "/workspace", ...extra });
const ID_A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const ID_B = "7a7a7a7a-1111-4222-8333-444455556666";

describe("bug #66: one OS account per Bot", () => {
  it("names a Bot's account bot-<first 12 hex of sha256(botId)>, the same rule the root helper uses", () => {
    const want = `bot-${createHash("sha256").update(ID_A).digest("hex").slice(0, 12)}`;
    expect(botUserName(ID_A)).toBe(want);
    expect(botUserName(ID_A)).toMatch(/^bot-[0-9a-f]{12}$/);
    expect(botUserName(ID_A)).not.toBe(botUserName(ID_B));
    expect(botUserName(ID_A).length).toBeLessThanOrEqual(32); // Linux user name limit
  });

  it("refuses a Bot id the helper would refuse", () => {
    for (const bad of ["", "../x", "a b", "x".repeat(65), "a/b"]) expect(() => botUserName(bad)).toThrow();
  });

  it("reserves a uid range above normal users (useradd's UID_MAX 60000) and below systemd's dynamic users (61184)", () => {
    expect(BOT_UID_MIN).toBeGreaterThan(60000);
    expect(BOT_UID_MAX).toBeLessThan(61184);
    expect(BOT_UID_MAX - BOT_UID_MIN + 1).toBeGreaterThanOrEqual(500);
  });

  describe("allocateUid", () => {
    it("starts at the bottom of the range", () => {
      expect(allocateUid({ taken: [], next: null })).toBe(BOT_UID_MIN);
    });
    it("never reuses a removed Bot's uid while the range has room above the high-water mark", () => {
      // 60200 was a Bot that was removed; 60201 is live; the high-water mark says 60202 is next.
      expect(allocateUid({ taken: [BOT_UID_MIN + 1], next: BOT_UID_MIN + 2 })).toBe(BOT_UID_MIN + 2);
    });
    it("skips a uid or gid something else already holds", () => {
      expect(allocateUid({ taken: [BOT_UID_MIN, BOT_UID_MIN + 1, BOT_UID_MIN + 3], next: BOT_UID_MIN })).toBe(BOT_UID_MIN + 2);
    });
    it("ignores ids outside the range and a high-water mark below it", () => {
      expect(allocateUid({ taken: [1000, 1001, 65534], next: 5 })).toBe(BOT_UID_MIN);
    });
    it("wraps to the lowest free uid once the high-water mark reaches the top", () => {
      expect(allocateUid({ taken: [BOT_UID_MAX, BOT_UID_MIN + 1], next: BOT_UID_MAX + 1 })).toBe(BOT_UID_MIN);
    });
    it("throws when the range is full", () => {
      const all = Array.from({ length: BOT_UID_MAX - BOT_UID_MIN + 1 }, (_, i) => BOT_UID_MIN + i);
      expect(() => allocateUid({ taken: all, next: BOT_UID_MIN })).toThrow(/full/);
    });
  });

  describe("per-Bot paths", () => {
    it("is off until the box is migrated: the legacy shared config dir and no OS account", () => {
      const c = cfg();
      expect(c.perBotUid).toBe(false);
      expect(botOsUser(c, ID_A)).toBeNull();
      expect(cliConfigDirFor(c, ID_A)).toBe("/home/box/.claude");
      expect(cliSessionFile(c, ID_A, "s1")).toBe("/home/box/.claude/projects/-workspace/s1.jsonl");
    });

    it("on: each Bot has its own home under /home/bots and its own CLAUDE_CONFIG_DIR, sessions included", () => {
      const c = cfg({ SYNAPSE_PER_BOT_UID: "1" });
      expect(c.perBotUid).toBe(true);
      const u = botOsUser(c, ID_A)!;
      expect(u.name).toBe(botUserName(ID_A));
      expect(u.home).toBe(`/home/bots/${u.name}`);
      expect(u.claudeConfigDir).toBe(`/home/bots/${u.name}/.claude`);
      expect(cliConfigDirFor(c, ID_A)).toBe(u.claudeConfigDir);
      expect(cliSessionFile(c, ID_A, "s1")).toBe(`${u.claudeConfigDir}/projects/-workspace/s1.jsonl`);
      expect(cliSessionFile(c, ID_B, "s1")).not.toBe(cliSessionFile(c, ID_A, "s1"));
    });
  });

  describe("botLayoutPlan (what bot-user ensure creates, and who owns it)", () => {
    const c = cfg({ SYNAPSE_PER_BOT_UID: "1" });
    const plan = botLayoutPlan(c, ID_A);
    const u = botUserName(ID_A);
    const at = (p: string) => plan.find((e) => e.path === p);

    it("home, CLI config, sessions, Chrome profile and ~/code (bug 231) are the Bot's own, 0700", () => {
      for (const p of [`/home/bots/${u}`, `/home/bots/${u}/.claude`, `/home/bots/${u}/.claude/projects`, `/home/bots/${u}/chrome-profile`, `/home/bots/${u}/code`]) {
        expect(at(p), p).toMatchObject({ type: "dir", owner: u, group: u, mode: 0o700 });
      }
    });

    it("the shared skills library is a link, not a copy (SKL-*: one library)", () => {
      expect(at(`/home/bots/${u}/.claude/skills`)).toMatchObject({ type: "link", target: "/home/box/.claude/skills" });
    });

    it("host-staged files are bothost-written, readable by this Bot's group only (setgid 2750)", () => {
      for (const k of ["uploads", "screens", "events", "mcp-output", "terminals"]) {
        expect(at(`/workspace/.host-out/${k}/${ID_A}`), k).toMatchObject({ type: "dir", owner: "bothost", group: u, mode: 0o2750 });
      }
    });

    it("nothing in the plan is group- or world-writable, and nothing but the staging dirs is readable by anyone else", () => {
      for (const e of plan) {
        if (e.type !== "dir") continue;
        expect(e.mode & 0o022, e.path).toBe(0);
        if (e.owner !== "bothost") expect(e.mode & 0o077, e.path).toBe(0);
        else expect(e.group, e.path).toBe(u);
      }
    });
  });
});
