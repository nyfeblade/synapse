import type { LocalAskStatus, SseEvent } from "@synapse/shared";
import type { Call } from "../gateway-call";
import type { NativeHandler } from "../native";
import type { TelegramApiOpts } from "./api";
import { TelegramBridge, type LocalAnswer } from "./bridge";
import { TelegramStore, type Sealer } from "./store";

export interface TelegramWireDeps {
  userData: string;
  reg(name: string, fn: NativeHandler): void;
  emit(channel: string, payload: unknown): void;
  /** The host's gateway, or null while Synapse isn't connected to it. */
  call(): Call | null;
  /** Tell the coordinator to forward the Bots' send-message events (only while on). */
  watch(on: boolean): void;
  seal: Sealer | null;
  log(line: string): void;
  /** A Mac card's answer, through the coordinator's own gate (the in-app card's path). */
  answerLocal?(a: LocalAnswer): Promise<{ status: LocalAskStatus }>;
  /** Tests only. */
  api?: TelegramApiOpts;
  reportRetryMs?: number;
}

/**
 * Wave 4.1 — Settings → System → Telegram. Off by default: nothing polls, ticks or listens until the owner turns it
 * on; the settings file is read once at launch.
 */
export function registerTelegram(d: TelegramWireDeps) {
  const store = TelegramStore.in(d.userData, d.seal);
  let watching = false;
  // 4.4: this connection's health goes to the host's one model (Settings → Connections, the tray, the notification).
  // Sent only when it changes; a send that can't reach the host is tried again on the next change or in 30 s.
  let reported: string | null = null;
  let retry: NodeJS.Timeout | null = null;
  const report = () => {
    const h = bridge.health();
    const key = JSON.stringify(h);
    if (key === reported) return;
    const call = d.call();
    const again = () => { if (!retry) { retry = setTimeout(() => { retry = null; report(); }, d.reportRetryMs ?? 30_000); retry.unref?.(); } };
    if (!call) { again(); return; }
    void call("reportConnectorHealth", { id: "telegram", state: h.state, reason: h.reason, network: h.network })
      .then(() => { reported = key; }, again);
  };
  const bridge = new TelegramBridge({
    store,
    api: d.api,
    call: d.call,
    watch: (on) => { watching = on; d.watch(on); },
    changed: () => { d.emit("telegram", { type: "changed" }); report(); },
    log: d.log,
    ...(d.answerLocal ? { answerLocal: d.answerLocal } : {}),
  });
  d.reg("telegram.status", () => bridge.status());
  d.reg("telegram.setToken", (a: { token?: unknown }) => bridge.setToken(typeof a?.token === "string" ? a.token : ""));
  d.reg("telegram.enable", () => bridge.enable());
  d.reg("telegram.disable", () => bridge.disable());
  d.reg("telegram.remove", () => bridge.remove());
  d.reg("telegram.pair.start", () => bridge.startPairing());
  d.reg("telegram.pair.cancel", () => bridge.cancelPairing());
  d.reg("telegram.unpair", () => bridge.unpair());
  return {
    bridge,
    store,
    onEvent: (ev: SseEvent) => bridge.onEvent(ev),
    /** A respawned coordinator forgets; tell it again. */
    rewatch: () => { if (watching) d.watch(true); },
    resume: () => { bridge.resume(); d.emit("telegram", { type: "changed" }); report(); },
    /** The host (re)connected: it starts with no word from Telegram. */
    reportAgain: () => { reported = null; report(); },
    dispose: () => { if (retry) clearTimeout(retry); bridge.dispose(); },
  };
}

export type TelegramWire = ReturnType<typeof registerTelegram>;
