import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp, type HostApp } from "../app";
import { classifyTool } from "../review/classify";
import { tmpConfig } from "./helpers";

/** Final integration: Phase 5 runs on the real Phase 2/3/4 host, not on the early base it was built against. */
let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });
const boot = async () => (app = await createHostApp(tmpConfig({ FUZZ: "1" })));

describe("Phase 2 context commands on the integrated host (Phase 5 Task 34 finding)", () => {
  it("getAgentContext, compactAgentNow and newAgentSession are Phase 2's real handlers", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Ctx", isKickstartRequested: false });
    const view = await a.handlers.getAgentContext!({ id });
    expect(view).toMatchObject({ window: 200000 });
    const compact = vi.spyOn(a.services.compactor, "compactNow");
    const roll = vi.spyOn(a.services.rollover, "rollNow");
    await a.handlers.compactAgentNow!({ id });
    await a.handlers.newAgentSession!({ id });
    expect(compact).toHaveBeenCalledWith(id, "user");
    expect(roll).toHaveBeenCalledWith(id, "user");
  });
});

describe("Usage on the integrated host", () => {
  it("getUsage is Phase 5's view and its efficiency tiles come from Phase 4's runtime metrics", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Eff", isKickstartRequested: false });
    const metrics = (a.services.phase4 as unknown as { mailbox: { d: { metrics: { bump(b: string, f: string): void } } } }).mailbox.d.metrics;
    metrics.bump(id, "dropped");
    metrics.bump(id, "coalescedTurns");
    const u = await a.handlers.getUsage!({});
    expect(u).toHaveProperty("level");
    expect(u.efficiency).toMatchObject({ dropped: 1, burstsCoalesced: 1 });
  });
});

describe("Phase 5's gate decorator on the one ApprovalGate", () => {
  it("forwards the call ctx (I2 cwd binding for child subagents) to the ApprovalGate", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Gate", isKickstartRequested: false });
    const seen: unknown[] = [];
    vi.spyOn(a.services.gate, "preToolUse").mockImplementation(async (_b, _c, ctx) => { seen.push(ctx); return { decision: "allow" }; });
    const wrapped = (a.services.runner as unknown as { gate: { preToolUse(b: string, c: unknown, ctx?: unknown): Promise<unknown> } }).gate;
    await wrapped.preToolUse(id, { toolName: "mcp__bot__Shell", input: { command: "ls" }, toolUseId: "t1" }, { childId: "child-1" });
    expect(seen).toEqual([{ childId: "child-1" }]);
  });

  it("plugin/connector MCP tools are classified onto the reviewed mcp surface", () => {
    const c = classifyTool({ toolName: "mcp__linear__create_issue", input: { title: "x" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host" });
    expect(c.surface).toBe("mcp");
    expect(c.sideEffect).toBe(true);
  });
});

describe("Phase 5's usage ladder gates Phase 4's routine fires (USE-03, USE-04)", () => {
  it("a scheduled fire is dropped as usage_paused while Claude's usage limit is hit", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Router", isKickstartRequested: false });
    const { routine } = await a.handlers.createAgentAutomation!({ id, name: "Sweep", prompt: "Sweep the inbox.", schedule: "0 8 * * *" });
    const rec = a.services.phase4.store.get(id, routine.id)!;
    a.services.phase5.ladder.noteLimitError("You've hit your usage limit. It resets in 3 hours.");
    const r = a.services.phase4.consumer.submit({ runId: "run-usage-1", botId: id, routineId: routine.id, trigger: "schedule", scheduledFor: Date.now(), defHash: rec.defHash });
    expect(r).toMatchObject({ accepted: false, reason: "usage_paused" });
  });
});
