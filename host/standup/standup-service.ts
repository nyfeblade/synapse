import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_STANDUP, LIMITS_SCHED, STRS, type StandupCard, type StandupLine, type StandupSettings, type StandupView } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { SseHub } from "../gateway/sse-hub";
import type { OneShotModel } from "../helper-model/one-shot";
import { loadPrompt } from "../prompts/index";
import { nextRunAfter, occurrencesAfter, parseSchedule } from "../schedule/schedule";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { digestFor, estimateTokens } from "./digest";

const PROMPT = "orig/standup-line.md";
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["did", "blocked", "needs"],
  properties: { did: { type: "string" }, blocked: { type: "string" }, needs: { type: "string" } },
};
const CHECK_MS = 60_000;
/** A run later than this after its slot is a catch-up (the Mac or box slept through 9:00). */
const CATCH_UP_AFTER_MS = 2 * 60_000;
const LOOKBACK_MS = 8 * 86_400_000;

interface Saved { settings: StandupSettings; enabledAt: number | null; lastSlot: number | null; cards: StandupCard[] }

const clip = (s: unknown, n: number) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function parseStandupTime(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new GatewayError("BAD_ARGS", "Enter the standup time as HH:MM, for example 09:00.");
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/**
 * The daily standup (opt-in, 9:00 by default). Each Bot's line comes from a digest of its own recent activity, built in
 * code; an active Bot costs one short helper-model call, an idle Bot costs nothing. The lines become one "Team standup"
 * card. A slot missed while asleep runs once on wake (caught up), never more than once per slot.
 */
export class StandupService {
  private file: string;
  private s: Saved;
  private timer: unknown = null;
  private running: Promise<StandupCard> | null = null;
  /** Bug 115: a scheduled standup failed (phase4 raises a tray entry). */
  onFailed: ((detail: string) => void) | undefined;

  constructor(private d: {
    cfg: HostConfig;
    bots: BotService;
    hub: SseHub;
    model: OneShotModel | null;
    now(): number;
    tz(): string;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    /** What the Bot is waiting on the user for, if anything (its awaiting reason). */
    awaiting?(botId: string): string | null;
    /** The Bot's routine runs in the window (name and status). */
    runs?(botId: string, since: number): { name: string; status: string }[];
  }) {
    this.file = path.join(d.cfg.hostPrivate, "standup.json");
    const raw = readJson<Partial<Saved>>(this.file, {});
    this.s = { settings: { ...DEFAULT_STANDUP, ...raw.settings }, enabledAt: raw.enabledAt ?? null, lastSlot: raw.lastSlot ?? null, cards: raw.cards ?? [] };
  }

  private save(): void {
    writeJsonAtomic(this.file, this.s, 0o640);
  }

  private publish(): void {
    this.d.hub.publish({ channel: "standup", payload: this.view() });
  }

  private schedule() {
    const [h, mi] = this.s.settings.time.split(":").map(Number);
    return parseSchedule(`${mi} ${h} * * ${this.s.settings.weekdaysOnly ? "1-5" : "*"}`, { tz: this.d.tz(), nowMs: this.d.now() });
  }

  view(): StandupView {
    const nextAt = this.s.settings.enabled ? nextRunAfter(this.schedule(), this.d.now(), this.d.tz()) : null;
    return { settings: this.s.settings, latest: this.s.cards[0] ?? null, nextAt };
  }

  history(): StandupCard[] {
    return this.s.cards;
  }

  setSettings(p: Partial<StandupSettings>): StandupView {
    const next: StandupSettings = { ...this.s.settings };
    if (p.time !== undefined) next.time = parseStandupTime(p.time);
    if (p.enabled !== undefined) next.enabled = p.enabled === true;
    if (p.weekdaysOnly !== undefined) next.weekdaysOnly = p.weekdaysOnly === true;
    if (p.spoken !== undefined) next.spoken = p.spoken === true;
    // Turning it on (or moving the time) never runs a slot that is already past: it starts from the next one.
    if ((next.enabled && !this.s.settings.enabled) || next.time !== this.s.settings.time || next.weekdaysOnly !== this.s.settings.weekdaysOnly) this.s.enabledAt = this.d.now();
    this.s.settings = next;
    this.save();
    this.publish();
    return this.view();
  }

  start(): void {
    this.arm();
  }

  stop(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  /** The host noticed a sleep or clock jump: check right away. */
  onWake(): void {
    this.tick();
  }

  private arm(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = this.d.setTimer(() => { this.timer = null; this.tick(); this.arm(); }, CHECK_MS);
  }

  /** The latest slot at or before now that is owed (after enabling, not yet run). Earlier missed slots are dropped. */
  private owedSlot(now: number): number | null {
    if (!this.s.settings.enabled) return null;
    let last: number | null = null;
    for (const t of occurrencesAfter(this.schedule(), now - LOOKBACK_MS, this.d.tz())) {
      if (t > now) break;
      last = t;
    }
    if (last === null) return null;
    if (this.s.enabledAt !== null && last < this.s.enabledAt) return null;
    if (this.s.lastSlot !== null && last <= this.s.lastSlot) return null;
    return last;
  }

  private tick(): void {
    if (this.running) return;
    const now = this.d.now();
    const slot = this.owedSlot(now);
    if (slot === null) return;
    this.s.lastSlot = slot; // claimed before the model calls: a second tick cannot run it again
    this.save();
    const caughtUp = now - slot > CATCH_UP_AFTER_MS;
    // Bug 115: the slot is already claimed, so a failure must leave a card that says so (and tell the user),
    // never yesterday's card standing in for this morning's.
    void this.run(slot, caughtUp).catch((e) => {
      log.warn("standup failed", { error: String(e) });
      this.failedCard(slot, caughtUp);
    });
  }

  private failedCard(slot: number, caughtUp: boolean): void {
    const card: StandupCard = { id: randomUUID(), createdAt: this.d.now(), scheduledFor: slot, caughtUp, lines: [], idle: [], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 }, error: STRS.standupFailed };
    this.s.cards = [card, ...this.s.cards].slice(0, LIMITS_SCHED.standupKept);
    try { this.save(); } catch { /* the card still goes out over SSE for this session */ }
    this.publish();
    this.onFailed?.(STRS.standupFailed);
  }

  runNow(): Promise<StandupCard> {
    return this.run(this.d.now(), false);
  }

  private run(slot: number, caughtUp: boolean): Promise<StandupCard> {
    if (this.running) return this.running;
    this.running = this.compose(slot, caughtUp).finally(() => { this.running = null; });
    return this.running;
  }

  private async compose(slot: number, caughtUp: boolean): Promise<StandupCard> {
    const since = this.d.now() - LIMITS_SCHED.standupWindowMs;
    const prompt = loadPrompt(PROMPT);
    const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
    const idle: string[] = [];
    const work: Promise<StandupLine | null>[] = [];
    for (const b of this.d.bots.list()) {
      if (b.group || b.archived) continue;
      const digest = digestFor(this.d.bots.tail(b.id, 400), { since, awaiting: this.d.awaiting?.(b.id) ?? null, runs: this.d.runs?.(b.id, since) ?? [] });
      if (!digest) { idle.push(b.profile.name); continue; }
      work.push(this.line(b.id, b.profile.name, digest, prompt, usage));
    }
    const lines = (await Promise.all(work)).filter((l): l is StandupLine => l !== null);
    const card: StandupCard = { id: randomUUID(), createdAt: this.d.now(), scheduledFor: slot, caughtUp, lines, idle, usage };
    this.s.cards = [card, ...this.s.cards].slice(0, LIMITS_SCHED.standupKept);
    this.save();
    this.publish();
    return card;
  }

  private async line(botId: string, name: string, digest: string, prompt: string, usage: StandupCard["usage"]): Promise<StandupLine> {
    const input = { digest };
    const fallback = (): StandupLine => ({ botId, name, did: clip(/bot said: (.*)/.exec(digest)?.[1] ?? "Worked on recent requests", LIMITS_SCHED.standupLineMaxChars), blocked: /waiting on: (.*)/.exec(digest)?.[1] ?? "nothing", needs: "nothing" });
    if (!this.d.model) return fallback();
    usage.modelCalls += 1;
    usage.inputTokens += estimateTokens(prompt.length + JSON.stringify(input).length);
    try {
      const out = await this.d.model.run<{ did: string; blocked: string; needs: string }>({ prompt: PROMPT, input, schema: SCHEMA, timeoutMs: 20_000, botId });
      usage.outputTokens += estimateTokens(JSON.stringify(out).length);
      const n = LIMITS_SCHED.standupLineMaxChars;
      return { botId, name, did: clip(out.did, n) || fallback().did, blocked: clip(out.blocked, n) || "nothing", needs: clip(out.needs, n) || "nothing" };
    } catch (e) {
      log.warn("standup line fell back to the digest", { botId, error: String(e).slice(0, 200) });
      return fallback();
    }
  }
}

export function standupHandlers(s: StandupService): Pick<CommandHandlers, "getStandup" | "setStandupSettings" | "runStandupNow"> {
  return {
    getStandup: () => s.view(),
    setStandupSettings: (a) => s.setSettings(a),
    runStandupNow: async () => ({ card: await s.runNow() }),
  };
}
