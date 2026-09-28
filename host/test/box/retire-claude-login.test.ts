import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Review round 2 (S1): box/files/retire-claude-login, run as root by provision.sh, leaves no Claude login on the box's
 * disk and pins the CLI's login method to the Console. Run here against a temp root (never the real /).
 */
const SCRIPT = path.resolve(__dirname, "../../../box/files/retire-claude-login");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const put = (root: string, rel: string, text = "x") => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

describe("retire-claude-login", () => {
  it("removes stored logins from box and every Bot config dir, the old token and its temp files; pins forceLoginMethod", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retire-root-")); dirs.push(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "retire-outside-")); dirs.push(outside);
    const kept = put(outside, "real-credentials.json", "{\"claudeAiOauth\":{}}");
    put(root, "home/box/.claude/.credentials.json");
    put(root, "home/box/.claude/settings.json", "{}");
    put(root, "home/bots/bot-a/.claude/.credentials.json");
    put(root, "home/bots/bot-b/.claude/other.json");
    fs.mkdirSync(path.join(root, "home/bots/bot-c/.claude"), { recursive: true });
    fs.symlinkSync(kept, path.join(root, "home/bots/bot-c/.claude/.credentials.json")); // a link: unlinked, never followed
    put(root, "home/box/.host/claude-oauth-token");
    put(root, "home/box/.host/claude-oauth-token.123.tmp");
    put(root, "home/box/.host/vault.key");
    // Stand-ins: stat names an owner, runuser runs the command (a test can't switch users).
    const bin = path.join(root, "fakebin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "runuser"), "#!/bin/sh\nshift 2; [ \"$1\" = -- ] && shift; exec \"$@\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "stat"), "#!/bin/sh\necho botowner\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RETIRE_STAT: `${bin}/stat` };
    const r = spawnSync("bash", [SCRIPT, root], { encoding: "utf8", env });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "home/box/.claude/.credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "home/bots/bot-a/.claude/.credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "home/box/.claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "home/bots/bot-b/.claude/other.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "home/bots/bot-c/.claude/.credentials.json"))).toBe(false); // round 3 (D1): the link is unlinked
    expect(fs.readFileSync(kept, "utf8")).toContain("claudeAiOauth");
    expect(fs.readdirSync(path.join(root, "home/box/.host"))).toEqual(["vault.key"]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "etc/claude-code/managed-settings.json"), "utf8"))).toEqual({ forceLoginMethod: "console" });
    expect(spawnSync("bash", [SCRIPT, root], { env }).status).toBe(0); // idempotent
  });

  it("provision.sh installs and runs it, and verify-box.sh checks the result", () => {
    const prov = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");
    expect(prov).toMatch(/files\/retire-claude-login/);
    expect(prov).toMatch(/\/usr\/local\/libexec\/retire-claude-login\b/);
    const verify = fs.readFileSync(path.resolve(__dirname, "../../../box/verify-box.sh"), "utf8");
    expect(verify).toMatch(/no stored Claude login in any config dir/);
    expect(verify).toMatch(/forceLoginMethod/);
  });
});
