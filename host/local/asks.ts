import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { LIMITS5, STR5, type LocalAction, type LocalAskChoice, type LocalAskStatus, type LocalToolCardView } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { GatewayError } from "../gateway/errors";
import { postCard, updateCard } from "../phase5/cards";
import type { TurnSlot } from "../runner/turn-slot";

/** "detached": the Bot's session ended while the card waited. The card stays answerable (fix-mac-gate-and-approval-expiry). */
type Outcome = "allowed" | "always" | "denied" | "never" | "expired" | "detached";
interface Ask { botId: string; entryId: string; card: LocalToolCardView; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout>; detached: boolean; targets?: string[] }
interface Persisted { asks: { askId: string; botId: string; entryId: string; card: LocalToolCardView; targets?: string[] }[]; late: { key: string; askId: string; at: number }[] }

const STATUS: Record<LocalAskChoice, LocalAskStatus> = { once: "allowed", always: "always", never: "never", deny: "denied" };
const lateKey = (botId: string, action: LocalAction, target: string) => `${botId}\0${action}\0${target}`;

/**
 * The Mac execution card (LOC-03/04). fix-mac-gate-and-approval-expiry (Bug B): an approval card means the Bot has
 * stopped and waits for the user's choice before the turn goes on. So a card never times out after 10
 * minutes. Bug #96: the Mac tools post it with post() and end the turn (no running slot held while it waits); ask()
 * (awaiting in-call) is kept for direct callers. If the session must end first (Stop, rollover, a host restart), the card stays
 * answerable — it is persisted — and the answer wakes the Bot with the decision; an approval is kept (one-time, bound to
 * this Bot + action + exact target, exactly like the Mac's own record) for the Bot's re-run. Only a card left unanswered
 * for 7 days is withdrawn, for hygiene, with a clear reason; a deleted Bot's cards are withdrawn too.
 */
export class LocalAsks {
  private asks = new Map<string, Ask>();
  /** P5 review minor: an "Always" answer is per-Bot + per-action, never the whole Mac (in memory; a restart asks again). */
  private grants = new Map<string, Set<LocalAction>>();
  /** Late answers waiting for the woken Bot's re-run: key → askId (the Mac recorded that id's approval). */
  private late = new Map<string, { askId: string; at: number }>();
  constructor(private d: { bots: BotService; now(): number; ttlMs?: number; file?: string; wake?(botId: string, text: string): void }) {
    this.load();
  }

  private ttl(): number { return this.d.ttlMs ?? LIMITS5.localApprovalHygieneMs; }

  ask(botId: string, slot: TurnSlot, a: { action: LocalAction; target: string; description?: string }): Promise<{ askId: string; outcome: Outcome }> {
    return new Promise((resolve) => {
      const askId: string = this.open(botId, slot, a, { detached: false, resolve: (outcome) => resolve({ askId, outcome }) });
    });
  }

  private open(botId: string, slot: TurnSlot, a: { action: LocalAction; target: string; description?: string; adopt?: "accept-edits" | "full-auto" }, o: { detached: boolean; resolve(o: Outcome): void; targets?: string[] }): string {
    const askId = randomBytes(32).toString("hex");
    const ttl = this.ttl();
    const card: LocalToolCardView = { kind: "local-tool-permission", askId, action: a.action, target: a.target.slice(0, LIMITS5.localTargetMax), description: a.description ?? null, status: "pending", createdAt: this.d.now(), expiresAt: this.d.now() + ttl, ...(a.adopt ? { adopt: a.adopt } : {}) };
    const entryId = postCard({ bots: this.d.bots, now: this.d.now }, botId, slot, card);
    this.asks.set(askId, { botId, entryId, card, timer: this.timer(askId, ttl), ...o });
    this.save();
    return askId;
  }

  /**
   * Bug #96 (the same issue as #94): post the card and return at once. The caller ends the turn (the runner
   * interrupts after the tool returns), so no running slot is held while the user decides; the answer wakes the Bot
   * and a "once"/"always" leaves the one-time approval its re-run carries (exactly the detached path below).
   */
  post(botId: string, slot: TurnSlot, a: { action: LocalAction; target: string; description?: string }): string {
    return this.open(botId, slot, a, { detached: true, resolve: () => {} });
  }

  /**
   * fix-fullauto-adoption: the ONE Mac-side card that adopts this Bot's mode on the Mac. While it is pending, every other
   * request from the Bot joins it (its command is named in the wake) instead of raising a card of its own.
   */
  adopt(botId: string, slot: TurnSlot, mode: "accept-edits" | "full-auto", target: string): { askId: string; created: boolean } {
    const t = target.slice(0, LIMITS5.localTargetMax);
    for (const [askId, a] of this.asks) {
      if (a.botId !== botId || a.card.adopt !== mode) continue;
      if (a.targets && !a.targets.includes(t) && a.targets.length < 20) { a.targets.push(t); this.save(); }
      return { askId, created: false };
    }
    return { askId: this.open(botId, slot, { action: "run-command", target: t, adopt: mode }, { detached: true, resolve: () => {}, targets: [t] }), created: true };
  }

  /** The pending adoption card's mode for this Bot, if any. */
  adoptionPending(botId: string): "accept-edits" | "full-auto" | null {
    for (const a of this.asks.values()) if (a.botId === botId && a.card.adopt) return a.card.adopt;
    return null;
  }

  resolve(botId: string, askId: string, choice: LocalAskChoice): LocalAskStatus {
    const a = this.asks.get(askId);
    if (!a || a.botId !== botId) throw new GatewayError("NOT_FOUND", "This request is no longer waiting.", 404);
    const status = STATUS[choice];
    this.settle(askId, status === "allowed" ? "allowed" : status === "always" ? "always" : status === "never" ? "never" : "denied");
    return status;
  }

  granted(botId: string, action: LocalAction): boolean {
    return this.grants.get(botId)?.has(action) ?? false;
  }

  /** The approval a late answer left for exactly this Bot + action + target: handed out once, then gone. */
  takeLateApproval(botId: string, action: LocalAction, target: string): string | null {
    const k = lateKey(botId, action, target.slice(0, LIMITS5.localTargetMax));
    const v = this.late.get(k);
    if (!v) return null;
    this.late.delete(k);
    this.save();
    return v.at + this.ttl() >= this.d.now() ? v.askId : null;
  }

  /** I12: a deleted Bot's pending asks are withdrawn and its grants go. */
  forgetBot(botId: string): void {
    for (const [id, a] of this.asks) if (a.botId === botId) this.settle(id, "expired");
    for (const k of [...this.late.keys()]) if (k.startsWith(`${botId}\0`)) this.late.delete(k);
    this.grants.delete(botId);
    this.save();
  }

  /** The Bot's session is ending (Stop, rollover, redirect, quiesce): its waiting tool calls return, but the cards stay
   *  pending and answerable; the answer wakes the Bot (Bug B). Name kept for the gate wrapper that calls it. */
  expireAll(botId: string): void {
    for (const a of this.asks.values()) {
      if (a.botId !== botId || a.detached) continue;
      a.detached = true;
      a.resolve("detached");
    }
  }

  private timer(askId: string, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.settle(askId, "expired"), Math.max(0, ms));
    t.unref?.();
    return t;
  }

  private settle(askId: string, outcome: Exclude<Outcome, "detached">): void {
    const a = this.asks.get(askId);
    if (!a) return;
    clearTimeout(a.timer);
    this.asks.delete(askId);
    if (a.card.adopt) {
      // The Mac already recorded (or declined) the mode when the user answered in the app; the host only settles the
      // card and wakes the Bot. It never grants anything for an adoption card.
      const allowed = outcome === "allowed" || outcome === "always";
      if (this.d.bots.has?.(a.botId) !== false) updateCard(this.d.bots, a.botId, a.entryId, { ...a.card, status: outcome === "expired" ? "expired" : allowed ? "allowed" : "denied" });
      if (outcome !== "expired") this.d.wake?.(a.botId, allowed ? STR5.localAdoptAllowed(a.card.adopt, a.targets ?? []) : STR5.localAdoptKept(a.card.adopt));
      this.save();
      return;
    }
    if (outcome === "always") this.grants.set(a.botId, new Set([...(this.grants.get(a.botId) ?? []), a.card.action]));
    if (this.d.bots.has?.(a.botId) !== false) updateCard(this.d.bots, a.botId, a.entryId, { ...a.card, status: outcome === "expired" ? "expired" : (outcome as LocalAskStatus) });
    if (a.detached) {
      // Nobody is waiting on the promise any more: the answer resumes the Bot instead (a wake), never "expired".
      if (outcome === "allowed" || outcome === "always") {
        this.late.set(lateKey(a.botId, a.card.action, a.card.target), { askId, at: this.d.now() });
        this.d.wake?.(a.botId, STR5.localAskResumed(a.card.target));
      } else if (outcome !== "expired") this.d.wake?.(a.botId, STR5.localAskDeclined(a.card.target));
    } else a.resolve(outcome);
    this.save();
  }

  // ---- persistence: a host restart between the card and the answer keeps the card answerable ----
  private save(): void {
    if (!this.d.file) return;
    const data: Persisted = {
      asks: [...this.asks.entries()].map(([askId, a]) => ({ askId, botId: a.botId, entryId: a.entryId, card: a.card, ...(a.targets ? { targets: a.targets } : {}) })),
      late: [...this.late.entries()].map(([key, v]) => ({ key, askId: v.askId, at: v.at })),
    };
    try {
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.d.file);
    } catch { /* best effort: an unsaved card is still answerable in this process */ }
  }

  private load(): void {
    if (!this.d.file) return;
    let data: Persisted;
    try { data = JSON.parse(fs.readFileSync(this.d.file, "utf8")) as Persisted; } catch { return; }
    const now = this.d.now();
    for (const p of data.asks ?? []) {
      if (typeof p?.askId !== "string" || typeof p.botId !== "string" || p.card?.kind !== "local-tool-permission") continue;
      // Every restored card is detached: the tool call that raised it died with the old process.
      this.asks.set(p.askId, { botId: p.botId, entryId: p.entryId, card: p.card, detached: true, resolve: () => {}, timer: this.timer(p.askId, p.card.createdAt + this.ttl() - now), ...(Array.isArray(p.targets) ? { targets: p.targets.filter((x) => typeof x === "string") } : {}) });
    }
    for (const l of data.late ?? []) if (typeof l?.key === "string" && typeof l.askId === "string" && l.at + this.ttl() >= now) this.late.set(l.key, { askId: l.askId, at: l.at });
  }
}
