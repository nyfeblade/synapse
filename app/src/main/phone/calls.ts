import type { DictationEvent, RemoteAudio } from "../native/dictation";
import type { CallHandlers, CallLink } from "./server";

/** How long the Mac has to bring a phone call's audio up before the phone is told it failed. */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Bug 198: the phone's side of a call. The Mac's call screen still runs the call (the same VoiceLoop,
 * greetings, barge-in, turn-taking, wrap-up); this only swaps its microphone and speaker for the
 * phone's. One phone call at a time: a newer one takes over and the older phone is told.
 *
 * phone → Mac:  call {botId} · binary mic frames · mute {muted} · hangup
 * Mac → phone:  connecting {botId} · live · partial/heard {text} · line {text} · speaking · flush ·
 *               binary audio frames · ended {reason}
 */
export class PhoneCalls implements CallHandlers, RemoteAudio {
  private link: CallLink | null = null;
  private botId: string | null = null;
  private live = false;
  private muted = false;
  private timer: NodeJS.Timeout | null = null;
  /** Numbers each phone call, so a late "ended" from the Mac for an older call can't end a newer one. */
  private seq = 0;

  constructor(private d: {
    /** Tell the renderer: open the call screen for this Bot (`call`), or close it (`hangup`). */
    toRenderer(e: { type: "call"; botId: string; seq: number } | { type: "hangup"; botId: string; seq: number }): void;
    /** The phone's microphone, to the running phone-call helper. */
    feed(pcm: Buffer): boolean;
    /** Tell the running phone-call helper to mute / unmute. */
    muteHelper?(muted: boolean): void;
    log?(line: string): void;
    now?(): number;
  }) {}

  // ---- RemoteAudio (the dictation side) ----
  active(): boolean { return this.link !== null; }

  out(pcm: Buffer): void { this.link?.audio(pcm); }

  event(e: DictationEvent, _sessionId?: string): void {
    const l = this.link;
    if (!l) return;
    switch (e.type) {
      case "ready":
        if (!this.live) { this.live = true; this.clearTimer(); l.send({ type: "live" }); }
        if (this.muted) this.d.muteHelper?.(true);
        break;
      case "partial": l.send({ type: "partial", text: e.text }); break;
      case "final": if (e.text.trim()) l.send({ type: "heard", text: e.text.trim() }); break;
      case "speak-audio": l.send({ type: "speaking" }); break;
      case "barge-in": l.send({ type: "flush" }); break;
      case "speak-end": if (e.interrupted) l.send({ type: "flush" }); break;
      case "muted": l.send({ type: "muted", muted: e.muted }); break;
      default: break;
    }
  }

  line(text: string): void { this.link?.send({ type: "line", text }); }

  flush(): void { this.link?.send({ type: "flush" }); }

  // ---- CallHandlers (the phone side) ----
  call(link: CallLink, botId: string): void {
    const prev = this.link;
    if (prev && prev !== link) prev.send({ type: "ended", reason: "elsewhere" });
    if (prev && this.botId && this.botId !== botId) this.d.toRenderer({ type: "hangup", botId: this.botId, seq: this.seq });
    this.link = link;
    this.seq += 1;
    this.botId = botId;
    this.live = false;
    this.muted = false;
    link.send({ type: "connecting", botId });
    this.d.log?.(`phone: call to ${botId.slice(0, 8)} from device ${link.deviceId.slice(0, 8)}`);
    this.d.toRenderer({ type: "call", botId, seq: this.seq });
    this.clearTimer();
    this.timer = setTimeout(() => { if (this.link === link && !this.live) this.end("failed"); }, CONNECT_TIMEOUT_MS);
    this.timer.unref?.();
  }

  mic(link: CallLink, pcm: Buffer): void {
    if (link !== this.link || !this.live) return;
    this.d.feed(pcm);
  }

  mute(link: CallLink, muted: boolean): void {
    if (link !== this.link) return;
    this.muted = muted;
    this.d.muteHelper?.(muted);
  }

  hangup(link: CallLink): void {
    if (link === this.link) this.end("phone");
  }

  closed(link: CallLink): void {
    if (link === this.link) this.end("phone");
  }

  // ---- the Mac side ----
  /** The Mac's call screen closed (the user or a Bot hung up there, or the call failed). */
  endedOnMac(botId?: string, seq?: number): void {
    if (!this.link || (botId && this.botId && botId !== this.botId) || (seq !== undefined && seq !== this.seq)) return;
    const l = this.link;
    this.reset();
    l.send({ type: "ended", reason: "mac" });
  }

  /** Phone access switched off, or the phone was revoked: the call ends everywhere. */
  endAll(reason: string): void { if (this.link) this.end(reason); }

  current(): { botId: string; deviceId: string; live: boolean; seq: number } | null {
    return this.link && this.botId ? { botId: this.botId, deviceId: this.link.deviceId, live: this.live, seq: this.seq } : null;
  }

  private end(reason: string): void {
    const l = this.link, bot = this.botId;
    this.reset();
    if (bot) this.d.toRenderer({ type: "hangup", botId: bot, seq: this.seq });
    l?.send({ type: "ended", reason });
    this.d.log?.(`phone: call ended (${reason})`);
  }

  private reset(): void {
    this.clearTimer();
    this.link = null;
    this.botId = null;
    this.live = false;
    this.muted = false;
  }

  private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
