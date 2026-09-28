import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOX_UID, Sandbox, firstIndex, setprivCalls, type LogEntry } from "./sandbox";

// Final secfix round 3, ruling 1: every root-owned helper that touches a box- or bothost-writable path drops to that
// user FIRST (setpriv --reuid=box --regid=bots --init-groups --reset-env) and does all its mkdir/write/mv/ln/rm as
// that user; root only validates arguments and re-execs. Temp files come from mktemp; publishing is mv -T / ln -T.
// These run the real helpers (dash) against a sandboxed temp tree (see ./sandbox.ts): "box" really can't write T/etc
// or read T/home/box/.host there, so an attack that needs root's rights fails exactly as it would on the box.
let s: Sandbox;
beforeEach(() => { s = new Sandbox(); });
afterEach(() => { s.cleanup(); });

const UUID = "00000000-0000-4000-8000-00000000beef";
const mutating = (e: LogEntry) => ["mkdir", "mv", "ln", "rm", "chown", "chmod", "install", "mktemp", "cp", "touch", "rmdir"].includes(e.cmd);
/** The helper re-exec'd as box before its first mutation, and every mutation ran as box. */
function droppedToBoxFirst(log: LogEntry[]): void {
  const sp = setprivCalls(log);
  expect(sp.length, JSON.stringify(log)).toBeGreaterThan(0);
  expect(sp[0]!.args).toEqual(expect.arrayContaining(["--reuid=box", "--regid=bots", "--init-groups", "--reset-env"]));
  expect(firstIndex(log, (e) => e.cmd === "setpriv")).toBeLessThan(firstIndex(log, mutating));
  expect(log.filter((e) => mutating(e) && e.uid !== BOX_UID), JSON.stringify(log)).toEqual([]);
}

describe("bot-claude-write-session", () => {
  const dir = () => s.p("home/box/.claude/projects/-workspace");
  it("drops to box before touching anything and still writes a new transcript atomically", () => {
    const target = `${dir()}/${UUID}.jsonl`;
    const r = s.run("bot-claude-write-session", [target], { input: "{\"a\":1}\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("{\"a\":1}\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    droppedToBoxFirst(r.log);
    expect(fs.readdirSync(dir())).toEqual([`${UUID}.jsonl`]); // no temp file left
  });

  it("the symlinked-temp PID trick writes nothing outside", () => {
    const target = `${dir()}/${UUID}.jsonl`;
    fs.writeFileSync(s.p("etc/cron-job"), "ORIGINAL\n");
    const r = s.run("bot-claude-write-session", [target], { input: "* * * * * root id\n", prefix: `/bin/ln -s ${s.p("etc/cron-job")} ${dir()}/.bot-claude-write-session.$$.tmp` });
    expect(fs.readFileSync(s.p("etc/cron-job"), "utf8")).toBe("ORIGINAL\n");
    expect(s.rootMutations(r.log)).toEqual([]);
  });

  it("still refuses to overwrite and refuses a symlinked parent", () => {
    const target = `${dir()}/${UUID}.jsonl`;
    fs.writeFileSync(target, "keep");
    expect(s.run("bot-claude-write-session", [target], { input: "x" }).status).toBe(126);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    fs.symlinkSync(s.p("etc"), `${dir()}/evil`);
    const r = s.run("bot-claude-write-session", [`${dir()}/evil/${UUID}.jsonl`], { input: "x" });
    expect(r.status).toBe(126);
    expect(s.tree("etc")).toEqual(["shadow"]);
  });
});

describe("bot-claude-read-session", () => {
  it("reads as box, so a link to a file box can't read yields nothing", () => {
    const f = s.p("home/box/.claude/projects/-workspace/a.jsonl");
    fs.writeFileSync(f, "line\n");
    const ok = s.run("bot-claude-read-session", [f]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe("line\n");
    expect(setprivCalls(ok.log)[0]!.args).toEqual(expect.arrayContaining(["--reuid=box", "--reset-env"]));
    expect(ok.log.filter((e) => e.cmd === "cat" && e.uid !== BOX_UID)).toEqual([]);
  });
});

describe("bot-claude-delete-session", () => {
  it("removes the transcript and its <uuid>/ folder as box", () => {
    const d = s.p("home/box/.claude/projects/-workspace");
    fs.writeFileSync(`${d}/${UUID}.jsonl`, "x");
    fs.mkdirSync(`${d}/${UUID}`);
    fs.writeFileSync(`${d}/${UUID}/y`, "y");
    const r = s.run("bot-claude-delete-session", [`${d}/${UUID}.jsonl`]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(d)).toEqual([]);
    droppedToBoxFirst(r.log);
  });

  it("a projects dir swapped for a link to a root-only place removes nothing there", () => {
    fs.rmSync(s.p("home/box/.claude/projects/-workspace"), { recursive: true });
    fs.writeFileSync(s.p("etc", `${UUID}.jsonl`), "root file");
    fs.symlinkSync(s.p("etc"), s.p("home/box/.claude/projects/-workspace"));
    s.run("bot-claude-delete-session", [s.p("home/box/.claude/projects/-workspace", `${UUID}.jsonl`)]);
    expect(fs.readFileSync(s.p("etc", `${UUID}.jsonl`), "utf8")).toBe("root file");
  });
});

describe("bot-claude-skill-write", () => {
  const skills = () => s.p("home/box/.claude/skills");
  it("drops to box first and writes SKILL.md 0664 atomically", () => {
    const r = s.run("bot-claude-skill-write", ["weekly"], { input: "---\nname: W\n---\nbody\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(`${skills()}/weekly/SKILL.md`, "utf8")).toBe("---\nname: W\n---\nbody\n");
    expect(fs.statSync(`${skills()}/weekly/SKILL.md`).mode & 0o777).toBe(0o664);
    expect(fs.readdirSync(`${skills()}/weekly`)).toEqual(["SKILL.md"]);
    droppedToBoxFirst(r.log);
  });

  it("the symlinked-temp PID trick writes nothing outside", () => {
    fs.mkdirSync(`${skills()}/weekly`);
    fs.writeFileSync(s.p("etc/passwd"), "root:x:0:0\n");
    const r = s.run("bot-claude-skill-write", ["weekly"], { input: "bothost ALL=(ALL) NOPASSWD: ALL\n", prefix: `/bin/ln -s ${s.p("etc/passwd")} ${skills()}/weekly/.bot-claude-skill-write.$$.tmp` });
    expect(fs.readFileSync(s.p("etc/passwd"), "utf8")).toBe("root:x:0:0\n");
    expect(s.rootMutations(r.log)).toEqual([]);
    expect(r.log.filter((e) => e.cmd === "chown" && e.uid === 0)).toEqual([]);
  });

  it("SKILL.md → a directory (or a link to one) never moves the temp file into it", () => {
    fs.mkdirSync(`${skills()}/weekly`);
    fs.symlinkSync(s.p("etc"), `${skills()}/weekly/SKILL.md`);
    const r = s.run("bot-claude-skill-write", ["weekly"], { input: "x\n" });
    expect(s.tree("etc")).toEqual(["shadow"]);
    expect(s.rootMutations(r.log)).toEqual([]);
    fs.unlinkSync(`${skills()}/weekly/SKILL.md`);
    fs.mkdirSync(`${skills()}/weekly/SKILL.md`);
    const r2 = s.run("bot-claude-skill-write", ["weekly"], { input: "x\n" });
    expect(r2.status).not.toBe(0);
    expect(fs.readdirSync(`${skills()}/weekly/SKILL.md`)).toEqual([]);
  });

  it("skills → / swapped in after the checks: nothing lands outside", () => {
    // the swap happens the moment the helper reads its input, i.e. after every readlink check
    fs.mkdirSync(`${skills()}/weekly`);
    fs.mkdirSync(s.p("etc/weekly"));
    const swap = `mv ${skills()} ${skills()}.real && ln -s ${s.p("etc")} ${skills()}`;
    fs.writeFileSync(s.p("shim/head.real"), "");
    fs.writeFileSync(s.p("shim/head"), `#!/bin/sh\n${swap} 2>/dev/null\nexec /usr/bin/head "$@"\n`);
    fs.chmodSync(s.p("shim/head"), 0o755);
    const r = s.run("bot-claude-skill-write", ["weekly"], { input: "PWNED\n" });
    expect(s.tree("etc")).toEqual(["shadow", "weekly"]);
    expect(s.rootMutations(r.log)).toEqual([]);
  });

  it("--no-clobber still refuses an existing SKILL.md", () => {
    fs.mkdirSync(`${skills()}/weekly`);
    fs.writeFileSync(`${skills()}/weekly/SKILL.md`, "v1");
    const r = s.run("bot-claude-skill-write", ["weekly", "--no-clobber"], { input: "v2" });
    expect(r.status).toBe(126);
    expect(fs.readFileSync(`${skills()}/weekly/SKILL.md`, "utf8")).toBe("v1");
    expect(fs.readdirSync(`${skills()}/weekly`)).toEqual(["SKILL.md"]);
  });
});

describe("bot-claude-skill-write-file", () => {
  const skills = () => s.p("home/box/.claude/skills");
  it("drops to box first, writes a nested helper file 0664", () => {
    const r = s.run("bot-claude-skill-write-file", ["weekly", "scripts/run.sh"], { input: "echo hi\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(`${skills()}/weekly/scripts/run.sh`, "utf8")).toBe("echo hi\n");
    expect(fs.statSync(`${skills()}/weekly/scripts/run.sh`).mode & 0o777).toBe(0o664);
    droppedToBoxFirst(r.log);
  });

  it("the PID trick, a target that is a link to a dir, and a skills → / swap all leave the outside untouched", () => {
    fs.mkdirSync(`${skills()}/weekly/scripts`, { recursive: true });
    fs.writeFileSync(s.p("etc/passwd"), "root:x:0:0\n");
    const r1 = s.run("bot-claude-skill-write-file", ["weekly", "scripts/run.sh"], { input: "PWNED\n", prefix: `/bin/ln -s ${s.p("etc/passwd")} ${skills()}/weekly/scripts/.bot-claude-skill-write-file.$$.tmp` });
    expect(fs.readFileSync(s.p("etc/passwd"), "utf8")).toBe("root:x:0:0\n");
    expect(s.rootMutations(r1.log)).toEqual([]);
    fs.symlinkSync(s.p("etc"), `${skills()}/weekly/scripts/notes`);
    const r2 = s.run("bot-claude-skill-write-file", ["weekly", "scripts/notes"], { input: "PWNED\n" });
    expect(s.tree("etc")).toEqual(["passwd", "shadow"]);
    expect(s.rootMutations(r2.log)).toEqual([]);
    fs.writeFileSync(s.p("shim/head"), `#!/bin/sh\nmv ${skills()} ${skills()}.real && ln -s ${s.p("etc")} ${skills()} && mkdir -p ${s.p("etc/weekly/scripts")} 2>/dev/null\nexec /usr/bin/head "$@"\n`);
    fs.chmodSync(s.p("shim/head"), 0o755);
    const r3 = s.run("bot-claude-skill-write-file", ["weekly", "scripts/run.sh"], { input: "PWNED\n" });
    expect(fs.existsSync(s.p("etc/weekly/scripts/run.sh"))).toBe(false);
    expect(s.rootMutations(r3.log)).toEqual([]);
  });
});

describe("bot-claude-skill-delete", () => {
  const skills = () => s.p("home/box/.claude/skills");
  it("drops to box first and removes the skill folder", () => {
    fs.mkdirSync(`${skills()}/weekly/scripts`, { recursive: true });
    fs.writeFileSync(`${skills()}/weekly/SKILL.md`, "x");
    const r = s.run("bot-claude-skill-delete", ["weekly"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(`${skills()}/weekly`)).toBe(false);
    droppedToBoxFirst(r.log);
  });

  it("skills → / swapped in after the checks removes nothing outside", () => {
    fs.mkdirSync(`${skills()}/weekly`);
    fs.mkdirSync(s.p("etc/weekly"));
    fs.writeFileSync(s.p("etc/weekly/keep"), "root data");
    // swap right after the helper's last check (its last readlink)
    fs.writeFileSync(s.p("shim/readlink"), `#!/bin/sh\nout=$(/usr/bin/readlink "$@")\necho "$out"\ncase "$out" in */weekly) mv ${skills()} ${skills()}.real && ln -s ${s.p("etc")} ${skills()} ;; esac\n`);
    fs.chmodSync(s.p("shim/readlink"), 0o755);
    const r = s.run("bot-claude-skill-delete", ["weekly"]);
    expect(fs.readFileSync(s.p("etc/weekly/keep"), "utf8")).toBe("root data");
    expect(s.rootMutations(r.log)).toEqual([]);
  });
});
