/**
 * Bug 433: a Bot could stall the Mac gate with a big hostile command (messagesSend alone took ~10.7 s on 300 KB of
 * `subprocess.run(["`). The whole gate decision (LocalPolicyStore.check: the fixed rules, the hand-off / exempt /
 * private-store checks, the Mac floor and the Full-auto classifier) on 1 MB of hostile text now takes a few ms here: a
 * command over MAC_COMMAND_MAX is a card in every mode without deep analysis. Just under the cap it is analysed in
 * full, in linear time. The budgets are generous (CI-safe) but far below what a quadratic check takes at these sizes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, MAC_COMMAND_MAX, type LocalExecRequest } from "@synapse/shared";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate433-"));
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gate433-home-")));
fs.mkdirSync(path.join(home, "Projects"));
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

const policy = new LocalPolicyStore(dir, Date.now, Buffer.alloc(32, 7), { home: () => home, userData: () => path.join(home, "Library", "Application Support", "Synapse") });
policy.update({ localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
policy.setBotMode("ask-bot", "ask");
policy.setBotMode("auto-bot", "full-auto");
policy.setBotMode("free-bot", "full-auto");
policy.setNoLimits("free-bot", true);
const BOTS = ["ask-bot", "auto-bot", "free-bot"];

const UNITS = [
  "subprocess.run([\"", "\"", "'", "`", "(", "[", "{", "\\", "\\\"", "$(", "${(", "<<EOF\n", "a", "a/", ";", "|",
  "osascript ", "curl ", "rsync ", "git ", "python3 | ", "os.system('", ".send(\"", "OrbStack.app/Contents/MacOS/", "docker ",
];
const PREFIXES = ["", "osascript -e 'tell application \"Messages\" to send \"hi\" to participant \"x\"' ", "eval ", "sh -c \""];
const hostile = (unit: string, prefix: string, size: number) => (prefix + unit.repeat(Math.ceil(size / unit.length))).slice(0, size);
const req = (botId: string, command: string): LocalExecRequest => ({ execId: "x", botId, approvalId: null, op: "run-command", command, cwd: path.join(home, "Projects") });
const time = (f: () => unknown): number => { const t = performance.now(); f(); return performance.now() - t; };

describe("bug 433: the Mac gate on huge hostile commands", () => {
  it("1 MB of each hostile shape: a card (never allowed) in every mode, each decision well under the budget", () => {
    let worst = 0;
    let at = "";
    for (const p of PREFIXES) for (const u of UNITS) for (const bot of BOTS) {
      const command = hostile(u, p, 1024 * 1024);
      let v: ReturnType<LocalPolicyStore["check"]> | null = null;
      const ms = time(() => { v = policy.check(req(bot, command)); });
      expect(v).toMatchObject({ ok: false });
      expect((v as unknown as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL), `${bot} ${JSON.stringify(p + u)}`).toBe(true);
      if (ms > worst) { worst = ms; at = `${bot} ${JSON.stringify(p + u)}`; }
    }
    if (process.env.BUG433_LOG) process.stderr.write(`BUG433 gate 1MB worst ${worst.toFixed(1)}ms ${at}\n`);
    // About 200 ms is the target on a dev Mac (a few ms in practice); a 10 s regression can't pass.
    expect(worst, `slowest: ${at}`).toBeLessThan(1000);
  }, 600_000);

  it("just over the cap: needs this call's own approval even in Full auto and No limits", () => {
    const command = `echo ok; ${"a".repeat(MAC_COMMAND_MAX)}`;
    for (const bot of BOTS) {
      const v = policy.check(req(bot, command));
      expect(v).toMatchObject({ ok: false });
      expect((v as { reason: string }).reason).toContain("too long to check ahead of time");
    }
    expect(policy.check(req("auto-bot", "echo ok"))).toMatchObject({ ok: true });
  });

  it("just under the cap, analysed in full: each decision stays in linear time", () => {
    let worst = 0;
    let at = "";
    for (const p of PREFIXES) for (const u of UNITS) {
      const command = hostile(u, p, MAC_COMMAND_MAX - 1024);
      const ms = time(() => policy.check(req("auto-bot", command)));
      if (ms > worst) { worst = ms; at = JSON.stringify(p + u); }
    }
    if (process.env.BUG433_LOG) process.stderr.write(`BUG433 gate 255KB worst ${worst.toFixed(1)}ms ${at}\n`);
    expect(worst, `slowest: ${at}`).toBeLessThan(4000);
  }, 600_000);
});
