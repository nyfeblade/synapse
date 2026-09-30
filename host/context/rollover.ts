import fs from "node:fs";
import { isProviderSessionId, PROVIDER_SESSION_PREFIX } from "../brain/provider/session-store";
import { ACP_SESSION_PREFIX, isAcpSessionId } from "../brain/acp/acp-sessions";
import path from "node:path";
import { LIMITS, STR, type TranscriptEntry } from "@synapse/shared";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { fillTemplate, loadPrompt } from "../prompts/index";
import type { TurnHooks } from "../runner/hooks";
import type { TurnRunner } from "../runner/turn-runner";
import type { TrayService } from "../trays/trays";
import { log } from "../util/log";
import { patchCtx, readCtx } from "./context-meter";
import { buildRestoreBlock } from "./restore";

type Rec = Record<string, unknown>;
const RESUME_FAILED = /no conversation found|session .*not found|could not (?:find|resume)|invalid session|corrupt/i;

export function tailFromLastBoundary(jsonl: string): { records: Rec[]; summary: string | null } | null {
  const recs: Rec[] = [];
  for (const l of jsonl.split("\n")) {
    if (!l.trim()) continue;
    try { recs.push(JSON.parse(l) as Rec); } catch { /* a torn last line after a crash */ }
  }
  let i = -1;
  for (let k = recs.length - 1; k >= 0; k--) if (recs[k]!.type === "system" && recs[k]!.subtype === "compact_boundary") { i = k; break; }
  if (i < 0) return null;
  const records = recs.slice(i);
  const sum = records.find((r) => r.isCompactSummary === true) as { message?: { content?: unknown } } | undefined;
  const c = sum?.message?.content;
  const summary = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : null;
  return { records, summary: summary || null };
}

export function rewriteSession(records: Rec[], newId: string): Buffer {
  return Buffer.from(records.map((r) => JSON.stringify({ ...r, sessionId: newId })).join("\n") + "\n");
}

const entryText = (e: TranscriptEntry): string | null =>
  e.kind === "message" ? `User (${e.id}): ${e.content}`
    : e.kind === "send-message" && e.message.type === "text" ? `You (${e.id}): ${e.message.content}`
    : null;

export interface RolloverDeps {
  cfg: HostConfig;
  bots: BotService;
  runner: Pick<TurnRunner, "runMaintenance" | "enqueueHidden" | "retryUserTurn">;
  trays: TrayService;
  flags(): ConformanceFlags;
  now(): number;
  readSession(p: string): Buffer;
  writeSession(p: string, data: Buffer): void;
  sizeOf(p: string): number | null;
  newId(): string;
  /** Box: root-owned session files go through the bot-claude-delete-session helper (gate M-2). */
  deleteSession?: (p: string) => void;
  /** I5: the secret scanner's redact, applied to the tail copy (line by line) and to the handoff summary. */
  redact?(botId: string, text: string): string;
}

export class Rollover {
  constructor(private d: RolloverDeps) {}

  reasonToRoll(botId: string): string | null {
    const file = this.d.bots.sessionFilePath(botId);
    if (!file) return null;
    const size = this.d.sizeOf(file);
    const limit = Math.min(LIMITS.rolloverBytes, this.d.flags().rolloverBytes);
    if (size !== null && size > limit) return `session file over ${Math.round(limit / 1024 / 1024)} MB`;
    if (readCtx(this.d.bots, botId).compactions >= LIMITS.rolloverCompactions) return `${LIMITS.rolloverCompactions} compactions`;
    const lat = this.d.bots.brainKv<number[]>(botId, "resumeLatencies", []);
    if (lat.length >= 5) {
      const sorted = [...lat].sort((a, b) => a - b);
      if (sorted[2]! > LIMITS.rolloverResumeP50Ms) return "slow resume";
    }
    return null;
  }

  rollNow(botId: string, reason: string, opts: { retry?: boolean } = {}): boolean {
    if (!this.d.bots.has(botId) || !this.d.bots.sessionId(botId)) return false;
    return this.d.runner.runMaintenance(botId, { id: `rollover-${reason}`, run: async () => this.roll(botId, reason, opts.retry ?? false) });
  }

  private roll(botId: string, reason: string, retry: boolean): void {
    const oldId = this.d.bots.sessionId(botId)!;
    const oldFile = this.d.bots.sessionFilePath(botId)!;
    let tail: ReturnType<typeof tailFromLastBoundary> = null;
    // Bug 44's class: warning about this and then handing over a recap that reads like any other one
    // leaves the Bot answering "what did we decide?" out of a summary it does not know is partial.
    // The read failure is not recoverable here, so it travels with the handoff to the one party that
    // can act on it.
    let unreadable = false;
    try { tail = tailFromLastBoundary(this.d.readSession(oldFile).toString("utf8")); } catch (e) { unreadable = true; log.warn("rollover: old session unreadable", { botId, error: String(e) }); }
    let copied = false;
    if (tail) {
      // A provider session (spec §7) stays one: same folder, same prefix, so the Bot keeps its brain.
      const newId = isAcpSessionId(oldId) ? `${ACP_SESSION_PREFIX}${this.d.newId()}` : isProviderSessionId(oldId) ? `${PROVIDER_SESSION_PREFIX}${this.d.newId()}` : this.d.newId();
      try {
        const copy = rewriteSession(tail.records, newId);
        this.d.writeSession(path.join(path.dirname(oldFile), `${newId}.jsonl`), this.d.redact ? Buffer.from(this.d.redact(botId, copy.toString("utf8"))) : copy);
        this.d.bots.setSessionId(botId, newId);
        copied = true;
      } catch (e) {
        log.warn("rollover: write helper failed; using the handoff turn", { botId, error: String(e) });
      }
    }
    if (!copied) {
      this.d.bots.clearSessionId(botId); // §07.5 step 2: the next spawn starts without resume
      const recap = tail?.summary ?? this.fallbackSummary(botId);
      const summary = unreadable ? `${STR.rolloverTailLost}\n${recap}` : recap;
      const filled = fillTemplate(loadPrompt("wakes/session-handoff.md"), { SUMMARY: summary, RESTORE: buildRestoreBlock({ bots: this.d.bots, botId, dataRoot: this.d.cfg.dataRoot }) });
      const text = this.d.redact ? this.d.redact(botId, filled) : filled;
      this.d.runner.enqueueHidden(botId, { source: "session-handoff", lane: "background", head: true, silenceAllowed: true, text: text.trim(), ackToken: null });
    }
    const rolledEntry = { id: oldId, file: oldFile, rolledAt: this.d.now() };
    const prev = this.d.bots.brainKv<{ id: string; file: string; rolledAt: number }[]>(botId, "previousSessionIds", []);
    this.d.bots.setBrainKv(botId, "previousSessionIds", [rolledEntry, ...prev].slice(0, LIMITS.previousSessionsKept));
    // Tracked separately (and without the display cap above) so a file pushed out of the
    // previousSessionsKept window by later rollovers is still swept after the TTL (§07.5 step 3).
    const rolledFiles = this.d.bots.brainKv<{ id: string; file: string; rolledAt: number }[]>(botId, "rolledSessionFiles", []);
    this.d.bots.setBrainKv(botId, "rolledSessionFiles", [rolledEntry, ...rolledFiles]);
    this.d.bots.bumpCompactionEpoch(botId);
    patchCtx(this.d.bots, botId, { compactions: 0, turnsSinceCompact: 0 });
    this.d.bots.setBrainKv(botId, "resumeLatencies", []);
    log.info("session rolled over", { botId, reason, copied });
    if (retry) this.d.runner.retryUserTurn(botId);
  }

  private fallbackSummary(botId: string): string {
    const lines = this.d.bots.tail(botId, LIMITS.handoffFallbackEntries).map(entryText).filter((x): x is string => Boolean(x));
    return lines.join("\n").slice(-LIMITS.handoffFallbackChars);
  }

  hooks(): TurnHooks {
    return {
      afterSettle: (botId, t) => {
        if (t.source === "user" && t.firstEventAt !== null) {
          const lat = this.d.bots.brainKv<number[]>(botId, "resumeLatencies", []);
          this.d.bots.setBrainKv(botId, "resumeLatencies", [...lat, t.firstEventAt - t.startedAt].slice(-5));
        }
        if (t.error && RESUME_FAILED.test(t.error.message)) {
          this.d.trays.list().filter((x) => x.dedupeKey === `${botId}:${t.error!.code}`).forEach((x) => this.d.trays.dismiss(x.id));
          this.rollNow(botId, "resume-failed", { retry: true });
        }
      },
      onIdle: (botId) => {
        const why = this.reasonToRoll(botId);
        if (why) this.rollNow(botId, why);
      },
    };
  }

  /**
   * §07.5 step 3: previous session files are deleted after 30 days.
   * Walks the unbounded `rolledSessionFiles` list (not the display-capped `previousSessionIds`)
   * so a file pushed out of the 3-slot cap by a later rollover is still tracked and deleted.
   */
  sweepOldSessions(): void {
    for (const botId of this.d.bots.ids()) {
      const rolled = this.d.bots.brainKv<{ id: string; file: string; rolledAt: number }[]>(botId, "rolledSessionFiles", []);
      const remaining = rolled.filter((p) => {
        if (this.d.now() - p.rolledAt <= LIMITS.oldSessionTtlMs) return true;
        if (this.d.deleteSession) this.d.deleteSession(p.file);
        else fs.rmSync(p.file, { force: true });
        return false;
      });
      if (remaining.length !== rolled.length) this.d.bots.setBrainKv(botId, "rolledSessionFiles", remaining);
    }
  }
}
