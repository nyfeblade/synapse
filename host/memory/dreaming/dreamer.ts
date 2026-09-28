import { LIMITS5 } from "@synapse/shared";
import type { LadderLike } from "../../phase5/types";
import type { SettledTurn, TurnObserver } from "../../runner/observers";
import { log } from "../../util/log";
import { validateChanges } from "./apply";
import { EvidenceQueue, isMemorable } from "./evidence";
import type { DreamChange, DreamMemoryPort } from "./port";

/** `botId` names the Bot the call serves, for usage accounting. */
export interface DreamLlm { synthesize(input: object, botId?: string): Promise<unknown>; verify(input: object, botId?: string): Promise<unknown> }
export type PassResult = "applied" | "rejected" | "invalid" | "noop" | "stale" | "skipped" | "timeout";
export interface DreamerDeps {
  port: DreamMemoryPort; llm: DreamLlm; now(): number; mode(): "standard" | "dreaming"; ladder(): LadderLike;
  busy(botId: string): boolean; botName(botId: string): string; botIds(): string[];
  sleep?(ms: number): Promise<void>; onHelper?(botId: string): void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Dreamer implements TurnObserver {
  private queue = new EvidenceQueue();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: DreamerDeps) {}

  onSettled(t: SettledTurn): void {
    if (this.d.mode() !== "dreaming" || t.hidden || !t.userText || !isMemorable(t.userText)) return;
    this.queue.add(t.botId, { user: t.userText, assistant: [...t.sentTexts, t.result.finalText ?? ""].filter(Boolean).join("\n"), occurredAt: this.d.now() });
    clearTimeout(this.timers.get(t.botId));
    const h = setTimeout(() => void this.runPass(t.botId, "evidence"), LIMITS5.dreamDebounceMs);
    h.unref?.();
    this.timers.set(t.botId, h);
  }

  start(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), LIMITS5.dreamSweepMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const h of this.timers.values()) clearTimeout(h);
  }

  /** I12: a deleted Bot's pending dreaming work goes. */
  forgetBot(botId: string): void {
    clearTimeout(this.timers.get(botId));
    this.timers.delete(botId);
    this.queue.take(botId);
  }

  async sweep(): Promise<string[]> {
    if (this.d.mode() !== "dreaming" || !this.d.ladder().allowsBackground("dreaming")) return [];
    const due = this.d.botIds()
      .map((id) => ({ id, at: this.d.port.nextRefreshAt(id) }))
      .filter((x) => x.at !== null && x.at <= this.d.now())
      .sort((a, b) => a.at! - b.at!)
      .slice(0, LIMITS5.dreamSweepBots)
      .map((x) => x.id);
    for (const id of due) await this.runPass(id, "temporal");
    return due;
  }

  async runPass(botId: string, mode: "evidence" | "temporal"): Promise<PassResult> {
    if (this.d.mode() !== "dreaming") return "skipped";
    if (this.running.has(botId)) return "skipped";
    this.running.add(botId);
    const sleep = this.d.sleep ?? defaultSleep;
    try {
      this.d.port.ensureInit(botId);
      while (this.d.busy(botId)) await sleep(LIMITS5.dreamRecheckMs);
      const deadline = this.d.now() + LIMITS5.dreamDeadlineMs;
      const evidence = mode === "evidence" ? this.queue.take(botId) : [];
      if (mode === "evidence" && !evidence.length) return "noop";
      const facts = this.d.port.facts(botId);
      const fp = this.d.port.fingerprint(botId);
      const expiry = this.d.port.expiryCandidates(botId);
      const today = new Date(this.d.now()).toISOString().slice(0, 10);
      const currentMemories = facts.map((f) => ({ id: f.id, content: f.content, createdAt: f.createdAt, kind: f.kind, origin: f.origin, strength: f.strength }));
      const raw = await this.retry(() => this.d.llm.synthesize({ today, botName: this.d.botName(botId), mode, currentMemories, newEvidence: evidence, expiryCandidates: expiry }, botId), deadline, sleep);
      if (raw === "timeout") return "timeout";
      this.d.onHelper?.(botId);
      const v = validateChanges(raw, { facts, evidenceIds: evidence.map((e) => e.id), mode, tombstones: this.d.port.tombstoned(botId), expiryCandidates: expiry });
      if (!v.ok) return "invalid";
      if (!v.changes.length) {
        if (mode === "temporal") this.d.port.setNextRefreshAt(botId, this.d.now() + LIMITS5.dreamRefreshMs);
        return "noop";
      }
      const approved = await this.verify(botId, v.changes, { today, currentMemories, evidence }, deadline, sleep);
      if (approved === "timeout") return "timeout";
      if (!approved) return "rejected";
      if (this.d.port.fingerprint(botId) !== fp) return "stale";
      this.d.port.apply(botId, approved);
      if (mode === "temporal") this.d.port.setNextRefreshAt(botId, this.d.now() + LIMITS5.dreamRefreshMs);
      else if (this.d.port.nextRefreshAt(botId) === null) this.d.port.setNextRefreshAt(botId, this.d.now() + LIMITS5.dreamRefreshMs);
      return "applied";
    } finally {
      this.running.delete(botId);
    }
  }

  /** MEM-07: anything but {"approved":true} rejects; ORIG-06 re-verifies the surviving subset once when ≥ half survive. */
  private async verify(botId: string, changes: DreamChange[], base: object, deadline: number, sleep: (ms: number) => Promise<void>): Promise<DreamChange[] | null | "timeout"> {
    const first = await this.retry(() => this.d.llm.verify({ ...base, proposedChanges: changes }, botId), deadline, sleep);
    if (first === "timeout") return "timeout";
    if ((first as { approved?: unknown })?.approved === true) return changes;
    const rejected = new Set(((first as { rejected?: { index?: number }[] })?.rejected ?? []).map((r) => r.index).filter((i): i is number => typeof i === "number"));
    const subset = changes.filter((_, i) => !rejected.has(i));
    if (!rejected.size || subset.length < changes.length / 2 || !subset.length) return null;
    const second = await this.retry(() => this.d.llm.verify({ ...base, proposedChanges: subset }, botId), deadline, sleep);
    if (second === "timeout") return "timeout";
    return (second as { approved?: unknown })?.approved === true ? subset : null;
  }

  private async retry<T>(fn: () => Promise<T>, deadline: number, sleep: (ms: number) => Promise<void>): Promise<T | "timeout"> {
    for (let attempt = 0; attempt <= LIMITS5.dreamRetries; attempt++) {
      if (this.d.now() > deadline) return "timeout";
      try {
        return await fn();
      } catch (e) {
        log.warn("dreaming call failed", { error: String(e) });
        if (attempt === LIMITS5.dreamRetries) return "timeout";
        await sleep(Math.min(LIMITS5.dreamRetryMaxMs, LIMITS5.dreamRetryMinMs * 2 ** attempt));
      }
    }
    return "timeout";
  }
}
