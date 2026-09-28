import { LIMITSC } from "@synapse/shared";
import { useComputer } from "../computer-state";
import { createRfb, type RfbLike } from "./rfb";

export type ScreenStatus = "connecting" | "connected" | "failed" | "unavailable";

interface Screen {
  botId: string;
  el: HTMLDivElement;
  rfb: RfbLike | null;
  status: ScreenStatus;
  subs: Set<(s: ScreenStatus) => void>;
  crashes: number[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Mounted previews showing this screen; at 0 the warm grace starts. */
  users: number;
  warm: ReturnType<typeof setTimeout> | null;
}

/**
 * CMP-07: up to 3 warm view-only previews (LRU); 15 s status timeout; 3 crashes per 60 s stop reconnecting.
 * Headless: every connection closes while the window is hidden (minimized, hidden, fully covered) and only the
 * previews on screen redial when it comes back; a preview nobody shows closes after LIMITSC.previewWarmIdleMs.
 * An open VNC socket keeps the box encoding for it and keeps the Bot's screen from being reclaimed when idle.
 */
export class ScreenPool {
  private screens = new Map<string, Screen>(); // insertion order = LRU order
  private visible = true;

  constructor(
    private o: { max: number; url(botId: string): string | null; make(el: HTMLElement, url: string): RfbLike; now(): number },
  ) {}

  private set(s: Screen, status: ScreenStatus): void {
    s.status = status;
    for (const cb of s.subs) cb(status);
  }

  private connect(s: Screen): void {
    const url = this.o.url(s.botId);
    if (!url) {
      this.set(s, "unavailable");
      return;
    }
    this.set(s, "connecting");
    const rfb = this.o.make(s.el, url);
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.focusOnClick = false;
    rfb.background = "transparent";
    s.rfb = rfb;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      if (s.status === "connecting") {
        rfb.disconnect();
        this.set(s, "failed");
      }
    }, LIMITSC.previewStatusTimeoutMs);
    rfb.addEventListener("connect", () => {
      if (s.timer) clearTimeout(s.timer);
      this.set(s, "connected");
    });
    rfb.addEventListener("disconnect", () => {
      if (s.rfb !== rfb || s.status === "failed") return;
      const now = this.o.now();
      s.crashes = [...s.crashes.filter((x) => now - x < LIMITSC.previewCrashWindowMs), now];
      if (s.crashes.length >= LIMITSC.previewCrashLimit) {
        this.set(s, "failed");
        return;
      }
      this.set(s, "connecting");
      setTimeout(() => {
        if (this.screens.get(s.botId) === s && this.visible && s.rfb === rfb) this.connect(s);
      }, 1000);
    });
  }

  acquire(botId: string): { el: HTMLDivElement; status: ScreenStatus } {
    let s = this.screens.get(botId);
    if (s) {
      this.screens.delete(botId);
      this.screens.set(botId, s);
      if (s.warm) clearTimeout(s.warm);
      s.warm = null;
      if (s.status === "failed" || s.status === "unavailable" || (!s.rfb && this.visible)) {
        s.crashes = [];
        this.connect(s);
      }
    } else {
      const el = document.createElement("div");
      el.className = "screen-live";
      s = { botId, el, rfb: null, status: "connecting", subs: new Set(), crashes: [], timer: null, users: 0, warm: null };
      this.screens.set(botId, s);
      if (this.visible) this.connect(s);
      while (this.screens.size > this.o.max) this.drop(this.screens.keys().next().value as string);
    }
    s.users++;
    return { el: s.el, status: s.status };
  }

  /** The preview showing this screen unmounted: it stays warm for LIMITSC.previewWarmIdleMs, then closes. */
  release(botId: string): void {
    const s = this.screens.get(botId);
    if (!s) return;
    s.users = Math.max(0, s.users - 1);
    if (s.users > 0) return;
    if (s.warm) clearTimeout(s.warm);
    s.warm = setTimeout(() => { if (this.screens.get(botId) === s && s.users === 0) this.close(s); }, LIMITSC.previewWarmIdleMs);
  }

  /** document.visibilityState: hidden closes every connection; visible redials the ones on screen. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    for (const s of [...this.screens.values()]) {
      if (!visible) { this.pause(s); continue; }
      if (s.users > 0) { s.crashes = []; this.connect(s); } else this.close(s);
    }
  }

  private pause(s: Screen): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const r = s.rfb;
    s.rfb = null;
    r?.disconnect();
    if (s.status !== "unavailable") this.set(s, "connecting");
  }

  private close(s: Screen): void {
    this.drop(s.botId);
    this.set(s, "unavailable");
  }

  status(botId: string): ScreenStatus {
    return this.screens.get(botId)?.status ?? "unavailable";
  }

  subscribe(botId: string, cb: (s: ScreenStatus) => void): () => void {
    const s = this.screens.get(botId);
    s?.subs.add(cb);
    return () => s?.subs.delete(cb);
  }

  drop(botId: string): void {
    const s = this.screens.get(botId);
    if (!s) return;
    this.screens.delete(botId);
    if (s.timer) clearTimeout(s.timer);
    if (s.warm) clearTimeout(s.warm);
    const r = s.rfb;
    s.rfb = null;
    r?.disconnect();
  }
}

export const screenPool = new ScreenPool({
  max: LIMITSC.previewWarmMax,
  // Only a Bot the host gave a screen: dialing any other Bot's /vnc is refused (404 → the proxy's 502), which logs
  // console errors and retries. Viewing a Bot's details doesn't claim one of the shared screens either.
  url: (b) => (useComputer.getState().displays[b] ? window.synapse.vncUrl(b) : null),
  make: createRfb,
  now: () => Date.now(),
});
// Headless: nothing streams from the box while the window is minimized, hidden or fully covered.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => screenPool.setVisible(document.visibilityState !== "hidden"));
}
