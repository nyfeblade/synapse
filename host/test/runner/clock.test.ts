import path from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain } from "../../brain/fake-brain";
import { messageText, type TurnInput } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { clockReminder } from "../../runner/prompt-collector";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

/**
 * Bug #50: what the MODEL sees on turn N must carry the current date in the user's zone, read from
 * the clock at that turn — not the day the session (or the warm process) started.
 *
 * The zone is Pacific/Kiritimati (UTC+14) on purpose: at 12:00 UTC it is already TOMORROW there, so a
 * clock rendered in UTC (or the box's own zone) shows the wrong day and fails these assertions.
 */
const ZONE = "Pacific/Kiritimati";
const DAY = 86_400_000;
// Far from any real date, so a wall clock leaking in can never satisfy an assertion by coincidence.
const T0 = Date.UTC(2031, 2, 10, 12, 0); // Mon 2031-03-10 12:00Z = Tue 2031-03-11 02:00 in Kiritimati

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: ZONE });
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const clock = { ms: T0 };
  const runner = new TurnRunner({
    cfg, bots, presence, settings, trays: new TrayService(hub),
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 60_000, retryBaseMs: 1 },
    now: () => clock.ms,
  });
  const seen: TurnInput[] = [];
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => new FakeBrain(id, runner.wiring(id), (input) => { seen.push(input); return [send("ok")]; }),
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  /** The text the model is handed on turn n (0-based), all messages joined. */
  const turnText = (n: number) => seen[n]!.prompt.map(messageText).join("\n");
  return { runner, id, clock, seen, turnText };
}

describe("the Bot's clock (bug #50)", () => {
  it("every user turn carries today's date in the user's zone, read per turn across a long warm session", async () => {
    const s = setup();
    s.runner.sendPrompt(s.id, "what's today?", "n1");
    await until(() => s.seen.length === 1);
    expect(s.turnText(0)).toContain("2031-03-11");
    expect(s.turnText(0)).toContain("Tuesday");
    expect(s.turnText(0)).toContain(ZONE);

    // Same warm process, three days later: the clock must move, not replay turn 1's.
    await until(() => s.runner.isIdle(s.id));
    s.clock.ms = T0 + 3 * DAY;
    s.runner.sendPrompt(s.id, "and now?", "n2");
    await until(() => s.seen.length === 2);
    expect(s.turnText(1)).toContain("2031-03-14");
    expect(s.turnText(1)).toContain("Friday");
    expect(s.turnText(1)).not.toContain("2031-03-11");
  });

  it("a wake that fires days later (a routine, a hidden host wake) carries the date at the moment it runs", async () => {
    const s = setup();
    s.clock.ms = T0 + 5 * DAY; // Sun 2031-03-16 02:00 in Kiritimati
    s.runner.enqueueWake(s.id, { source: "routine", lane: "background", silenceAllowed: true, prompt: () => [{ text: "[routine] Morning brief" }] });
    await until(() => s.seen.length === 1);
    expect(s.turnText(0)).toContain("2031-03-16");
    expect(s.turnText(0)).toContain("Sunday");

    await until(() => s.runner.isIdle(s.id));
    s.clock.ms = T0 + 9 * DAY; // Thu 2031-03-20
    s.runner.enqueueHidden(s.id, { source: "restart-resume", lane: "background", silenceAllowed: true, text: "resume" });
    await until(() => s.seen.length === 2);
    expect(s.turnText(1)).toContain("2031-03-20");
    expect(s.turnText(1)).toContain("Thursday");
  });

  it("the clock is never in the system prompt: the cached block is byte-identical across days", async () => {
    const s = setup();
    s.runner.sendPrompt(s.id, "hi", "n1");
    await until(() => s.seen.length === 1);
    await until(() => s.runner.isIdle(s.id));
    s.clock.ms = T0 + 2 * DAY;
    s.runner.sendPrompt(s.id, "hi again", "n2");
    await until(() => s.seen.length === 2);
    expect(s.seen[1]!.systemAppend).toBe(s.seen[0]!.systemAppend);
    for (const d of ["2031-03-10", "2031-03-11", "2031-03-12", "2031-03-13"]) expect(s.seen[1]!.systemAppend).not.toContain(d);
  });
});

describe("clockReminder", () => {
  it("renders the user's wall clock with its offset, and falls back to UTC for an unreadable zone", () => {
    const july = Date.UTC(2031, 6, 1, 3, 30); // 2031-06-30 23:30 in New York (EDT)
    expect(clockReminder(july, "America/New_York")).toContain("Monday 2031-06-30 23:30 in the user's time zone (America/New_York, UTC-04:00)");
    expect(clockReminder(july, "Not/AZone")).toContain("Tuesday 2031-07-01 03:30 in the user's time zone (UTC, UTC+00:00)");
  });
});
