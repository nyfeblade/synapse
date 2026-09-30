import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { executeGated, runToolBatch, type GateTicket } from "../../../brain/provider/tool-loop";
import { ToolRegistry } from "../../../brain/provider/tool-registry";
import type { BotToolDef, BrainWiring, PermissionDecision, PreToolDecision } from "../../../brain/types";

/**
 * Guard (spec §2 ToolLoop, §12.4): a provider Bot's tool handler runs ONLY in tool-loop.ts, and only after the gate
 * decided `allow` for that very call. Modelled on test/usage/metering-guard.test.ts: a source scan with no allowlist of
 * call sites, plus runtime checks that the executor refuses anything but a ticket the gate step minted.
 */
const HOST = path.resolve(__dirname, "../../..");
const PROVIDER = path.join(HOST, "brain", "provider");
const LOOP = path.join(PROVIDER, "tool-loop.ts");
const REGISTRY = path.join(PROVIDER, "tool-registry.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join(HOST, "test")) out.push(...sources(p)); }
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("handler guard: only ToolLoop runs a provider tool, and only through the gate", () => {
  it("no provider source outside tool-loop.ts calls a handler, and only tool-registry.ts touches one at all", () => {
    const offenders: string[] = [];
    for (const f of sources(PROVIDER)) {
      const src = strip(fs.readFileSync(f, "utf8"));
      if (f !== LOOP && /\bhandler(ForTicket)?\s*\(/.test(src.replace(/function handlerForTicket\(/, ""))) offenders.push(`${path.relative(HOST, f)}: calls a handler`);
      if (f !== REGISTRY && f !== LOOP && /\.handler\b/.test(src)) offenders.push(`${path.relative(HOST, f)}: reads .handler`);
    }
    expect(offenders).toEqual([]);
  });

  it("handlerForTicket is reachable from tool-loop.ts alone, anywhere in the host", () => {
    const users = sources(HOST).filter((f) => f !== REGISTRY && /\bhandlerForTicket\b/.test(strip(fs.readFileSync(f, "utf8")))).map((f) => path.relative(HOST, f));
    expect(users).toEqual([path.relative(HOST, LOOP)]);
  });

  it("tool-loop.ts calls the handler only inside executeGated, which the gate step feeds a freshly minted ticket", () => {
    const src = strip(fs.readFileSync(LOOP, "utf8"));
    expect(src.match(/handlerForTicket\(/g)).toHaveLength(1);
    const exec = src.slice(src.indexOf("export async function executeGated"), src.indexOf("function issuesText"));
    expect(exec).toContain("handlerForTicket(");
    expect(src.match(/mintTicket\(/g)).toHaveLength(2); // its definition and the one call, right after the gate's allow
    const raw = fs.readFileSync(LOOP, "utf8");
    const gateStep = raw.slice(raw.indexOf("// ---- the gate (steps 2–3) ----"), raw.indexOf("// ---- post (step 5) ----"));
    expect(gateStep.length).toBeGreaterThan(100);
    expect(gateStep).toMatch(/preToolUse[\s\S]*canUseTool[\s\S]*if \(denied !== null\)[\s\S]*mintTicket\([\s\S]*executeGated\(ticket/);
  });

  it("a registry entry carries no handler", () => {
    const def: BotToolDef = { name: "Shell", description: "d", schema: { command: z.string() }, readOnly: false, handler: async () => ({ text: "ran" }) };
    const t = ToolRegistry.forBotTools([def], "loose").fromWire("Shell")!;
    const reachable = (v: unknown, seen = new Set<unknown>()): boolean => {
      if (v === def.handler) return true;
      if (!v || typeof v !== "object" || seen.has(v)) return false;
      seen.add(v);
      return Object.values(v).some((x) => reachable(x, seen));
    };
    expect(reachable(t)).toBe(false);
  });

  it("the executor refuses a ticket the gate step did not mint", async () => {
    const forged = Object.freeze({ toolUseId: "x" }) as unknown as GateTicket;
    await expect(executeGated(forged, new AbortController().signal)).rejects.toThrow(/without the approval gate's decision/);
  });

  it("deny, ask→deny and defer never reach the handler; allow runs it once with the gate's updatedInput", async () => {
    const runs: unknown[] = [];
    const def: BotToolDef = { name: "Shell", description: "d", schema: { command: z.string() }, readOnly: false, handler: async (a) => { runs.push(a); return { text: "ran" }; } };
    const registry = ToolRegistry.forBotTools([def], "loose");
    const decisions: PreToolDecision[] = [
      { decision: "deny", reason: "no" },
      { decision: "ask", reason: "?" },
      { decision: "allow", updatedInput: { command: "safe" } },
      { decision: "defer", reason: "waiting" },
    ];
    const perms: PermissionDecision[] = [{ behavior: "deny", message: "user said no" }];
    const wiring: BrainWiring = {
      preToolUse: async () => decisions.shift()!, canUseTool: async () => perms.shift()!, postToolUse: async () => ({}), stop: async () => ({ block: false }),
      botTools: () => [def], flags: () => DEFAULT_FLAGS, turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    };
    let aborted = false;
    const out = await runToolBatch({ wiring, registry, emit: () => {}, signal: new AbortController().signal, abortTurn: () => { aborted = true; }, setInFlight: () => {} },
      [1, 2, 3, 4, 5].map((i) => ({ id: `c${i}`, wireName: "Shell", arguments: JSON.stringify({ command: `cmd${i}` }) })), "m1");
    expect(runs).toEqual([{ command: "safe" }]);
    expect(out.results.map((r) => [r.toolCallId, r.isError, r.text])).toEqual([
      ["c1", true, "no"], ["c2", true, "user said no"], ["c3", false, "ran"], ["c4", true, "waiting"],
      ["c5", true, "Not run: an earlier action in this message is waiting for the user's approval."],
    ]);
    expect(out.deferred).toBe(true);
    expect(aborted).toBe(true);
    expect(out.executed).toBe(1);
  });
});
