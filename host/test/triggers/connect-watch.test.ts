import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import type { TurnRunner, WakeSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { ListenerConnectWatcher, listenerConnectedText } from "../../triggers/connect-watch";
import { tmpConfig } from "../helpers";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const cfg = tmpConfig();
  initLayout(cfg);
  const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const id = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const wakes: WakeSpec[] = [];
  const runner = { enqueueWake: (_b: string, s: WakeSpec) => { wakes.push(s); return "t"; } } as unknown as TurnRunner;
  let connected = false;
  const acks = { record: vi.fn(), token: () => "ack-1" };
  const w = new ListenerConnectWatcher({ runner, bots, acks, isConnected: () => connected, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout) });
  const card = () => bots.tail(id, 20).find((e) => e.kind === "send-message" && e.message.type === "card") as SendMessageEntry | undefined;
  return { w, id, wakes, card, acks, connect: () => { connected = true; } };
}
const flush = () => new Promise((r) => setImmediate(r));

describe("ListenerConnectWatcher (RTN-12, wake #14)", () => {
  it("posts a connect card, polls every 5 s and wakes the Bot once when connected", async () => {
    const s = setup();
    s.w.watch(s.id, "slack", "Ops mentions", "ops-mentions");
    s.w.watch(s.id, "slack", "Ops mentions", "ops-mentions");
    expect(s.card()?.message).toEqual({ type: "card", card: { kind: "connect-listener", platform: "slack", routineId: "ops-mentions", routineName: "Ops mentions", connected: false } });
    vi.advanceTimersByTime(10_000); await flush();
    expect(s.wakes).toHaveLength(0);
    s.connect();
    vi.advanceTimersByTime(5000); await flush();
    expect(s.wakes).toHaveLength(1);
    expect(s.wakes[0]).toMatchObject({ source: "listener-connected", lane: "background", silenceAllowed: false, ackToken: "ack-1" });
    expect((s.wakes[0]!.prompt()[0] as { text: string }).text).toContain(listenerConnectedText("Slack", "Ops mentions"));
    expect(s.acks.record).toHaveBeenCalledWith(s.id);
    expect((s.card()!.message as { card: { connected: boolean } }).card.connected).toBe(true);
    vi.advanceTimersByTime(60_000); await flush();
    expect(s.wakes).toHaveLength(1);
  });
  it("gives up after 15 minutes", async () => {
    const s = setup();
    s.w.watch(s.id, "github", "PR watch", "pr-watch");
    vi.advanceTimersByTime(15 * 60_000 + 5000); await flush();
    s.connect();
    vi.advanceTimersByTime(60_000); await flush();
    expect(s.wakes).toHaveLength(0);
  });
});
