import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalGate, type ReviewerLike } from "../../../approvals/approval-gate";
import { BotService } from "../../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, ToolCall, TurnEvent } from "../../../brain/types";
import { SseHub } from "../../../gateway/sse-hub";
import { PresenceTracker } from "../../../presence/presence";
import type { ReviewOutcome } from "../../../review/types";
import { AckLedger } from "../../../runner/ack-ledger";
import { ResumeLedger } from "../../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../../runner/send-acceptance";
import { TurnRunner } from "../../../runner/turn-runner";
import { HostSettingsStore } from "../../../store/host-settings";
import { initLayout } from "../../../store/layout";
import { Supervisor } from "../../../supervisor/supervisor";
import { TrayService } from "../../../trays/trays";
import { startProviderRuntime } from "./runtime";
import { tmpConfig } from "../../helpers";

/**
 * One tiny LIVE run on Gemini's OpenAI-compatible endpoint (free tier: ~5 requests a minute, 20 a day per model):
 * a Bot turn whose one tool call goes through the real ApprovalGate. Off unless SYNAPSE_LIVE_GEMINI=1. The key is read
 * from ~/.config/synapse-dev/gemini.key at run time and never printed, logged or passed on a command line.
 */
const LIVE = process.env.SYNAPSE_LIVE_GEMINI === "1";
const MODEL = process.env.SYNAPSE_LIVE_GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

describe.skipIf(!LIVE)("Gemini live: one turn, one tool call through the gate", () => {
  it("calls the tool through the gate, gets the result, and replies with it", async () => {
    const key = fs.readFileSync(path.join(os.homedir(), ".config", "synapse-dev", "gemini.key"), "utf8").trim();
    // Through the provider proxy, as in the app: only the proxy holds the key.
    stops.push((await startProviderRuntime({ key })).stop);
    const cfg = tmpConfig();
    initLayout(cfg);
    const hub = new SseHub();
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const bots = new BotService({ cfg, hub, settings });
    const presence = new PresenceTracker(() => {});
    bots.setRuntimeView((i) => presence.view(i));
    const hp = (f: string) => path.join(cfg.hostPrivate, f);
    const events: TurnEvent[] = [];
    const ran: string[] = [];
    const shell: BotToolDef = {
      name: "Shell", description: "Run a shell command on your computer and return what it printed.", readOnly: false,
      schema: { command: z.string(), working_directory: z.string().optional(), block_until_ms: z.number().int().min(0).optional() },
      handler: async (a) => { ran.push(String(a.command)); return { text: "synapse-live-7291\n" }; }, // never a real shell
    };
    const runner = new TurnRunner({
      cfg, bots, trays: new TrayService(hub), presence, settings, flags: () => DEFAULT_FLAGS, acks: new AckLedger(hp("acks.json")),
      sendAcceptance: new SendAcceptanceLedger(hp("send.json")), resume: new ResumeLedger(hp("resume.json")), timings: { ackRedriveIdleMs: 600_000 },
      toolExtensions: { extraTools: () => [shell] },
      observers: [{ onEvent: (_b, e) => events.push(e) }],
    });
    const allow: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };
    const reviewer: ReviewerLike = { review: async () => allow, clearCache: () => {} };
    const gate = new ApprovalGate({ cfg, bots, settings, reviewer, flags: () => DEFAULT_FLAGS, slot: (i) => runner.slot(i), onDeferredResolution: () => {} });
    const decisions: string[] = [];
    const store = new ProviderSessionStore(cfg.hostPrivate);
    const supervisor = new Supervisor({
      caps: { maxLive: 2, maxRunning: 2, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, now: Date.now, onPreempt: () => {}, onCrashBackoff: () => {},
      brainFactory: (i) => new ProviderBrain({ botId: i, wiring: runner.wiring(i), store, getSessionId: () => bots.sessionId(i), maxModelCalls: 4 }),
    });
    runner.attach(supervisor, {
      preToolUse: async (b: string, c: ToolCall) => { const d = await gate.preToolUse(b, c); decisions.push(`${c.toolName}:${d.decision}`); return d; },
      canUseTool: (b: string, c: ToolCall, s: AbortSignal) => gate.canUseTool(b, c, s),
      expireAll: gate.expireAll.bind(gate), forgetBot: gate.forgetBot.bind(gate), pendingCount: gate.pendingCount.bind(gate),
    });
    const id = bots.create({ origin: "user", kickstart: false, name: "Gem" });
    (bots as unknown as { require(i: string): { profile: { model?: string } } }).require(id).profile.model = `gemini:${MODEL}`;
    const settled: { error?: unknown; usage: unknown; toolCallCount: number }[] = [];
    runner.addObserver({ onSettle: (_b, _s, r) => { if (r) settled.push({ error: r.error, usage: r.usage, toolCallCount: r.toolCallCount }); } });
    runner.sendPrompt(id, "Use the Shell tool to run exactly `cat token.txt` once. After you see its output, tell me exactly what it printed, using SendMessage. Be brief.", "n1");
    const t = Date.now() + 110_000;
    while (!(settled.length && runner.isIdle(id))) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); }
    const sent = bots.tail(id, 50).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
    // Printed for the report: decisions, model calls, usage. Never the key.
    console.log(JSON.stringify({ model: MODEL, decisions, ran, sent, error: settled[0]!.error ?? null, usage: settled[0]!.usage, toolCalls: settled[0]!.toolCallCount, retries: events.filter((e) => e.kind === "retry").length,
      messages: events.flatMap((e) => (e.kind === "tool_start" ? [`${e.messageId}:${e.name}`] : [])) }));
    expect(settled[0]!.error).toBeUndefined();
    expect(decisions[0]).toBe("mcp__bot__Shell:allow");
    expect(ran).toHaveLength(1);
    expect(sent.join(" ")).toContain("synapse-live-7291");
  }, 120_000);
});

describe.skipIf(!LIVE)("Gemini live: a SMALL safety-reviewer qualification sample (free tier; not a qualification)", () => {
  it("the provider reviewer blocks the must-block cases in a small sample", async () => {
    const { loadCases, runBench, judge } = await import("../../../review/qualification");
    const { HelperModelReviewer } = await import("../../../review/helper-model-reviewer");
    const key = fs.readFileSync(path.join(os.homedir(), ".config", "synapse-dev", "gemini.key"), "utf8").trim();
    stops.push((await startProviderRuntime({ key })).stop);
    const all = loadCases();
    // Model-stage cases only (the floor and fast path never reach the model): two must-blocks and one allow.
    const pick = ["E03", "E08", "E02"].map((id) => all.find((c) => c.id === id)!);
    const stats = await runBench(new HelperModelReviewer(`gemini:${MODEL}`), { cases: pick, runs: 1 });
    const r = stats.results[0]!;
    const summary = JSON.stringify({ model: MODEL, sample: r.map((x) => ({ id: x.id, expected: x.expected, decision: x.decision, stage: x.stage, error: x.error, ms: x.latencyMs })), judgement: judge(stats) });
    if (process.env.SYNAPSE_LIVE_REPORT) fs.writeFileSync(process.env.SYNAPSE_LIVE_REPORT, summary); // the numbers, never the key
    console.log(summary);
    expect(r.filter((x) => x.mustBlock && x.decision === "allow")).toEqual([]);
    expect(r.every((x) => !x.error)).toBe(true);
  }, 120_000);
});

describe.skipIf(!LIVE)("Gemini live: a TINY provider-conformance sample (PC-01, PC-02, PC-10)", () => {
  it("streams text, round-trips a tool, and classifies a bad key and a missing model", async () => {
    const { runConformance } = await import("../../../brain/provider/conformance/checks");
    const key = fs.readFileSync(path.join(os.homedir(), ".config", "synapse-dev", "gemini.key"), "utf8").trim();
    stops.push((await startProviderRuntime({ key })).stop);
    const probe = process.env.SYNAPSE_LIVE_ONLY ? process.env.SYNAPSE_LIVE_ONLY.split(",") : null;
    if (probe) {
      const p = await runConformance(`gemini:${MODEL}`, { only: probe });
      if (process.env.SYNAPSE_LIVE_REPORT) fs.writeFileSync(process.env.SYNAPSE_LIVE_REPORT, JSON.stringify(p.results.filter((x) => x.status !== "skip")));
      return;
    }
    const r = await runConformance(`gemini:${MODEL}`, { only: ["PC-01", "PC-02", "PC-10"] });
    const summary = JSON.stringify({ model: MODEL, results: r.results.filter((x) => x.status !== "skip").map(({ id, status, detail, ms }) => ({ id, status, detail, ms })) });
    if (process.env.SYNAPSE_LIVE_REPORT) fs.writeFileSync(process.env.SYNAPSE_LIVE_REPORT, summary);
    console.log(summary);
    expect(r.results.filter((x) => ["PC-01", "PC-02", "PC-10"].includes(x.id)).map((x) => x.status)).toEqual(["pass", "pass", "pass"]);
    expect(r.mustPass).toBe(false); // a sample never clears a model
  }, 120_000);
});
