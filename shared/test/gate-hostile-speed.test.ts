import { describe, expect, it } from "vitest";
import {
  MAC_COMMAND_MAX, SCRIPT_READS_MAX, evaluateFixedRules, fullAutoAsk, macDrivesSynapseUi, macExemptTool, macFloorHits, macOpaque,
  macPrivateStoreRead, macQuietHandoff, macSandboxExemptSimple, macSandboxInteractive, macUnsandboxedHandoff, messagesSend, parseShell,
  type PermContext,
} from "../src/index";

/**
 * Bug 433: a Bot could stall the Mac gate with a big hostile command (messagesSend took ~10.7 s on 300 KB of
 * `subprocess.run(["`). Every check the gate runs on command text is linear now, and a Mac command over
 * MAC_COMMAND_MAX is a card without deep analysis. The budgets are generous (CI-safe) but each is far below the
 * seconds a quadratic check takes at this size.
 */
const HOME = "/Users/me";
const ctx: PermContext = { home: HOME, projectDirs: ["/Users/me/proj"], userData: "/Users/me/Library/Application Support/Synapse", readScript: () => null };
const mac = (command: string, x: PermContext = ctx) => evaluateFixedRules({ side: "mac", kind: "command", command, cwd: "/Users/me/proj" }, x);

/** Repeated units that made a check backtrack or re-scan (quotes, brackets, backslashes, substitutions, heredocs …). */
const UNITS = [
  "subprocess.run([\"", "\"", "'", "`", "(", "[", "{", "\\", "\\\"", "$(", "${", "${(", "<<EOF\n", "cat <<EOF\n", "a", "a/", " ",
  ";", "|", "&", "osascript ", "curl ", "rsync ", "git ", "npm i ", "python3 | ", "a=(", "os.system('", ".send(\"", "whose name is \"",
  "OrbStack.app/Contents/MacOS/", "orb ", "docker ", "bash x.sh ", "sudo ", "env ",
];
const PREFIXES = ["", "osascript -e 'tell application \"Messages\" to send \"hi\" to participant \"x\"' ", "eval ", "sh -c \"", "python3 -c \"import os; os.system('docker ", "sh"];
const hostile = (unit: string, prefix: string, size: number) => prefix + unit.repeat(Math.ceil(size / unit.length));

/** The time one call takes, in ms. */
const time = (f: () => unknown): number => { const t = performance.now(); f(); return performance.now() - t; };

describe("bug 433: a Mac command too long to check is a card, never allowed or deferred", () => {
  const big = "echo ok; ".repeat(Math.ceil((MAC_COMMAND_MAX + 1) / 9));
  it("over the cap: always-ask ask.too-long, even for text that would otherwise be allowed", () => {
    expect(mac("echo ok").verdict).toBe("always-allow");
    expect(mac(big)).toMatchObject({ verdict: "always-ask", rule: "ask.too-long" });
  });
  it("at the cap: analysed as before", () => expect(mac(`cat ${"a".repeat(MAC_COMMAND_MAX - 4)}`).rule).toBe("allow.command"));
  it("the NEVER for the app's own data still runs on a too-long command", () => {
    expect(mac(`${big}cat ~/Library/Application\\ Support/Synapse/local-policy.key`)).toMatchObject({ verdict: "never", rule: "never.app-data" });
  });
  it("the box keeps its own gate (no cap there)", () => {
    expect(evaluateFixedRules({ side: "box", kind: "command", command: big, cwd: "/work" }, ctx).verdict).toBe("defer");
  });
  it("Full auto asks for a too-long Mac command, and No limits doesn't lift it", () => {
    const a = { kind: "command" as const, side: "mac" as const, command: big, cwd: "/Users/me/proj" };
    expect(fullAutoAsk(a, { home: HOME, workspaces: [] })).toMatchObject({ ask: true, rule: "security.too-long" });
    expect(fullAutoAsk(a, { home: HOME, workspaces: [], noLimits: true }).ask).toBe(true);
    expect(fullAutoAsk({ ...a, command: "echo ok" }, { home: HOME, workspaces: [] }).ask).toBe(false);
  });
});

describe("bug 433: a command naming more scripts than the gate reads is a card", () => {
  const reads: string[] = [];
  const x: PermContext = { ...ctx, readScript: (p) => { reads.push(p); return p.endsWith("/orb.sh") ? "orb list\n" : "echo hi\n"; } };
  it("past SCRIPT_READS_MAX scripts: always-ask ask.scripts-unchecked, with no more reads", () => {
    reads.length = 0;
    const cmd = Array.from({ length: SCRIPT_READS_MAX + 5 }, (_, i) => `bash s${i}.sh`).join("; ");
    expect(mac(cmd, x)).toMatchObject({ verdict: "always-ask", rule: "ask.scripts-unchecked" });
    expect(reads.length).toBe(SCRIPT_READS_MAX);
  });
  it("within the budget: read and judged as before", () => {
    expect(mac(Array.from({ length: SCRIPT_READS_MAX }, (_, i) => `bash s${i}.sh`).join("; "), x).rule).not.toBe("ask.scripts-unchecked");
    expect(mac("bash a.sh; bash orb.sh", x)).toMatchObject({ verdict: "never", rule: "never.orbstack" });
  });
});

describe("bug 433: every text check the Mac gate runs is linear on hostile input", () => {
  const hctx = { home: HOME, cwd: "/Users/me/proj" };
  const checks: [string, (s: string) => unknown][] = [
    ["parseShell", (s) => parseShell(s, { cwd: "/Users/me/proj", home: HOME })],
    ["messagesSend", (s) => messagesSend(s)],
    ["macFloorHits", (s) => macFloorHits(s)],
    ["macOpaque", (s) => macOpaque(s)],
    ["macSandboxInteractive", (s) => macSandboxInteractive(s)],
    ["macSandboxExemptSimple", (s) => macSandboxExemptSimple(s)],
    ["macExemptTool", (s) => macExemptTool(s)],
    ["macUnsandboxedHandoff", (s) => macUnsandboxedHandoff(s, hctx)],
    ["macQuietHandoff", (s) => macQuietHandoff(s, hctx)],
    ["macPrivateStoreRead", (s) => macPrivateStoreRead(s, hctx)],
    ["macDrivesSynapseUi", (s) => macDrivesSynapseUi(s)],
    ["fixed rules (Mac)", (s) => mac(s)],
    ["fixed rules (box)", (s) => evaluateFixedRules({ side: "box", kind: "command", command: s, cwd: "/work" }, ctx)],
    ["full auto (Mac)", (s) => fullAutoAsk({ kind: "command", side: "mac", command: s, cwd: "/Users/me/proj" }, { home: HOME, workspaces: [] })],
  ];
  // Just under the cap, so the Mac checks run in full. Quadratic checks took seconds (or minutes) here.
  const SIZE = MAC_COMMAND_MAX - 1024;
  it.each(checks)("%s: 256 KB of each hostile shape, each well under a second", (_name, f) => {
    let worst = 0;
    let at = "";
    for (const p of PREFIXES) for (const u of UNITS) {
      const ms = time(() => f(hostile(u, p, SIZE - p.length).slice(0, SIZE)));
      if (ms > worst) { worst = ms; at = JSON.stringify(p + u); }
    }
    if (process.env.BUG433_LOG) (globalThis as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`BUG433 ${_name} worst ${worst.toFixed(1)}ms ${at}\n`);
    expect(worst, `slowest: ${at}`).toBeLessThan(1500);
  }, 600_000);
  it("the original report: messagesSend on 300 KB and 1 MB of subprocess.run([\" is fast", () => {
    for (const size of [300 * 1024, 1024 * 1024]) {
      const s = "subprocess.run([\"".repeat(Math.ceil(size / 17));
      expect(time(() => messagesSend(s))).toBeLessThan(500);
      expect(time(() => messagesSend(`osascript -e 'tell application "Messages" to send ${s}'`))).toBeLessThan(500);
    }
  });
});
