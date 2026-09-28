import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotSettings } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain } from "../../brain/fake-brain";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { messageText, type TurnInput } from "../../brain/types";
import { applyEngineeringMode, createEngineeringModule } from "../../engineering/module";
import { canOfferEngineering, engineeringModeSection, engineeringOfferHint, engineeringSystemExtra, modeChangeNotice } from "../../engineering/prompt";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { loadPrompt } from "../../prompts/index";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const OFF: BotSettings = { notifyOnAgentUpdates: true, hiddenFromSidebar: false };
const T_ON = Date.UTC(2026, 8, 21, 14, 5);

describe("engineering mode prompt (user decision 2026-09-21: ON = Claude Code preset + Bot prompt + ENGINEERING MODE section)", () => {
  it("the ENGINEERING MODE section says plainly what mode the Bot is in, what its prompt is, since when, how to work and how to leave", () => {
    const s = engineeringModeSection(T_ON);
    expect(s).toMatch(/^# ENGINEERING MODE/);
    expect(s).toMatch(/you are in engineering mode/i);
    expect(s).toMatch(/Claude Code's full engineering prompt/);
    expect(s).toMatch(/Bot instructions/);
    expect(s).toMatch(/the user turned it on/i);
    expect(s).toContain("2026-09-21 14:05 UTC");
    expect(s).toMatch(/git/);
    expect(s).toMatch(/tests/);
    expect(s).toMatch(/switch(es)? it off in (this Bot's|your) settings/i);
  });

  // 2026-09-21 coding bench: 55 of 58 Bash calls ran without a `cd <abs> &&`, so the host (which can't see the
  // built-in Bash's cwd) sent build/test/git commands to the ~8 s reviewer or refused `npm test` as unbound; and
  // 7 progress notes were model calls of their own (a full context re-read each).
  // cost-diet-2: the anchoring line is replaced by a mechanism (the gate reads the CLI's Bash cwd; the fast path
  // for a bare `npm test` in the tree is pinned in review/engineering-fast-path.test.ts), so the prompt no longer
  // pays for it; progress notes become rare as well as batched with work.
  it("sends progress notes alongside work, rarely and tersely; shell anchoring is the gate's job, not the prompt's", () => {
    const s = engineeringModeSection(T_ON);
    expect(s).not.toMatch(/cd <absolute project path>/);
    expect(s).toMatch(/progress notes[^.]*rare and terse/i);
    // coding-parity (2026-09-22 run 1 trace): "at a milestone" produced a note after each fix, each a call of its own.
    // Bug 1 (mixed signals, hand-test after a long engineering build): this used to say "past two minutes" while
    // the host's own nudge (discipline.ts) fired every two minutes for as long as the Bot stayed quiet — a
    // constant nag, the opposite of "rare". The wording now matches the fixed cadence: a long quiet stretch,
    // then at most once every ten minutes.
    expect(s).toMatch(/at most once every ten minutes/i);
    expect(s).not.toMatch(/past two minutes/i);
    expect(s).not.toMatch(/milestone/i);
    expect(s).toMatch(/one short line, in the same response as your next tool call, never a model call of its own/i);
  });

  // coding-parity: run 3 opened every task with an ack sent as a model call of its own (+5 s). The host no longer
  // demands one in engineering mode (discipline.ts quietWork), and the section says so, overriding the Bot prompt.
  it("works first: no acknowledgement before starting, the result is the first message", () => {
    const s = engineeringModeSection(T_ON);
    expect(s).toMatch(/do not acknowledge before you start/i);
    expect(s).toMatch(/the app shows the user you are working/i);
    expect(s).toMatch(/end_turn: true/);
  });

  // bug-log 127: the batch-reads line shipped with T01 false done on the next two real runs and batched nothing; reverted.
  it("carries no batch-reads line (reverted, bug-log 127)", () => {
    expect(engineeringModeSection(T_ON)).not.toMatch(/batch independent reads/i);
  });

  // Bug 5 (hand-test after a long engineering build): "no mistakes" requests got no special handling in
  // engineering mode, so a Bot could publish first and only catch an error on review after. The prompt
  // budget has room for this one line (host/test/perf/prompt-budget.test.ts's on/off diff ceiling, 1,400
  // chars, sat at 1,226 before this).
  it("tells the Bot to fact-check and review before the first publish when the user asks for no mistakes", () => {
    expect(engineeringModeSection(T_ON)).toMatch(/when the user asks for no mistakes, fact-check and review before the first publish, not after/i);
  });

  it("offers the suggestion only when the mode is off and has not been asked", () => {
    expect(canOfferEngineering(OFF)).toBe(true);
    expect(canOfferEngineering({ ...OFF, engineeringOffered: true })).toBe(false);
    expect(canOfferEngineering({ ...OFF, engineeringMode: true })).toBe(false);
    expect(engineeringOfferHint(true)).toMatch(/SuggestEngineeringMode/);
    expect(engineeringOfferHint(false)).toBe("");
  });

  it("system extra is the ENGINEERING MODE section when on, the offer hint when it can still ask, else empty", () => {
    const on = engineeringSystemExtra({ ...OFF, engineeringMode: true, engineeringModeSince: T_ON });
    expect(on).toContain(engineeringModeSection(T_ON));
    // The old coding-agent append is gone: the preset under it already carries the full coding workflow.
    expect(on).not.toContain(loadPrompt("orig/coding-agent.md").trim().split("\n")[0]!);
    expect(engineeringSystemExtra(OFF)).toMatch(/SuggestEngineeringMode/);
    expect(engineeringSystemExtra({ ...OFF, engineeringOffered: true })).toBe("");
    // Under the box owner's preset escape hatch the standalone mode line is not in the prompt, so the extra states the mode.
    expect(engineeringSystemExtra({ ...OFF, engineeringOffered: true }, "preset")).toMatch(/standard mode.*engineering mode is off/i);
  });

  it("the one-time notice names the switch, its direction and the new prompt", () => {
    expect(modeChangeNotice(true, "standalone")).toMatch(/Engineering mode was turned ON by the user just now; your system prompt changed to Claude Code's full engineering prompt/);
    expect(modeChangeNotice(false, "standalone")).toMatch(/Engineering mode was turned OFF by the user just now; your system prompt changed back to your standard/);
  });
});

describe("applyEngineeringMode", () => {
  it("resets the offer when the mode is turned on then off", () => {
    expect(applyEngineeringMode({ ...OFF, engineeringMode: true, engineeringOffered: true }, false))
      .toEqual({ engineeringMode: false, engineeringOffered: false });
  });

  it("marks the offer used when turning on", () => {
    expect(applyEngineeringMode(OFF, true)).toEqual({ engineeringMode: true, engineeringOffered: true });
  });
});

describe("engineering module", () => {
  it("setAgentEngineeringMode writes settings; SuggestEngineeringMode posts once", async () => {
    // Typed as BotSettings, not inferred from the literal: the module widens this object with
    // `Object.assign(settings, patch)` at runtime, so an inferred two-field type makes every
    // optional field a typecheck error even though the code under test sets them.
    const settings: BotSettings = { ...OFF };
    const entries: unknown[] = [];
    const notes: unknown[] = [];
    const ctx = {
      cfg: tmpConfig(),
      bots: {
        summary: () => ({ settings }),
        updateSettings: (_id: string, patch: Record<string, unknown>) => {
          Object.assign(settings, patch);
          return { id: "b", settings };
        },
        appendEntry: (_id: string, e: unknown) => { entries.push(e); },
        invalidatePromptSnapshots: () => {},
        noteModeChange: (...a: unknown[]) => { notes.push(a); },
      },
      now: () => T_ON,
    };
    const m = createEngineeringModule(ctx as never);
    const on = (await m.handlers.setAgentEngineeringMode!({ id: "b", enabled: true })).agent.settings;
    expect(on.engineeringMode).toBe(true);
    expect(on.engineeringModeSince).toBe(T_ON);
    await m.handlers.setAgentEngineeringMode!({ id: "b", enabled: false });
    expect(settings.engineeringOffered).toBe(false);
    // "Not now" on the offer card sends enabled:false while already off: no change, so no notice.
    await m.handlers.setAgentEngineeringMode!({ id: "b", enabled: false });
    expect(notes).toHaveLength(2);

    const slot = { nextSendK: 0, turnNo: 1, requestId: "r", segment: 0 };
    const tools = m.botTools!("b", () => slot as never);
    const suggest = tools.find((t) => t.name === "SuggestEngineeringMode")!;
    const first = await suggest.handler({});
    expect(first.isError).toBeUndefined();
    expect(entries).toHaveLength(1);
    const again = await suggest.handler({});
    expect(again.isError).toBe(true);
    expect(entries).toHaveLength(1);
  });
});

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

/** A real BotService + TurnRunner with the engineering module wired the way host/app.ts wires Phase 5. */
function runnerSetup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const m = createEngineeringModule({ cfg, bots, now: () => T_ON } as never);
  let renders = 0;
  const runner = new TurnRunner({
    cfg, bots, presence, settings, trays: new TrayService(hub),
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 60_000, retryBaseMs: 1 },
    now: () => T_ON,
    // Rendered only inside the frozen snapshot, so this counts snapshot renders.
    extraSystemAppend: () => { renders += 1; return ""; },
    systemAppendExtras: (id) => m.systemAppendExtra!(id),
  });
  const seen: TurnInput[] = [];
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => new FakeBrain(id, runner.wiring(id), (input) => { seen.push(input); return [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }]; }),
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const turn = async (text: string) => {
    const n = seen.length;
    runner.sendPrompt(id, text, `n${n}`);
    await until(() => seen.length === n + 1);
    await until(() => runner.isIdle(id));
    return { text: seen[n]!.prompt.map(messageText).join("\n"), systemAppend: seen[n]!.systemAppend };
  };
  return { id, m, turn, renders: () => renders };
}

describe("switching engineering mode mid-conversation", () => {
  it("takes effect on the NEXT turn: one hidden notice, a re-rendered snapshot, the new prompt — and the notice is never re-sent", async () => {
    const s = runnerSetup();
    const t1 = await s.turn("hi");
    expect(t1.systemAppend).not.toContain("# ENGINEERING MODE");
    const t2 = await s.turn("still there?");
    expect(s.renders()).toBe(1); // frozen per compaction epoch: turn 2 reused turn 1's snapshot

    await s.m.handlers.setAgentEngineeringMode!({ id: s.id, enabled: true });
    const t3 = await s.turn("let's fix the build");
    expect(s.renders(), "the toggle invalidates the snapshot").toBe(2);
    expect(t3.systemAppend).toContain("# ENGINEERING MODE");
    expect(t3.text.match(/Engineering mode was turned ON by the user just now/g)).toHaveLength(1);
    for (const t of [t1, t2]) expect(t.text).not.toMatch(/Engineering mode was turned/);

    const t4 = await s.turn("next");
    expect(t4.text, "the notice is one-time").not.toMatch(/Engineering mode was turned/);
    expect(s.renders()).toBe(2);

    await s.m.handlers.setAgentEngineeringMode!({ id: s.id, enabled: false });
    const t5 = await s.turn("done coding");
    expect(t5.text.match(/Engineering mode was turned OFF by the user just now/g)).toHaveLength(1);
    expect(t5.systemAppend).not.toContain("# ENGINEERING MODE");
    expect(s.renders()).toBe(3);
  });

  it("ON then OFF before the next turn cancels out: no notice for a switch the Bot never saw", async () => {
    const s = runnerSetup();
    await s.turn("hi");
    await s.m.handlers.setAgentEngineeringMode!({ id: s.id, enabled: true });
    await s.m.handlers.setAgentEngineeringMode!({ id: s.id, enabled: false });
    expect((await s.turn("again")).text).not.toMatch(/Engineering mode was turned/);
  });
});

describe("a Bot's spawn options follow its engineering switch", () => {
  let app: HostApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it("OFF = the standalone string; ON = the Claude Code preset with an append carrying the ENGINEERING MODE section", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Eng", isKickstartRequested: false });
    const options = () => {
      const sc = a.services.spawnConfig(id);
      return {
        key: sc.spawnKey,
        prompt: buildBotQueryOptions({
          cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode,
          model: sc.model, env: sc.env, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
        }).systemPrompt,
      };
    };
    const off = options();
    expect(typeof off.prompt).toBe("string");
    expect(off.prompt as string).toMatch(new RegExp(`^${loadPrompt("standalone.md").trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(off.prompt as string).not.toContain("# ENGINEERING MODE");

    await a.handlers.setAgentEngineeringMode!({ id, enabled: true });
    const on = options();
    expect(on.prompt).toMatchObject({ type: "preset", preset: "claude_code" });
    const append = (on.prompt as { append: string }).append;
    expect(append).toContain("# ENGINEERING MODE");
    expect(append).toContain("You are Eng"); // our Bot prompt is still there, under the preset
    expect(on.key, "a warm process must respawn on the next turn").not.toBe(off.key);

    await a.handlers.setAgentEngineeringMode!({ id, enabled: false });
    expect(typeof options().prompt).toBe("string");
  });
});
