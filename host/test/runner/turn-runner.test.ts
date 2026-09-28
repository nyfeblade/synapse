import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS, type ConformanceFlags } from "../../brain/conformance/flags";
import { FakeBrain, type FakeBrainOptions, type FakeScript } from "../../brain/fake-brain";
import { messageText } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import type { SettledTurn } from "../../runner/observers";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike, type RunnerDeps } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

function setup(script: FakeScript, flags: Partial<ConformanceFlags> = {}, extra: Partial<RunnerDeps> = {}, brainOpts: FakeBrainOptions = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const trays = new TrayService(hub);
  const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
  const runner = new TurnRunner({
    cfg, bots, acks, trays, presence, settings,
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => ({ ...DEFAULT_FLAGS, ...flags }),
    timings: { ackRedriveIdleMs: 20, retryBaseMs: 1 },
    ...extra,
  });
  const brains = new Map<string, FakeBrain>();
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => { const b = new FakeBrain(id, runner.wiring(id), script, brainOpts); brains.set(id, b); return b; },
  });
  const expired: string[] = [];
  const gate: ApprovalGateLike = {
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }),
    expireAll: (id, cause) => expired.push(`${id}:${cause}`), forgetBot: () => {},
  };
  runner.attach(supervisor, gate);
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const sends = () => bots.tail(id, 100).filter((e) => e.kind === "send-message").map((e) => (e as { message: { content: string } }).message.content);
  return { cfg, bots, runner, id, brains, acks, trays, events, expired, sends, settings };
}

const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });

describe("engineering mode turns work quietly (coding-parity)", () => {
  it("marks an engineering Bot's turn quietWork, and a standard Bot's not", async () => {
    const s = setup(() => [send("done")]);
    const seen: (boolean | undefined)[] = [];
    s.runner.addObserver({ onTurnStart: (_id, slot) => seen.push(slot.quietWork) });
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => s.sends().length === 1);
    s.bots.updateSettings(s.id, { engineeringMode: true });
    s.runner.sendPrompt(s.id, "fix the test", "n2");
    await until(() => s.sends().length === 2);
    expect(seen).toEqual([false, true]);
  });
});

describe("TurnRunner", () => {
  it("runs a user turn: activity row, reply, ack cleared, request id recorded, typing off", async () => {
    const s = setup((input) => [{ tool: "Bash", input: { command: "ls /workspace" } }, send(`got ${messageText(input.prompt[0]!)}`)]);
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => s.sends().length === 1);
    expect(s.sends()[0]).toBe("got [t1u] hello");
    const act = s.bots.tail(s.id, 100).find((e) => e.kind === "tool-call");
    expect(act).toMatchObject({ step: "Ran ls /workspace", status: "done", metric: { verb: "Ran", noun: "command", count: 1 } });
    expect(s.acks.get(s.id)).toBeNull();
    expect(s.expired).toContain(`${s.id}:user_redirect`);
    await until(() => s.runner.isIdle(s.id));
    expect(s.bots.summary(s.id).presence).toBe("idle");
    expect(s.events.some((e) => e.channel === "transcript" && e.payload.op === "typing" && e.payload.typing === false)).toBe(true);
  });

  // bug 198 fix round 1 (review of 872df075, finding 3): a tool-call step's own body is stored and
  // streamed exactly like every other Bot-visible string, so RunnerDeps.redact must actually reach
  // `bodyFor` — this is the wiring test; `activity.test.ts` covers `bodyFor`'s own redaction in isolation.
  it("bug 198 fix round 1: a step's body is redacted through RunnerDeps.redact before it is stored", async () => {
    const s = setup(
      (input) => [{ tool: "Bash", input: { command: "cat token.txt" }, output: "token: sk-live-abc123" }, send(`got ${messageText(input.prompt[0]!)}`)],
      {},
      { redact: (_botId, text) => text.replace(/sk-live-\w+/g, "[secret:TOKEN]") },
    );
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => s.sends().length === 1);
    const act = s.bots.tail(s.id, 100).find((e) => e.kind === "tool-call") as { body?: { kind: string; command: string; output: string | null } };
    expect(act.body).toEqual({ kind: "command", command: "cat token.txt", output: "token: [secret:TOKEN]", truncated: false });
  });

  // fix round 2 (re-check of 9bb055e6), finding 1: with no redactor at all wired up (RunnerDeps.redact
  // absent — the real-world state before phase3 exists), a step must get NO body rather than an
  // unredacted one. `step`/`metric` are unaffected; only `body` is gated on having a real scanner.
  it("fix round 2, finding 1: with no RunnerDeps.redact at all, a step gets no body — never an unredacted one", async () => {
    const s = setup(
      (input) => [{ tool: "Bash", input: { command: "cat token.txt" }, output: "token: sk-live-abc123" }, send(`got ${messageText(input.prompt[0]!)}`)],
      {},
      {}, // no `redact` in RunnerDeps at all
    );
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => s.sends().length === 1);
    const act = s.bots.tail(s.id, 100).find((e) => e.kind === "tool-call") as { body?: unknown; step: string };
    expect(act.body).toBeFalsy();
    expect(act.step).toContain("cat token.txt"); // the short summary is unaffected — only the full body is gated
  });

  it("is idempotent per clientNonce (EVT-11)", async () => {
    const s = setup(() => [send("ok")]);
    const a = s.runner.sendPrompt(s.id, "hi", "same");
    const b = s.runner.sendPrompt(s.id, "hi", "same");
    expect(b.entryId).toBe(a.entryId);
    await until(() => s.sends().length === 1);
  });

  it("interrupts a dispatched turn on a stop message and prepends every unconfirmed message (EVT-09, EVT-10, bug 198)", async () => {
    const prompts: string[][] = [];
    const s = setup((input) => { prompts.push(input.prompt.map(messageText)); return prompts.length === 1 ? [{ wait: 5000 }, send("late")] : [send("both")]; });
    s.runner.sendPrompt(s.id, "first", "n1");
    await until(() => s.brains.get(s.id)?.procState === "running");
    // Bug 198: a plain follow-up steers a running turn; "stop" (or a redirect) still interrupts it.
    s.runner.sendPrompt(s.id, "stop", "n2");
    s.runner.sendPrompt(s.id, "third", "n3");
    await until(() => s.sends().includes("both"));
    expect(s.sends()).toEqual(["both"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.slice(0, 3)).toEqual(["[t1u] first", "[t2u] stop", "[t3u] third"]);
  });

  it("keeps the turn going through the Stop hook when nothing was sent (OUT-07)", async () => {
    const s = setup((_i, ctx) => (ctx.nudge ? [send("result")] : [{ text: "the answer is 4" }]));
    s.runner.sendPrompt(s.id, "2+2?", "n1");
    await until(() => s.sends().length === 1);
    expect(s.brains.get(s.id)!.inputs).toHaveLength(1);
  });

  it("falls back to hidden nudge turns quoting the unsent text when the Stop hook can't block (§13.3)", async () => {
    const s = setup((input) => (input.source === "reply-nudge" ? [send("result")] : [{ text: "the answer is 4" }]), { stopNudge: false });
    s.runner.sendPrompt(s.id, "2+2?", "n1");
    await until(() => s.sends().length === 1);
    const nudge = s.brains.get(s.id)!.inputs[1]!;
    expect(nudge).toMatchObject({ hidden: true, source: "reply-nudge" });
    expect(messageText(nudge.prompt.at(-1)!)).toContain("You wrote this but never sent it: «the answer is 4»");
  });

  it("redrives an unanswered message after idle, then posts 'Bot failed to respond' after 3 tries (OUT-08, OUT-09)", async () => {
    const s = setup(() => [{ text: "never sends" }]);
    s.runner.sendPrompt(s.id, "hello", "n1");
    await until(() => s.trays.list().some((t) => t.title === "Bot failed to respond"), 5000);
    const sources = s.brains.get(s.id)!.inputs.map((i) => i.source);
    expect(sources).toEqual(["user", "ack-redrive", "ack-redrive", "ack-redrive"]);
    expect(s.acks.get(s.id)).toBeNull();
  });

  it("kickstarts a new Bot once with a hidden first-run turn (BOT-04)", async () => {
    const s = setup((input) => [send(input.hidden ? "Hi, I'm Piper." : "?")]);
    const id = s.bots.create({ origin: "user", kickstart: true });
    s.runner.kickstart(id);
    await until(() => s.bots.tail(id, 10).some((e) => e.kind === "send-message"));
    expect(s.bots.introductionPending(id)).toBe(false);
    expect(messageText(s.brains.get(id)!.inputs[0]!.prompt.at(-1)!)).toMatch(/^\[HIDDEN_PROMPT\]\n\[first run\]/);
  });

  it("retries a retryable error with no side effects, then shows the tray (EVT-18)", async () => {
    const s = setup(() => [{ fail: { code: "BOT-E0401", message: "overloaded", retryable: true, trayTitle: "The model service is busy" } }]);
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => s.trays.list().some((t) => t.title === "The model service is busy"));
    expect(s.brains.get(s.id)!.inputs.filter((i) => i.source === "user")).toHaveLength(4);
  });

  // cost-diet-2 lever 1: the runner asks the router per turn, hands the routed model to the brain, reports how the
  // turn went, and reruns a routed turn that failed before doing anything on the Bot's own model at once.
  it("runs a routed turn on the router's model and tells the router how it went", async () => {
    const decided: string[] = [];
    const settled: unknown[] = [];
    const router = {
      decide: (_b: string, t: { text: string }) => { decided.push(t.text); return t.text === "hi" ? { model: "claude-haiku-4-5-20251001", reason: "quick chat" } : null; },
      settled: (_b: string, r: unknown) => { settled.push(r); },
    };
    const s = setup(() => [send("hello")], {}, { router });
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => settled.length === 1);
    expect(decided).toEqual(["hi"]);
    expect(s.brains.get(s.id)!.inputs[0]!.routedModel).toBe("claude-haiku-4-5-20251001");
    expect(settled[0]).toEqual({ escalated: false, failed: false, workTools: 0 });
    s.runner.sendPrompt(s.id, "fix the build", "n2");
    await until(() => settled.length === 2);
    expect(s.brains.get(s.id)!.inputs[1]!.routedModel).toBeUndefined();
  });

  // Voice calls: a spoken turn runs at low effort on the Bot's OWN model (never routed to a faster
  // one), as a per-turn option — the next typed turn is back to normal.
  it("a voice-call turn is marked for the brain and is never routed; a typed turn is not", async () => {
    const settled: unknown[] = [];
    const router = { decide: () => ({ model: "claude-haiku-4-5-20251001", reason: "quick chat" }), settled: (_b: string, r: unknown) => { settled.push(r); } };
    const s = setup(() => [send("hello")], {}, { router });
    s.runner.sendPrompt(s.id, "what time is it", "n1", { voiceCall: true, voiceDurationMs: 900 });
    await until(() => s.brains.get(s.id)?.inputs.length === 1);
    const first = s.brains.get(s.id)!.inputs[0]!;
    expect(first.voiceTurn).toBe(true);
    expect(first.routedModel).toBeUndefined();
    s.runner.sendPrompt(s.id, "hi", "n2");
    await until(() => s.brains.get(s.id)!.inputs.length === 2);
    expect(s.brains.get(s.id)!.inputs[1]!.voiceTurn).toBeUndefined();
    expect(s.brains.get(s.id)!.inputs[1]!.routedModel).toBe("claude-haiku-4-5-20251001");
  });

  // saving-settings, "Call replies": which turns the brain runs at low effort. Read when the turn starts, so a change
  // never touches a turn already running.
  describe("Call replies", () => {
    const run = async (mode: "default" | "fast" | "match") => {
      let live = true;
      const s = setup(() => [send("ok")], {}, { callLive: () => live });
      if (mode !== "default") s.settings.update({ callReplies: mode });
      const low = () => s.brains.get(s.id)!.inputs.map((i) => i.voiceTurn === true);
      s.runner.sendPrompt(s.id, "spoken", "n1", { voiceCall: true, voiceDurationMs: 900 });
      await until(() => s.brains.get(s.id)?.inputs.length === 1);
      await until(() => s.runner.isIdle(s.id));
      s.runner.sendPrompt(s.id, "typed during the call", "n2");
      await until(() => s.brains.get(s.id)!.inputs.length === 2);
      await until(() => s.runner.isIdle(s.id));
      live = false;
      s.runner.sendPrompt(s.id, "typed after the call", "n3");
      await until(() => s.brains.get(s.id)!.inputs.length === 3);
      return low();
    };
    it("Default: low effort for spoken turns only (today's behaviour)", async () => {
      expect(await run("default")).toEqual([true, false, false]);
    });
    it("Fast on the whole call: every turn while the call is live, typed ones too", async () => {
      expect(await run("fast")).toEqual([true, true, false]);
    });
    it("Match the Bot: the Bot's own effort on calls too, so nothing switches", async () => {
      expect(await run("match")).toEqual([false, false, false]);
    });
  });

  it("a routed turn that fails before doing anything reruns on the Bot's own model, not counted as a retry", async () => {
    const settled: { failed: boolean }[] = [];
    const router = { decide: () => ({ model: "claude-haiku-4-5-20251001", reason: "quick chat" }), settled: (_b: string, r: { failed: boolean }) => { settled.push(r); } };
    let n = 0;
    const s = setup(() => (n++ === 0 ? [{ fail: { code: "BOT-MODEL", message: "model unavailable", retryable: false, trayTitle: "Model unavailable" } }] : [send("hello")]), {}, { router });
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => settled.length === 1);
    const inputs = s.brains.get(s.id)!.inputs.filter((i) => i.source === "user");
    expect(inputs.map((i) => i.routedModel ?? "own")).toEqual(["claude-haiku-4-5-20251001", "own"]);
    expect(settled[0]!.failed).toBe(true);
    expect(s.sends()).toEqual(["hello"]);
  });

  it("Stop drops queued work and clears the obligation (CHAT-18)", async () => {
    const s = setup(() => [{ wait: 5000 }, send("late")]);
    s.runner.sendPrompt(s.id, "long job", "n1");
    await until(() => s.brains.get(s.id)?.procState === "running");
    await s.runner.interruptAgent(s.id);
    await until(() => s.runner.isIdle(s.id));
    expect(s.sends()).toEqual([]);
    expect(s.acks.get(s.id)).toBeNull();
  });

  it("deletes a Bot after draining it (BOT-09)", async () => {
    const s = setup(() => [{ wait: 5000 }]);
    s.runner.sendPrompt(s.id, "work", "n1");
    await until(() => s.brains.get(s.id)?.procState === "running");
    await s.runner.deleteBot(s.id);
    expect(s.bots.has(s.id)).toBe(false);
    expect(s.acks.get(s.id)).toBeNull();
  });

  it("writes resume markers on quiesce and resumes them at boot (EVT-19)", async () => {
    const s = setup((input) => (input.source === "restart-resume" ? [send("resumed")] : [{ wait: 5000 }]));
    s.runner.sendPrompt(s.id, "work", "n1");
    await until(() => s.brains.get(s.id)?.procState === "running");
    s.runner.quiesce();
    expect(s.expired).toContain(`${s.id}:quiesce`);
    await s.brains.get(s.id)!.interrupt("shutdown");
    await until(() => s.runner.isIdle(s.id));
    s.runner.resumeAtBoot();
    await until(() => s.sends().includes("resumed"));
  });

  // Bug 2 (hand-test after a long engineering build): "Continue from where you left off" fired on the next
  // boot even though the Bot had already sent its result — a clean end_turn is not a cut-off. Repro: quiesce()
  // lands the instant the SendMessage that ends the turn completes (r.slot is still non-null; the host hasn't
  // finished its own trailing bookkeeping yet), which used to be enough on its own to write a resume marker.
  // end_turn: true is the discriminator (review round 2): it is what actually tells the CLI this turn is
  // over, and it is what a resume marker's decision must key on, not merely "a send just happened".
  it("a clean send that ends the turn earns no resume marker, even if quiesce lands right after it (bug 2)", async () => {
    let runnerRef: TurnRunner | null = null;
    const s = setup(
      () => [{ tool: "mcp__bot__SendMessage", input: { content: "done", end_turn: true } }],
      {},
      { observers: [{ onEvent: (_botId, e) => { if (e.kind === "tool_end" && e.name === "mcp__bot__SendMessage") runnerRef?.quiesce(); } }] },
    );
    runnerRef = s.runner;
    s.runner.sendPrompt(s.id, "work", "n1");
    await until(() => s.runner.isIdle(s.id));
    const before = s.brains.get(s.id)!.inputs.length;
    s.runner.resumeAtBoot();
    await until(() => s.runner.isIdle(s.id));
    expect(s.brains.get(s.id)!.inputs.slice(before).some((i) => i.source === "restart-resume")).toBe(false);
  });

  // Review round 1 (blocking) on bug 2: an earlier send-counter formula missed the most common real
  // cut-off — a progress note, then a long tool call still running when the host restarts. Under the
  // current endTurnRequested-only rule this is simply: the note never asked to end (no end_turn), and
  // nothing else in this turn does either, so it reads as cut off for as long as the Bash call runs.
  // Repro: quiesce() lands from inside the long tool's own execution, well before it resolves.
  it("a long tool call still running when quiesce lands earns a resume marker (bug 2 review: tool in flight)", async () => {
    let runnerRef: TurnRunner | null = null;
    let quiesced = false;
    const s = setup(
      () => [send("note"), { tool: "Bash", input: { command: "long-build" } }],
      {},
      {},
      { toolRunner: async () => { if (!quiesced) { quiesced = true; runnerRef?.quiesce(); } return "done"; } },
    );
    runnerRef = s.runner;
    s.runner.sendPrompt(s.id, "work", "n1");
    await until(() => s.runner.isIdle(s.id));
    const before = s.brains.get(s.id)!.inputs.length;
    s.runner.resumeAtBoot();
    await until(() => s.brains.get(s.id)!.inputs.length > before);
    expect(s.brains.get(s.id)!.inputs.slice(before).some((i) => i.source === "restart-resume")).toBe(true);
  });

  it("notifies observers with the settled turn and appends system-prompt extras (Phase 5 seams)", async () => {
    const settled: SettledTurn[] = [];
    const events: string[] = [];
    const s = setup(
      (input) => [{ tool: "Bash", input: { command: "ls /workspace" } }, send(`got ${messageText(input.prompt[0]!)}`)],
      {},
      { observers: [{ onEvent: (_b, e) => events.push(e.kind), onSettled: (t) => settled.push(t) }], systemAppendExtras: () => "CONNECTOR NOTES" },
    );
    expect(s.runner.systemAppend(s.id)).toMatch(/CONNECTOR NOTES$/);
    s.runner.sendPrompt(s.id, "hello", "n1", { voiceDurationMs: 5000, hints: ["h"] });
    await until(() => s.sends().length === 1);
    await until(() => s.runner.isIdle(s.id));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ botId: s.id, lane: "user", source: "user", hidden: false, userText: "hello" });
    expect(settled[0]!.sentTexts.length).toBeGreaterThan(0);
    expect(events).toContain("tool_start");
    const user = s.bots.tail(s.id, 10).find((e) => e.kind === "message");
    expect(user).toMatchObject({ voice: { durationMs: 5000 }, hints: ["h"] });
  });
});
