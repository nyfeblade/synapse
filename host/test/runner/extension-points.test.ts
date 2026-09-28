import path from "node:path";
import { describe, expect, it } from "vitest";
import { isEntryId, type AgentMessageEntry } from "@synapse/shared";
import { z } from "zod";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
// Strict TS (Controller ruling): ModelMessage is a { text } | { image } union; messageText() narrows
// it instead of a raw `.text` access, the same minimal-cast pattern used for Response.json() elsewhere.
import { messageText } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { HIDDEN_MARKER } from "../../runner/prompt-collector";
import { TurnRunner, type ApprovalGateLike, type RunnerDeps } from "../../runner/turn-runner";
import type { TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

function setup(script: FakeScript, extra: Partial<RunnerDeps> = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const runner = new TurnRunner({
    cfg, bots, presence, settings, trays: new TrayService(hub),
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 10_000, retryBaseMs: 1 }, ...extra,
  });
  const brains = new Map<string, FakeBrain>();
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => { const b = new FakeBrain(id, runner.wiring(id), script); brains.set(id, b); return b; },
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  return { cfg, bots, runner, id, brains };
}

const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });

describe("TurnRunner extension points (Task 2)", () => {
  it("enqueueWake runs a hidden turn with its context, lazily built prompt, and start/settle callbacks", async () => {
    const seen: TurnSlot[] = [];
    const s = setup(() => [{ tool: "mcp__bot__Probe", input: {} }]);
    s.runner.registerToolProvider((botId, slot) => [{
      name: "Probe", description: "test", readOnly: true, schema: {},
      handler: async () => { seen.push(slot()!); return { text: `ctx=${slot()?.context.routineRun?.routineId}` }; },
    }]);
    let built = 0;
    const events: string[] = [];
    s.runner.enqueueWake(s.id, {
      source: "routine", lane: "background", silenceAllowed: true,
      context: { routineRun: { routineId: "morning", runId: "run1", startedAt: 1 } },
      prompt: () => { built++; return [{ text: "[routine] \"Morning\" is due" }]; },
      onStart: () => events.push("start"),
      onSettle: (_slot, r) => events.push(`settle:${r ? "ok" : "none"}`),
    });
    await until(() => events.includes("settle:ok"));
    expect(built).toBe(1);
    expect(events).toEqual(["start", "settle:ok"]);
    expect(seen[0]?.context.routineRun?.routineId).toBe("morning");
    const input = s.brains.get(s.id)!.inputs[0]!;
    expect(input.hidden).toBe(true);
    expect(input.source).toBe("routine");
    // [0] is the per-turn clock (bug #50); the wake's own first message still carries the marker.
    expect(messageText(input.prompt[0]!)).toMatch(/^<system_reminder>Now: /);
    expect(messageText(input.prompt[1]!).startsWith(HIDDEN_MARKER)).toBe(true);
  });

  it("provider tools replace base tools with the same name", () => {
    const s = setup(() => []);
    s.runner.registerToolProvider(() => [{ name: "UpdateAgent", description: "v2", readOnly: false, schema: {}, handler: async () => ({ text: "v2" }) }]);
    const names = s.runner.wiring(s.id).botTools().map((t) => t.name);
    expect(names.filter((n) => n === "UpdateAgent")).toHaveLength(1);
    expect(s.runner.wiring(s.id).botTools().find((t) => t.name === "UpdateAgent")!.description).toBe("v2");
  });

  it("update_state delegates registered targets and keeps routine fields in its schema", async () => {
    const s = setup(() => [{ tool: "mcp__bot__update_state", input: { target: "routine", action: "create", name: "Digest", prompt: "Sum up", schedule: "every day at 8am" } }, send("done")]);
    const got: Record<string, unknown>[] = [];
    s.runner.registerStateTarget("routine", async (_b, _slot, args) => { got.push(args); return { text: "Saved routine" }; });
    const tool = s.runner.wiring(s.id).botTools().find((t) => t.name === "update_state")!;
    const parsed = z.object(tool.schema).parse({ target: "routine", action: "create", id: "digest", prompt: "p", schedule: "0 8 * * *", enabled: true, trigger: { webhook: {} } });
    expect(parsed).toMatchObject({ id: "digest", prompt: "p", schedule: "0 8 * * *", enabled: true, trigger: { webhook: {} } });
    expect(z.object(tool.schema).parse({ target: "account_settings", action: "set", user_time_zone: "Europe/Paris" })).toMatchObject({ user_time_zone: "Europe/Paris" });
    s.runner.sendPrompt(s.id, "make a routine", "n1");
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ target: "routine", name: "Digest", schedule: "every day at 8am" });
  });

  it("send routers take SendMessage before the default text path", async () => {
    const s = setup(() => [{ tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: "Q?", options: [] } } }]);
    const routed: string[] = [];
    s.runner.registerSendRouter((_b, _slot, args) => (args.type === "widget" ? Promise.resolve((routed.push("widget"), { text: "Widget sent." })) : null));
    s.runner.sendPrompt(s.id, "ask me", "n1");
    await until(() => routed.length === 1);
  });

  it("observers see turn start, the first visible write exactly once, and settle", async () => {
    const s = setup(() => [send("one"), send("two")]);
    const log: string[] = [];
    s.runner.addObserver({
      onTurnStart: (_b, slot) => log.push(`start:${slot.source}`),
      onBeforeFirstVisible: (b) => { log.push("first-visible"); s.bots.appendEntry(b, { kind: "event", id: s.bots.auxEntryIds(b, 1)[0]!, createdAt: 1, event: { type: "wake-origin", source: "agent", botIds: ["x"] } }); },
      onSettle: () => log.push("settle"),
    });
    s.runner.enqueueWake(s.id, { source: "agent", lane: "agent", silenceAllowed: true, prompt: () => [{ text: "[agent] 1 message" }] });
    await until(() => log.includes("settle"));
    expect(log).toEqual(["start:agent", "first-visible", "settle"]);
    const kinds = s.bots.tail(s.id, 20).map((e) => e.kind);
    expect(kinds.indexOf("event", 1)).toBeLessThan(kinds.indexOf("send-message"));
  });

  it("post-tool hooks add context; prompt decorators go above for silence-allowed wakes and before the reply reminder for user turns", async () => {
    const s = setup(() => [send("ok")]);
    s.runner.addPostToolHook((_b, _slot, call) => (call.toolName === "Bash" ? "30 minutes passed." : null));
    const out = await s.runner.wiring(s.id).postToolUse({ toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" }, "a b");
    expect(out.additionalContext ?? "").toContain("30 minutes passed.");
    s.runner.addPromptDecorator(() => ({ text: "<system_reminder>STATUS</system_reminder>" }));
    s.runner.enqueueWake(s.id, { source: "routine", lane: "background", silenceAllowed: true, prompt: () => [{ text: "routine body" }] });
    await until(() => (s.brains.get(s.id)?.inputs.length ?? 0) === 1);
    const w = s.brains.get(s.id)!.inputs[0]!.prompt.map(messageText);
    const status = w.findIndex((t) => t.includes("STATUS"));
    expect(status).toBeGreaterThanOrEqual(0);
    expect(status).toBeLessThan(w.findIndex((t) => t.includes("routine body"))); // above the wake's body
    s.runner.sendPrompt(s.id, "hello", "n2");
    await until(() => s.brains.get(s.id)!.inputs.length === 2);
    const p = s.brains.get(s.id)!.inputs[1]!.prompt;
    expect(messageText(p[p.length - 2]!)).toContain("STATUS");
  });

  it("reports recipient state, counts and drops queued wakes, and never priority-interrupts a user-lane turn", async () => {
    const s = setup(() => [{ wait: 200 }, send("ok")]);
    expect(s.runner.recipientState(s.id)).toBe("idle");
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => s.runner.recipientState(s.id) === "user");
    s.runner.enqueueWake(s.id, { id: "w1", source: "agent", lane: "agent", silenceAllowed: true, prompt: () => [{ text: "x" }] });
    expect(s.runner.queued(s.id, (t) => t.source === "agent")).toBe(1);
    expect(await s.runner.interruptForPriority(s.id, "priority")).toBe(false);
    s.runner.dropQueued(s.id, (t) => t.id === "w1");
    expect(s.runner.queued(s.id, () => true)).toBe(0);
  });

  it("tells a queued wake it was dropped when the user presses Stop", async () => {
    const s = setup(() => [{ wait: 300 }, send("ok")]);
    const dropped: string[] = [];
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => s.runner.recipientState(s.id) === "user");
    s.runner.enqueueWake(s.id, { source: "routine", lane: "background", silenceAllowed: true, prompt: () => [{ text: "[HIDDEN_PROMPT]\nroutine" }], onDropped: () => dropped.push("r1") });
    await s.runner.interruptAgent(s.id);
    expect(dropped).toEqual(["r1"]);
  });

  it("counts side effects and keeps agent entries out of the user's messages", async () => {
    const s = setup(() => [send("hi")]);
    let fx = -1;
    s.runner.addObserver({ onSettle: (_b, slot) => { fx = slot.context.sideEffects; } });
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => fx >= 0);
    expect(fx).toBe(1);
    const [aux] = s.bots.auxEntryIds(s.id, 1);
    expect(isEntryId(aux!)).toBe(true);
    const agent: AgentMessageEntry = { kind: "message", id: aux!, role: "user", content: "from Scout", chainId: "c_1", createdAt: 1, fromAgent: { id: "x", name: "Scout", kind: "request" } };
    s.bots.appendEntry(s.id, agent);
    expect(s.bots.userMessagesAfter(s.id, 0).map((m) => m.content)).toEqual(["hello"]);
    expect(new Set(s.bots.auxEntryIds(s.id, 3)).size).toBe(3);
  });

  it("counts a user burst folded into one turn as a coalesced burst (EVT-10, USE-05)", async () => {
    const bumps: string[] = [];
    const s = setup((_input, ctx) => (ctx.turnIndex === 0 ? [{ wait: 300 }, send("late")] : [send("both")]), { metrics: { bump: (_b, f) => { bumps.push(f); } } });
    s.runner.sendPrompt(s.id, "first", "n1");
    await until(() => (s.brains.get(s.id)?.inputs.length ?? 0) === 1);
    // Bug 198: only a stop interrupts a running turn now; a plain follow-up steers it instead.
    s.runner.sendPrompt(s.id, "stop", "n2");
    await until(() => (s.brains.get(s.id)?.inputs.length ?? 0) === 2);
    expect(bumps).toEqual(["coalescedTurns"]);
  });

  it("tells a Bot about Bot-list changes mid-turn (post-tool context) or else on its next prompt, once", async () => {
    const s = setup(() => [send("ok")]);
    const scout = s.bots.create({ origin: "user", kickstart: false, name: "Scout" });
    const out = await s.runner.wiring(s.id).postToolUse({ toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" }, "a b");
    expect(out.additionalContext ?? "").toContain(`<system_reminder>Your Bot list changed: added Scout (id: ${scout}).</system_reminder>`);
    const again = await s.runner.wiring(s.id).postToolUse({ toolName: "Bash", input: { command: "ls" }, toolUseId: "t2" }, "a b");
    expect(again.additionalContext ?? "").not.toContain("Bot list changed");
    s.bots.remove(scout);
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => (s.brains.get(s.id)?.inputs.length ?? 0) === 1);
    const texts = s.brains.get(s.id)!.inputs[0]!.prompt.map((m) => messageText(m));
    expect(texts.filter((t) => t.includes("Bot list changed"))).toEqual([`<system_reminder>Your Bot list changed: removed Scout (id: ${scout}).</system_reminder>`]);
  });
});
