import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../../approvals/approval-gate";
import { createChildWiring } from "../../../background/child-wiring";
import { BotService } from "../../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { FakeBrain, type FakeStep } from "../../../brain/fake-brain";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, ToolCall, TurnEvent } from "../../../brain/types";
import { createComputerTool } from "../../../computer/computer-tool";
import { DisplayManager } from "../../../computer/displays";
import { FakeDisplayControl, fakeXExec } from "../../../computer/fuzz-fakes";
import { createReadScreenTool, type ScreenReader } from "../../../computer/screen-read";
import type { Exec } from "../../../computer/x-exec";
import { SseHub } from "../../../gateway/sse-hub";
import type { ReviewOutcome } from "../../../review/types";
import { outsideLog } from "../../../review/outside-log";
import { newSlot } from "../../../runner/turn-slot";
import { HostSettingsStore } from "../../../store/host-settings";
import { initLayout } from "../../../store/layout";
import { setProviderRuntime } from "../../../usage/metered-provider";
import { tmpConfig } from "../../helpers";
import { finish, startFakeChatServer, textChunks, toolChunks, usageChunk, type FakeReply } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

/**
 * Gate parity for the computer and browser helpers: the SAME scripted screen actions, made by a child on the Claude
 * path (FakeBrain, the tools served as mcp__computer__* as the Claude child's `computer` MCP server serves them) and by
 * a child on ProviderBrain (the tools as `serverTools`, driven by a fake Chat Completions server), through the REAL
 * ApprovalGate behind the real child wiring, must give identical gate decisions, cards, tool results, xdotool runs and
 * outside-content fencing.
 */
type Call = { name: string; input: Record<string, unknown> };
type Msg = { calls: Call[] } | { text: string };

const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Types into a payment form.", proposedRule: "", verdict: { decision: "block", risk_tier: 2, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: [], injection_suspected: false, confidence: 0.8, reason: "Types into a payment form.", proposed_allow_rule: "" } };
const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };
const reviewBy = (req: string): ReviewOutcome => (req.includes("4111") ? BLOCK : ALLOW);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { setProviderRuntime(null); for (const c of closers.splice(0)) await c(); });

interface Observed { gate: string[]; cards: unknown[]; toolEnds: { name: string; isError: boolean; output: string }[]; xdotool: string[]; images: number; outside: string[]; report: string }

async function run(kind: "claude" | "provider", msgs: Msg[], o: { enforce?: boolean; act?: (h: { cards(): Record<string, unknown>[]; resolve(id: string, c: "once" | "deny"): void }) => Promise<void> } = {}): Promise<Observed> {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const parent = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const reviewer: ReviewerLike = { review: async (req) => reviewBy(JSON.stringify(req)), clearCache: () => {} };
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, flags: () => DEFAULT_FLAGS, slot: () => null, onDeferredResolution: () => {} });
  const gateLog: string[] = [];
  const recording = {
    preToolUse: async (b: string, c: ToolCall, ctx?: Parameters<ApprovalGate["preToolUse"]>[2]) => { const d = await gate.preToolUse(b, c, ctx); gateLog.push(`pre ${c.toolName} ${JSON.stringify(c.input)} → ${JSON.stringify(d)}`); return d; },
    canUseTool: async (b: string, c: ToolCall, s: AbortSignal, ctx?: Parameters<ApprovalGate["canUseTool"]>[3]) => { const d = await gate.canUseTool(b, c, s, ctx); gateLog.push(`can ${c.toolName} → ${JSON.stringify(d)}`); return d; },
    expireAll: gate.expireAll.bind(gate), forgetBot: gate.forgetBot.bind(gate), pendingCount: gate.pendingCount.bind(gate),
  };
  // The real Computer tool on a fake display: every xdotool run is recorded.
  const xdotool: string[] = [];
  const exec: Exec = async (file, args, opts) => { if (file === "xdotool" && args[0] !== "getmouselocation") xdotool.push(args.join(" ")); return fakeXExec(file, args, opts); };
  const displays = new DisplayManager({ cfg, control: new FakeDisplayControl(), hub, exec, now: () => 1_700_000_000_000 });
  const reader: ScreenReader = {
    read: async () => ({ at: 0, windows: [{ key: "w", title: "Checkout - Chromium", role: "frame", app: "chromium", active: true, b: { x: 0, y: 0, w: 1280, h: 800 }, src: "desk" }], els: [{ key: "b", role: "button", name: "Pay now", states: [], b: { x: 600, y: 380, w: 80, h: 40 }, win: "w" }] }),
    ocr: async () => [{ text: "Questions? billing@shop.example", b: { x: 100, y: 700, w: 300, h: 20 } }],
  };
  const tools: BotToolDef[] = [
    createComputerTool({ botId: parent, displays, hub, workspace: cfg.workspace, enforce: () => o.enforce ?? true, now: () => 1_700_000_000_000, sleep: async () => {} }),
    createReadScreenTool({ reader: async () => reader, view: { w: 1280, h: 800 } }),
  ];
  const slot = newSlot({ botId: parent, requestId: "child:c1", turnNo: 1, lane: "background", source: "subagent-done", hidden: true, silenceAllowed: true, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: Date.now() });
  const onProvider = kind === "provider";
  const wiring = createChildWiring({ parentBotId: parent, childId: "c1", slot: () => slot, gate: recording, tools: onProvider ? [] : tools, flags: () => DEFAULT_FLAGS });
  const toolEnds: Observed["toolEnds"] = [];
  const sink = (e: TurnEvent) => { if (e.kind === "tool_end") toolEnds.push({ name: e.name, isError: e.isError, output: e.output.replace(/ \[\d+ image\]/g, "") }); };
  let seq = 0;
  let server: Awaited<ReturnType<typeof startFakeChatServer>> | null = null;
  if (onProvider) {
    server = await startFakeChatServer((req): FakeReply => {
      const k = (req.body.messages as { role: string }[]).filter((x) => x.role === "assistant").length;
      const step = msgs[k];
      if (!step) return { sse: [finish("stop"), usageChunk(10, 1)] };
      if ("text" in step) return { sse: [...textChunks(step.text), finish("stop"), usageChunk(10, 1)] };
      return { sse: [...toolChunks(step.calls.map((c) => ({ id: `call_${++seq}`, name: c.name, args: c.input }))), finish("tool_calls"), usageChunk(10, 1)] };
    });
    const srv = server;
    closers.push(() => srv.close());
    const rt = await startProviderRuntime({ upstream: server.url });
    closers.push(rt.stop);
  }
  const brain = onProvider
    ? new ProviderBrain({
      botId: "child:c1", storeKey: parent, wiring, store: new ProviderSessionStore(cfg.hostPrivate), getSessionId: () => null, sleep: async () => {},
      systemPrompt: () => "You are a computerUse subagent.", serverTools: () => tools.map((def) => ({ canonical: `mcp__computer__${def.name}`, def })),
    })
    : new FakeBrain("child:c1", wiring, () => msgs.map((mm): FakeStep => ("text" in mm ? { text: mm.text } : mm.calls.length === 1 ? { tool: `mcp__computer__${mm.calls[0]!.name}`, input: mm.calls[0]!.input } : { parallel: mm.calls.map((c) => ({ tool: `mcp__computer__${c.name}`, input: c.input })) })));
  const cards = () => bots.tail(parent, 200).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as unknown as { approval: Record<string, unknown> }).approval);
  const turn = brain.runTurn({ prompt: [{ text: "Pay the invoice." }], hidden: true, lane: "background", source: "subagent-done", silenceAllowed: true, requestId: "child:c1", systemAppend: "", model: onProvider ? "openai:gpt-parity" : "claude-sonnet-5", autoReviewEpoch: "continue" }, sink);
  if (o.act) await o.act({ cards, resolve: (id, c) => gate.resolve(parent, id, c) });
  const r = await turn;
  // Images the provider model got back: the follow-up user messages carrying the tools' screenshots, in the last request.
  const last = (server?.requests.at(-1)?.body.messages ?? []) as { role: string; content: unknown }[];
  const images = last.filter((x) => x.role === "user" && Array.isArray(x.content)).flatMap((x) => x.content as { type: string }[]).filter((p) => p.type === "image_url").length;
  const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (["approvalId", "createdAt", "settledAt", "expiresAt", "requestId", "at"].includes(k) ? undefined : x)));
  const norm = (s: string) => s.replace(/(toolu_fake_\d+|call_\d+)/g, "TU").split(cfg.workspace).join("<W>").split(parent).join("<BOT>");
  return {
    gate: gateLog.map(norm), cards: strip(cards()) as unknown[], toolEnds: toolEnds.map((t) => ({ ...t, output: norm(t.output) })), xdotool,
    images, outside: [...outsideLog.since(parent, 0).emails].sort(), report: r.finalText,
  };
}

async function both(msgs: Msg[], o: Parameters<typeof run>[2] = {}) {
  const claude = await run("claude", msgs, o);
  const provider = await run("provider", msgs, o);
  return { claude, provider };
}
const sameButImages = (x: Observed) => ({ ...x, images: 0 });
const waitFor = async (f: () => boolean, ms = 5000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

describe("computer helper gate parity: the Claude path and the provider path, same scripted actions", () => {
  it("a screenshot and a described click: the same gate decisions, the same xdotool runs, a screenshot back", async () => {
    const msgs: Msg[] = [
      { calls: [{ name: "Computer", input: { action: "screenshot" } }] },
      { calls: [{ name: "Computer", input: { action: "click", x: 640, y: 400, description: "Open the invoice" } }] },
      { calls: [{ name: "Computer", input: { action: "double_click", x: 100, y: 120, description: "Open the file" } }] },
      { text: "Report: opened the invoice." },
    ];
    const { claude, provider } = await both(msgs);
    expect(sameButImages(provider)).toEqual(sameButImages(claude));
    expect(claude.xdotool).toEqual(["mousemove --sync 640 400", "click --repeat 1 --delay 80 1", "mousemove --sync 100 120", "click --repeat 2 --delay 80 1"]);
    expect(claude.toolEnds.every((t) => t.name === "mcp__computer__Computer" && !t.isError)).toBe(true);
    expect(claude.cards).toEqual([]);
    expect(provider.images).toBe(3); // each result's screenshot reached the provider model (as a follow-up user message)
    expect(provider.report).toBe("Report: opened the invoice.");
  });

  it("a click with no description is refused before any review (Auto-review on), identically", async () => {
    const { claude, provider } = await both([{ calls: [{ name: "Computer", input: { action: "click", x: 5, y: 5 } }] }, { text: "done" }]);
    expect(sameButImages(provider)).toEqual(sameButImages(claude));
    expect(claude.xdotool).toEqual([]);
    expect(claude.gate[0]).toContain("\"decision\":\"deny\"");
  });

  it("the reviewer blocks typing a card number: the same card; denied, nothing is typed", async () => {
    const act = async (h: { cards(): Record<string, unknown>[]; resolve(id: string, c: "once" | "deny"): void }) => {
      await waitFor(() => h.cards().some((c) => c.status === "pending"));
      h.resolve(h.cards().at(-1)!.approvalId as string, "deny");
    };
    const { claude, provider } = await both([{ calls: [{ name: "Computer", input: { action: "type", text: "4111 1111 1111 1111" } }] }, { text: "stopped" }], { act });
    expect(sameButImages(provider)).toEqual(sameButImages(claude));
    expect(claude.cards).toHaveLength(1);
    expect(claude.cards[0]).toMatchObject({ status: "denied", reason: "Types into a payment form." });
    expect(claude.xdotool).toEqual([]);
    expect(claude.toolEnds[0]).toMatchObject({ name: "mcp__computer__Computer", isError: true, output: expect.stringMatching(/^The user declined/) });
  });

  it("allowed once, it types; the text read of the screen is fenced as outside content and logged, identically", async () => {
    const act = async (h: { cards(): Record<string, unknown>[]; resolve(id: string, c: "once" | "deny"): void }) => {
      await waitFor(() => h.cards().some((c) => c.status === "pending"));
      h.resolve(h.cards().at(-1)!.approvalId as string, "once");
    };
    const msgs: Msg[] = [
      { calls: [{ name: "ReadScreen", input: { ocr: true } }] },
      { calls: [{ name: "Computer", input: { action: "type", text: "4111 1111 1111 1111" } }] },
      { text: "paid" },
    ];
    const { claude, provider } = await both(msgs, { act });
    expect(sameButImages(provider)).toEqual(sameButImages(claude));
    expect(claude.toolEnds[0]!.output).toMatch(/^<untrusted_data source="mcp__computer__ReadScreen">/);
    expect(claude.toolEnds[0]!.output).toContain('button "Pay now" at (640, 400)');
    expect(claude.outside).toEqual(["billing@shop.example"]);
    expect(claude.xdotool).toEqual(["type --delay 12 -- 4111 1111 1111 1111"]);
    expect(claude.cards[0]).toMatchObject({ status: "approved" });
  });
});

