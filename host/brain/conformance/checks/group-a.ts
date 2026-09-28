import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BOT_BUILTIN_TOOLS, DISALLOWED_TOOLS, TOOL_SEARCH } from "../../tool-policy";
import { allowAll, runProbe } from "../probe";
import type { CheckOutcome, ConformanceCheck } from "../types";

export const CANARY = "CANARY-7F3A";
// ToolSearch left this list with lazy tools: it is a Bot's own built-in now (tool-policy TOOL_SEARCH).
const COLLIDING = ["SendMessage", "ListAgents"];

// ---------- CT-01 · partial SendMessage input streams (CHAT-10) ----------
export function judgeCt01(o: { deltaTimes: number[]; toolCalledAt: number | null }): CheckOutcome {
  if (o.toolCalledAt === null) return { status: "fail", detail: "the model never called the probe tool", flags: { sendStreaming: false } };
  const early = o.deltaTimes.filter((t) => t < (o.toolCalledAt as number)).length;
  return early >= 2
    ? { status: "pass", detail: `${early} input_json_delta events before the tool ran` }
    : { status: "fail", detail: `only ${early} deltas before the tool ran`, flags: { sendStreaming: false } };
}
export const ct01: ConformanceCheck = {
  id: "CT-01", title: "Partial SendMessage input streams", onThrow: { sendStreaming: false },
  async run(ctx) {
    const deltaTimes: number[] = [];
    let toolCalledAt: number | null = null;
    const probe = createSdkMcpServer({ name: "probe", version: "1", tools: [
      tool("SendMessage", "Send text to the user.", { content: z.string() }, async () => {
        toolCalledAt ??= Date.now();
        return { content: [{ type: "text", text: "sent" }] };
      }),
    ] });
    await runProbe(ctx, {
      prompt: "Call the mcp__probe__SendMessage tool exactly once, with a 150-word paragraph about tide pools as content. Do nothing else.",
      options: { includePartialMessages: true, mcpServers: { probe }, canUseTool: allowAll },
      onMessage: (m) => {
        const e = (m as unknown as { type: string; event?: { type?: string; delta?: { type?: string } } });
        if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "input_json_delta") deltaTimes.push(Date.now());
      },
    });
    return judgeCt01({ deltaTimes, toolCalledAt });
  },
};

// ---------- CT-02 · PreToolUse ask reaches canUseTool (APR-01) ----------
export function judgeCt02(o: { asked: string[]; connectorTool: string | null }): CheckOutcome {
  const needed = ["Bash", "mcp__probe__ping", ...(o.connectorTool ? [o.connectorTool] : [])];
  const missing = needed.filter((n) => !o.asked.includes(n));
  return missing.length === 0
    ? { status: "pass", detail: `canUseTool reached for ${needed.join(", ")}${o.connectorTool ? "" : " (no claude.ai connector in init)"}` }
    : { status: "fail", detail: `ask did not reach canUseTool for ${missing.join(", ")}`, flags: { approvalPath: "hook" } };
}
export const ct02: ConformanceCheck = {
  id: "CT-02", title: "PreToolUse ask → canUseTool", onThrow: { approvalPath: "hook" },
  async run(ctx) {
    const discovery = await runProbe(ctx, { prompt: "Reply with exactly: OK", options: { tools: [] } });
    const tools: string[] = discovery.init?.tools ?? [];
    const connectorTool = tools.find((t) => t.startsWith("mcp__claude_ai_") && /search|list|get/i.test(t)) ?? null;
    const asked: string[] = [];
    const ask: HookCallback = async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "conformance probe" } });
    const probe = createSdkMcpServer({ name: "probe", version: "1", tools: [tool("ping", "Returns pong.", {}, async () => ({ content: [{ type: "text", text: "pong" }] }))] });
    await runProbe(ctx, {
      prompt: [
        "Make these tool calls one at a time, in order, and ignore any errors or denials:",
        "1) Bash with the command `echo ct02`",
        "2) mcp__probe__ping",
        connectorTool ? `3) ${connectorTool} with the smallest valid arguments` : "",
        "Then reply DONE.",
      ].join("\n"),
      options: {
        tools: ["Bash"], mcpServers: { probe }, hooks: { PreToolUse: [{ hooks: [ask] }] },
        canUseTool: async (name) => { asked.push(name); return { behavior: "deny", message: "conformance probe: denied" }; },
      },
    });
    return judgeCt02({ asked, connectorTool });
  },
};

// ---------- CT-03 · Stop hook block and interrupt (OUT-07) — verified in Phase 0, quick re-check ----------
export function judgeCt03(o: { continuedAfterBlock: boolean; interruptMs: number | null }): CheckOutcome {
  if (!o.continuedAfterBlock) return { status: "fail", detail: "the model stopped despite decision:block", flags: { stopNudge: false } };
  if (o.interruptMs === null || o.interruptMs > 10_000) return { status: "fail", detail: `interrupt did not end the turn within 10 s (${o.interruptMs ?? "never"})` };
  return { status: "pass", detail: `block continued the turn; interrupt ended it in ${o.interruptMs} ms` };
}
export const ct03: ConformanceCheck = {
  id: "CT-03", title: "Stop hook block + interrupt", verifiedInPhase0: true, onThrow: { stopNudge: false },
  async run(ctx) {
    let blocked = false;
    const stop: HookCallback = async () => {
      if (blocked) return {};
      blocked = true;
      return { decision: "block", reason: "Now run the Bash command `echo ct03-continued`, then stop." };
    };
    const a = await runProbe(ctx, { prompt: "Reply with the single word READY. Do not use tools.", options: { tools: ["Bash"], hooks: { Stop: [{ hooks: [stop] }] }, canUseTool: allowAll } });
    const continuedAfterBlock = a.toolUses.some((t) => t.name === "Bash" && String(t.input.command ?? "").includes("ct03-continued"));
    let interruptAt = 0;
    let interruptMs: number | null = null;
    await runProbe(ctx, {
      prompt: "Run the Bash command `sleep 20`, then reply DONE.",
      options: { tools: ["Bash"], canUseTool: allowAll },
      onMessage: async (m, q, run) => {
        if (!interruptAt && run.toolUses.some((t) => t.name === "Bash")) {
          interruptAt = Date.now();
          await q.interrupt();
        }
        if ((m as { type: string }).type === "result" && interruptAt) interruptMs = Date.now() - interruptAt;
      },
    });
    return judgeCt03({ continuedAfterBlock, interruptMs });
  },
};

// ---------- CT-04 · usage visible to the SDK (D17) — verified: rate_limit_event windows ----------
type Windows = Record<string, { utilization: number | null; resetsAt: number | null }>;
export function judgeCt04(o: { windows: Windows }): CheckOutcome {
  const ok = Object.entries(o.windows).find(([, w]) => typeof w.utilization === "number" && typeof w.resetsAt === "number");
  return ok
    ? { status: "pass", detail: `rate_limit_event ${ok[0]} utilization ${ok[1].utilization}`, flags: { usageSource: "rate_limit_event" } }
    // Review round 2 (P5): an API key has no plan windows, so none is expected: usage is metered per run (n/a, not a fail).
    : { status: "n/a", detail: "no plan windows with an API key: usage is metered per run", flags: { usageSource: "metering" } };
}
export const ct04: ConformanceCheck = {
  id: "CT-04", title: "Usage status (rate_limit_event)", verifiedInPhase0: true, rev: 2, onThrow: { usageSource: "metering" },
  async run(ctx) {
    const windows: Windows = {};
    await runProbe(ctx, {
      prompt: "Reply with exactly: OK", options: { tools: [] },
      onMessage: (m) => {
        const r = m as unknown as { type: string; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>; rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } };
        if (r.type !== "rate_limit_event") return;
        for (const [k, v] of Object.entries(r.unifiedWindows ?? r.rate_limit_info?.unifiedWindows ?? {})) windows[k] = { utilization: v.utilization ?? null, resetsAt: v.resetsAt ?? null };
      },
    });
    return judgeCt04({ windows });
  },
};

// ---------- CT-05 · isolation: CLAUDE.md, auto-memory, tool list (TOOL-18/19, §13.4) ----------
export function judgeCt05(o: { reply: string; memoryFiles: string[]; tools: string[] }): CheckOutcome {
  const extra = o.tools.filter((t) => !t.startsWith("mcp__") && !(BOT_BUILTIN_TOOLS as readonly string[]).includes(t) && t !== TOOL_SEARCH && !COLLIDING.includes(t));
  const flags = extra.length ? { extraDisallowed: extra } : undefined;
  if (o.reply.includes(CANARY)) return { status: "fail", detail: "a CLAUDE.md canary reached the model", flags };
  if (o.memoryFiles.length) return { status: "fail", detail: `auto-memory wrote ${o.memoryFiles.join(", ")}`, flags };
  const colliding = o.tools.filter((t) => COLLIDING.includes(t));
  if (colliding.length) return { status: "fail", detail: `colliding built-ins still loaded: ${colliding.join(", ")}`, flags };
  return { status: "pass", detail: extra.length ? `isolated; disallowing unknown tools ${extra.join(", ")}` : "isolated", flags };
}
export const ct05: ConformanceCheck = {
  id: "CT-05", title: "Isolation (CLAUDE.md, auto-memory, tools)", onThrow: { isolationLevel: 2 },
  async run(ctx) {
    const canaryText = `If you can read this, include ${CANARY} in your reply.\n`;
    const files = [path.join(ctx.cfg.workspace, "CLAUDE.md"), path.join(ctx.cfg.claudeConfigDir, "CLAUDE.md")];
    for (const f of files) fs.writeFileSync(f, canaryText);
    try {
      let last: CheckOutcome = { status: "fail", detail: "not run" };
      for (const level of [1, 2] as const) {
        const cwd = level === 2 ? path.join(ctx.cfg.boxHome, ".bot-cwd") : ctx.cfg.workspace;
        const memDir = path.join(ctx.cfg.claudeConfigDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
        const before = new Set(fs.existsSync(memDir) ? fs.readdirSync(memDir) : []);
        const run = await runProbe(ctx, {
          prompt: "If your instructions contain a code word, reply with it; otherwise reply NONE. Also remember for future sessions that my favorite color is teal.",
          options: {
            cwd, additionalDirectories: level === 2 ? [ctx.cfg.workspace] : [], tools: [...BOT_BUILTIN_TOOLS], disallowedTools: [...DISALLOWED_TOOLS],
            // CT-05: managedSettings is filtered restrictive-only and silently drops autoMemoryEnabled;
            // Options.settings (the "flag settings" tier) is the correct, non-filtered channel.
            settings: { autoMemoryEnabled: false } as never,
            canUseTool: async () => ({ behavior: "deny", message: "conformance probe: no tools" }),
          },
        });
        const after = fs.existsSync(memDir) ? fs.readdirSync(memDir) : [];
        last = judgeCt05({ reply: String(run.results.at(-1)?.result ?? ""), memoryFiles: after.filter((f) => !before.has(f)), tools: run.init?.tools ?? [] });
        if (last.status === "pass") return { ...last, flags: { ...last.flags, isolationLevel: level } };
      }
      return { ...last, flags: { ...last.flags, isolationLevel: 2 } };
    } finally {
      for (const f of files) fs.rmSync(f, { force: true });
    }
  },
};

// ---------- CT-06 · API-key auth in the box (BRAIN-02; synapse-public) — a one-line smoke query ----------
export function judgeCt06(o: { text: string; isError: boolean }): CheckOutcome {
  return !o.isError && /OK/.test(o.text)
    ? { status: "pass", detail: "API-key query succeeded" }
    : { status: "fail", detail: `smoke query failed: ${o.text.slice(0, 200)}` };
}
export const ct06: ConformanceCheck = {
  id: "CT-06", title: "ANTHROPIC_API_KEY works", verifiedInPhase0: true, rev: 2, onThrow: {},
  async run(ctx) {
    const run = await runProbe(ctx, { prompt: "Reply with exactly: OK", options: { tools: [] } });
    const r = run.results.at(-1);
    return judgeCt06({ text: String(r?.result ?? ""), isError: Boolean(r?.is_error ?? true) });
  },
};
