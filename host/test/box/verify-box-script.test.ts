import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// task-24 fix round 1, finding 3: `command` is a shell builtin, not a standalone executable. Every
// other check in this script that needs a shell builtin or feature wraps it in `orb ... sh -c '...'`
// (or bash -c "..."). The "gh installed" check instead passed `command` as a literal argv[0] to orb,
// which orb execs directly — that always fails with "not found", regardless of whether gh is
// actually installed, so the check always reports FAIL. This is a static check on the script's text;
// it does not invoke orb or touch the OrbStack box.
const script = fs.readFileSync(path.resolve(__dirname, "../../../box/verify-box.sh"), "utf8");
const lines = script.split("\n");
const ghLine = lines.find((l) => l.includes('"gh installed"'));

describe("verify-box.sh (task-24 fix round 1, finding 3)", () => {
  it('runs "command -v gh" through a shell, matching this file\'s own idiom for shell builtins', () => {
    expect(ghLine).toBeDefined();
    // Must go through `sh -c` or `bash -c`, not pass `command` as a literal argv[0] to orb.
    expect(ghLine).toMatch(/\b(sh|bash)\s+-c\s+['"]command -v gh['"]/);
    expect(ghLine).not.toMatch(/orb\s+-m\s+\$M\s+-u\s+root\s+command\s+-v\s+gh\s*$/);
  });
});

// Final secfix round 4 (ruling 2): verify-box checks the installed bot-snapshot restores as each tree's owner.
describe("verify-box.sh (secfix round 4, ruling 2)", () => {
  const line = (name: string) => lines.find((l) => l.includes(`"${name}"`)) ?? "";
  it("checks the installed helper drops to owners and never rsyncs as root", () => {
    expect(line("snapshot restore drops to owners")).toMatch(/__restore-tree/);
    expect(line("snapshot restore drops to owners")).toMatch(/rsync -a/);
  });
  it("checks the restore stage refuses root", () => {
    expect(line("snapshot restore stage refuses root")).toMatch(/sudo -n \/usr\/local\/libexec\/bot-snapshot __restore-tree workspace/);
    expect(line("snapshot restore stage refuses root")).toMatch(/bad restore stage/);
  });
  it("runs a real restore past a box-planted /workspace link into /etc", () => {
    const i = lines.findIndex((l) => l.includes('"snapshot restore ignores a planted link"'));
    expect(i).toBeGreaterThan(-1);
    const block = lines.slice(i, i + 12).join("\n");
    expect(block).toMatch(/ln -s \/etc \/workspace\/\.p4-restore\/sub/);
    expect(block).toMatch(/bot-snapshot restore snap-verify02 workspace/);
    expect(block).toMatch(/test ! -e \/etc\/p4-restore-probe/);
  });
});

// Live-box finding (final box verification): since final secfix round 3 (ruling 1) bot-claude-write-session runs as
// box with --regid=bots, and the projects directory is setgid group bots (2755), so a new transcript lands box:bots
// 0600 -- exactly what the CLI's own session files look like. The check still demanded box:box and always FAILed.
describe("verify-box.sh write-session ownership (live-box finding)", () => {
  const line = lines.find((l) => l.includes("write-session writes atomically")) ?? "";
  it("accepts the group the setgid projects directory gives, not only box:box", () => {
    expect(line).not.toMatch(/'box:box:600'/);
    expect(line).toMatch(/grep -qx 'box:[^']*bots[^']*:600'/);
  });
});

// Live-box finding: the checks build a scratch project at /home/box/.claude/projects/-verify and left it behind,
// including root-owned files (a root symlink, probe output). /home/box is restorable and its restore stage runs as
// box, which cannot set times on a root-owned file -- rsync then fails the whole restore. Clean up at the end.
describe("verify-box.sh cleans up its scratch project (live-box finding)", () => {
  it("removes /home/box/.claude/projects/-verify before exiting", () => {
    const tail = script.slice(script.lastIndexOf("\ncheck "));
    expect(tail).toMatch(/rm -rf[^\n]*\/home\/box\/\.claude\/projects\/-verify/);
    expect(script.trimEnd().endsWith("exit $fail")).toBe(true);
  });
});

// Bug #66: verify-box proves on the real box that one Bot's account can't read another's home, CLI transcript,
// Chrome cookies, staged uploads, memory or process env, and that a Bot can still run tools, git and npm.
describe("verify-box.sh per-Bot walls (bug #66)", () => {
  const has = (name: string) => lines.some((l) => l.includes(`"${name}"`));
  it("names every wall and every still-works check", () => {
    for (const n of ["Bot A can't list or read Bot B's home", "Bot A can't read Bot B's CLI transcript", "Bot A can't read Bot B's Chrome cookies",
      "Bot A can't read Bot B's staged upload", "Bot A can't read any Bot's memory or chat store", "Bot A can't read Bot B's process env",
      "Bot A runs tools, git and npm in its own home", "Bot A and B share /workspace (group write)", "Bot CLI starts as its own account",
      "Bot CLI refuses another Bot's account", "throwaway Bot accounts removed"]) expect(has(n), n).toBe(true);
  });
  it("follow-up: terminals, process visibility, snapshots of the Bot homes, and the MCP decision are each checked", () => {
    for (const n of ["Bot B's Shell output lands in its private transcript", "Bot A can't read Bot B's Shell transcript", "Bot B's Shell can't write its transcript by name",
      "Bot B's Shell sees only its own processes", "/proc is hidepid=invisible (migrated box)", "Bot A can't see Bot B's process",
      "the host still sees and measures Bot B's process", "bot-reap still runs", "snapshot manifest lists home/bots", "snapshot archives Bot A's home",
      "keyed MCP servers run as boxmcp, never a Bot uid"]) expect(has(n), n).toBe(true);
    expect(script).toMatch(/sudo -n \/usr\/local\/libexec\/bot-shell start \$VS \/workspace \$UB verify-walls-b/);
  });
  // Live finding (2026-09-22): ProtectProc=/PrivateTmp= are inert on OrbStack's systemd, so process hiding exists only
  // once the migration turned on /proc hidepid; the Shell's process check must sit inside the migrated branch.
  it("checks a Bot Shell's process view only on a migrated box, and uses no shared /tmp file", () => {
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const iff = at(/^\s*if orb .*50-per-bot-uid\.conf; then/);
    const chk = at(/"Bot B's Shell sees only its own processes"/);
    const els = lines.findIndex((l, i) => i > iff && /^\s*else$/.test(l));
    expect(iff).toBeGreaterThan(-1);
    expect(chk).toBeGreaterThan(iff);
    expect(chk).toBeLessThan(els);
    expect(script).not.toContain("/tmp/uids");
  });
  it("uses throwaway accounts through the real sudo path and removes them", () => {
    expect(script).toMatch(/as_host_q sudo -n \$BU ensure verify-walls-a/);
    expect(script).toMatch(/as_host_q sudo -n \$BU remove verify-walls-a/);
    expect(script).toMatch(/as_host_q sudo -n \$BU remove verify-walls-b/);
  });
});
