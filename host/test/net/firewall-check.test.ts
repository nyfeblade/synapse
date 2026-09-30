import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain } from "../../brain/fake-brain";
import { SseHub } from "../../gateway/sse-hub";
import { BoxFirewallCheck, FIREWALL_CHECK_CMD, FIREWALL_MISSING } from "../../net/firewall-check";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

// Bug 364: fail closed. Without the box firewall (bots_auth_proxy + bots_mac_guard) no Bot turn runs.
describe("BoxFirewallCheck", () => {
  it("asks bots-ports check through sudo, non-interactively", () => {
    expect([...FIREWALL_CHECK_CMD]).toEqual(["-n", "/usr/local/lib/bots/bots-ports", "check"]);
  });

  it("turns wait for the first check, and are refused while the firewall is missing", async () => {
    let ok = false;
    const changes: boolean[] = [];
    const c = new BoxFirewallCheck({ enabled: true, run: async () => ok, onChange: (v) => changes.push(v), intervalMs: 1e9 });
    expect(await c.blocked()).toBe(FIREWALL_MISSING);
    ok = true;
    await c.check();
    expect(await c.blocked()).toBeNull();
    ok = false;
    await c.check();
    expect(await c.blocked()).toBe(FIREWALL_MISSING);
    expect(changes).toEqual([false, true, false]);
    c.stop();
  });

  it("a check that throws counts as missing", async () => {
    const c = new BoxFirewallCheck({ enabled: true, run: async () => { throw new Error("sudo: a password is required"); }, intervalMs: 1e9 });
    expect(await c.blocked()).toBe(FIREWALL_MISSING);
    c.stop();
  });

  it("checks again every interval", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => true);
      const c = new BoxFirewallCheck({ enabled: true, run, intervalMs: 60_000 });
      c.start();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(run).toHaveBeenCalledTimes(4);
      c.stop();
    } finally { vi.useRealTimers(); }
  });

  it("off the box (tests, dev) it never blocks and never runs", async () => {
    const run = vi.fn(async () => false);
    expect(await new BoxFirewallCheck({ enabled: false, run }).blocked()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("TurnRunner refuses turns while the firewall is missing", () => {
  it("no brain runs; one tray says why", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const hub = new SseHub();
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const bots = new BotService({ cfg, hub, settings });
    const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
    bots.setRuntimeView((id) => presence.view(id));
    const trays = new TrayService(hub);
    let blocked: string | null = FIREWALL_MISSING;
    const runner = new TurnRunner({
      cfg, bots, presence, settings, trays,
      acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
      sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
      resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
      flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 10_000, retryBaseMs: 1 },
      turnBlocked: async () => blocked,
    });
    let brainRuns = 0;
    const supervisor = new Supervisor({
      caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
      brainFactory: (id) => { brainRuns++; return new FakeBrain(id, runner.wiring(id), () => [{ tool: "mcp__bot__SendMessage", input: { content: "hi" } }]); },
    });
    const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
    runner.attach(supervisor, gate);
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    const settled: string[] = [];
    runner.enqueueWake(id, { source: "routine", lane: "background", silenceAllowed: true, prompt: () => [{ text: "go" }], onDropped: () => settled.push("dropped") } as never);
    const t = Date.now() + 3000;
    while (!settled.length && Date.now() < t) await new Promise((r) => setTimeout(r, 5));
    expect(settled).toEqual(["dropped"]);
    expect(brainRuns).toBe(0);
    expect(trays.list().filter((x) => x.title === FIREWALL_MISSING)).toHaveLength(1);
    blocked = null;
  });
});
