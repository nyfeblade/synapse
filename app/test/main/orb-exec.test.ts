import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execBounded, orbCall, ORB_TIMEOUT_TEXT, runBounded, SCRIPT_LIMITS, TIMED_OUT } from "../../src/main/orb-exec";
import { listMachines, machineMarks } from "../../src/main/setup/orb";
import { plainError } from "../../src/main/setup/provisioner";

// Bug 435: OrbStack 2.2.3 sometimes leaves a finished command unreaped and the Mac-side orb waits forever. These use a
// fake orb that never exits (it ignores SIGTERM and leaves a grandchild holding the pipes, the worst case).
const repo = path.resolve(__dirname, "../../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-exec-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fake orb. `hang` never exits; `hang-once` hangs on its first run only (counted in $COUNT); else prints its args. */
const fake = path.join(dir, "orb");
fs.writeFileSync(fake, `#!/bin/bash
n=$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 )); echo $n > "$COUNT"
case "$1" in
  hang) trap '' TERM; sleep 600 & echo $! > "$COUNT.child"; wait; while :; do sleep 1; done ;;
  hang-once) if [ $n = 1 ]; then trap '' TERM; exec sleep 600; fi; echo recovered ;;
  cat) cat ;;
  code) echo out; echo err >&2; exit 7 ;;
  *) echo "args: $*" ;;
esac
`, { mode: 0o755 });

let seq = 0;
const counter = () => path.join(dir, `count-${++seq}`);
const runs = (f: string) => Number(fs.readFileSync(f, "utf8").trim());
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const withCount = (f: string) => ({ ...process.env, COUNT: f });
const exec = (f: string): Parameters<typeof orbCall>[0] => (cmd, args, o) => execBounded(cmd, args, { ...o, env: { COUNT: f } });

describe("runBounded (bug 435)", () => {
  it("normal path: output, exit code and stdin come through, nothing waits on a timer", async () => {
    const f = counter();
    const t0 = Date.now();
    const a = await runBounded(fake, ["list"], { timeoutMs: 10_000, env: withCount(f) });
    expect(a).toMatchObject({ code: 0, timedOut: false });
    expect(a.stdout.toString()).toBe("args: list\n");
    const b = await runBounded(fake, ["code"], { timeoutMs: 10_000, env: withCount(f) });
    expect(b).toMatchObject({ code: 7, stderr: "err\n", timedOut: false });
    const c = await runBounded(fake, ["cat"], { timeoutMs: 10_000, env: withCount(f), stdin: Buffer.from("tarball\0bytes") });
    expect(c.stdout).toEqual(Buffer.from("tarball\0bytes"));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("a call that never exits is killed with its whole process group and comes back as 124", async () => {
    const f = counter();
    const t0 = Date.now();
    const r = await runBounded(fake, ["hang"], { timeoutMs: 300, graceMs: 200, env: withCount(f) });
    expect(r).toMatchObject({ code: TIMED_OUT, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const child = Number(fs.readFileSync(`${f}.child`, "utf8"));
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(child)).toBe(false);
  });

  it("a missing binary is an error result, not a throw", async () => {
    const r = await runBounded(path.join(dir, "nope"), [], { timeoutMs: 1_000 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});

describe("orbCall (bug 435)", () => {
  it("an idempotent call that hangs is tried once more, then surfaces a clear error", async () => {
    const f = counter();
    const r = await orbCall(exec(f), fake, ["hang", "x"], { timeoutMs: 300, idempotent: true });
    expect(runs(f)).toBe(2);
    expect(r).toMatchObject({ code: TIMED_OUT, timedOut: true });
    expect(r.stderr).toContain(ORB_TIMEOUT_TEXT);
    expect(r.stderr).toContain("tried 2 times");
  });

  it("the retry recovers when the first call was the stuck one", async () => {
    const f = counter();
    const r = await orbCall(exec(f), fake, ["hang-once"], { timeoutMs: 300, idempotent: true });
    expect(runs(f)).toBe(2);
    expect(r).toMatchObject({ code: 0, stdout: "recovered\n" });
  });

  it("a call that isn't safe to repeat runs once and surfaces the error", async () => {
    const f = counter();
    const r = await orbCall(exec(f), fake, ["hang", "create"], { timeoutMs: 300, idempotent: false });
    expect(runs(f)).toBe(1);
    expect(r.code).toBe(TIMED_OUT);
    expect(r.stderr).toMatch(new RegExp(`^${ORB_TIMEOUT_TEXT} within 0 s \\(orb hang create\\)`));
  });

  it("the normal path is one call, untouched", async () => {
    const f = counter();
    const r = await orbCall(exec(f), fake, ["list"], { timeoutMs: 5_000, idempotent: true });
    expect(runs(f)).toBe(1);
    expect(r).toMatchObject({ code: 0, stdout: "args: list\n" });
  });

  it("setup reads a hung list or marks as an error, never as 'no machine' or 'not ours'", async () => {
    const hung: Parameters<typeof orbCall>[0] = async () => ({ code: TIMED_OUT, stdout: "", stderr: "", timedOut: true });
    await expect(listMachines(hung, "orb")).rejects.toThrow(ORB_TIMEOUT_TEXT);
    await expect(machineMarks(hung, "orb", "synapse-box")).rejects.toThrow(ORB_TIMEOUT_TEXT);
  });

  it("the setup screen says OrbStack stopped answering (and shows Retry, as for any failed step)", () => {
    expect(plainError(`${ORB_TIMEOUT_TEXT} within 10 s (orb list, tried 2 times).`, "create")).toBe(
      "OrbStack stopped answering while creating the Bots' computer. Retry; if it keeps happening, restart OrbStack.",
    );
  });
});

describe("box/orb.sh bounds every orb call in the box scripts (bug 435)", () => {
  const sh = (script: string, env: Record<string, string>) =>
    spawnSync("bash", ["-c", `source "${repo}/box/orb.sh"; ${script}`], { env: { ...process.env, ORB: fake, ...env }, encoding: "utf8", input: "" });

  it("passes the normal call through (args, stdin, exit code)", () => {
    const f = counter();
    expect(sh("orb -m box cat /x", { COUNT: f }).stdout).toBe("args: -m box cat /x\n");
    expect(sh("printf piped | orb cat", { COUNT: f }).stdout).toBe("piped");
    expect(sh("orb code", { COUNT: f }).status).toBe(7);
  });

  it("kills a hung call after ORB_TIMEOUT, exits 124 with the message, and marks ORB_TIMEOUT_MARK", () => {
    const f = counter();
    const mark = path.join(dir, `mark-${seq}`);
    const t0 = Date.now();
    const r = sh("ORB_TIMEOUT=1 orb hang -m box ls; echo rc=$?", { COUNT: f, ORB_TIMEOUT_MARK: mark });
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r.stdout).toContain("rc=124");
    expect(r.stderr).toContain(`${ORB_TIMEOUT_TEXT} within 1 s (orb hang -m box ls)`);
    expect(fs.readFileSync(mark, "utf8")).toBe("hang -m box ls\n");
    expect(alive(Number(fs.readFileSync(`${f}.child`, "utf8")))).toBe(false);
  });

  it("verify-box: a hung check is retried once and fails as timed out, even a negated one", () => {
    const f = counter();
    // Only the negated check "box cannot read .host" hangs; everything else fails fast.
    const vorb = path.join(dir, "vorb");
    fs.writeFileSync(vorb, `#!/bin/bash\ncase "$*" in *"-u box ls /home/box/.host"*) echo 1 >> "$COUNT"; exec sleep 600 ;; esac\nexit 1\n`, { mode: 0o755 });
    const r = spawnSync("bash", [path.join(repo, "box/verify-box.sh")], { env: { ...process.env, ORB: vorb, BOX_MACHINE: "no-such-machine", ORB_TIMEOUT: "1", COUNT: f }, encoding: "utf8", input: "" });
    expect(r.stdout).toContain("FAIL box cannot read .host (OrbStack didn't answer)");
    expect(r.stdout).not.toContain("PASS box cannot read .host");
    expect(fs.readFileSync(f, "utf8").trim().split("\n")).toHaveLength(2);
    expect(r.status).not.toBe(0);
  }, 60_000);
});

describe("the app's limit on each box script sits just above the script's own orb limits", () => {
  // Each script bounds its own orb calls (ORB_TIMEOUT, box/orb.sh; 120 s when unset). The app must never stop a script
  // before the script's own limit can fire (its message is the useful one), and not much later either.
  const worst = (script: string, portsCalls: number) => {
    const text = fs.readFileSync(path.join(repo, "box", script), "utf8");
    const set = [...text.matchAll(/ORB_TIMEOUT=(\d+) orb /g)].map((m) => Number(m[1]));
    return (set.reduce((a, b) => a + b, 0) + portsCalls * 120) * 1000;
  };
  it("provision-from-mac.sh", () => {
    const w = worst("provision-from-mac.sh", 2);
    expect(w).toBeGreaterThanOrEqual(3600_000);
    expect(SCRIPT_LIMITS.provision).toBeGreaterThanOrEqual(w);
    expect(SCRIPT_LIMITS.provision - w).toBeLessThanOrEqual(5 * 60_000);
  });
  it("deploy.sh", () => {
    const w = worst("deploy.sh", 2);
    expect(SCRIPT_LIMITS.deploy).toBeGreaterThanOrEqual(w);
    expect(SCRIPT_LIMITS.deploy - w).toBeLessThanOrEqual(5 * 60_000);
  });
});
