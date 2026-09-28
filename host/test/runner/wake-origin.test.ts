import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EventEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { installWakeOrigin } from "../../runner/wake-origin";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });

function setup(script: FakeScript) {
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
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 20, retryBaseMs: 1 },
  });
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => new FakeBrain(id, runner.wiring(id), script),
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  installWakeOrigin(runner, bots);
  const piper = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const scout = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const ledger = bots.create({ origin: "user", kickstart: false, name: "Ledger" });
  const origins = () => bots.tail(piper, 100).filter((e): e is EventEntry => e.kind === "event" && e.event.type === "wake-origin");
  const kinds = () => bots.tail(piper, 100).map((e) => (e.kind === "event" ? `event:${e.event.type}` : e.kind));
  return { bots, runner, piper, scout, ledger, origins, kinds };
}

describe("wake-origin rows (CHAT-23)", () => {
  it("a peer wake with visible output gets exactly one row, before the first message", async () => {
    const s = setup(() => [send("Here's the CSV."), send("And the summary.")]);
    s.runner.enqueueWake(s.piper, { source: "agent", lane: "agent", silenceAllowed: true, context: { wake: { kind: "agent", senderIds: [s.scout, s.ledger] } }, prompt: () => [{ text: "[agent] 2 messages" }] });
    await until(() => s.bots.tail(s.piper, 100).filter((e) => e.kind === "send-message").length === 2);
    expect(s.origins()).toHaveLength(1);
    expect(s.origins()[0]!.event).toEqual({ type: "wake-origin", source: "agent", botIds: [s.scout, s.ledger] });
    const k = s.kinds();
    expect(k.indexOf("event:wake-origin")).toBe(k.indexOf("send-message") - 1);
  });

  it("a silent peer wake adds nothing", async () => {
    const s = setup(() => [{ text: "nothing to say" }]);
    let settled = false;
    s.runner.enqueueWake(s.piper, { source: "agent", lane: "agent", silenceAllowed: true, context: { wake: { kind: "agent", senderIds: [s.scout] } }, prompt: () => [{ text: "[agent]" }], onSettle: () => { settled = true; } });
    await until(() => settled);
    expect(s.origins()).toEqual([]);
  });

  it("a routine wake names the routine", async () => {
    const s = setup(() => [send("Inbox swept.")]);
    s.runner.enqueueWake(s.piper, { source: "routine", lane: "background", silenceAllowed: true, context: { wake: { kind: "routine", routineId: "morning-inbox-sweep", routineName: "Morning inbox sweep" } }, prompt: () => [{ text: "[routine]" }] });
    await until(() => s.origins().length === 1);
    expect(s.origins()[0]!.event).toEqual({ type: "wake-origin", source: "routine", routineId: "morning-inbox-sweep", routineName: "Morning inbox sweep" });
  });

  it("user turns and group-member turns never get a row", async () => {
    const s = setup(() => [send("Hi!")]);
    s.runner.sendPrompt(s.piper, "hello", "n1");
    await until(() => s.bots.tail(s.piper, 100).some((e) => e.kind === "send-message"));
    let settled = false;
    s.runner.enqueueWake(s.piper, { source: "group-member", lane: "user", groupMember: true, silenceAllowed: true, context: { wake: { kind: "agent", senderIds: [s.scout] }, group: { groupId: "g", roomTurnId: "rt", epoch: 1 } }, prompt: () => [{ text: "[Group chat]" }], onSettle: () => { settled = true; } });
    await until(() => settled);
    expect(s.origins()).toEqual([]);
  });
});
