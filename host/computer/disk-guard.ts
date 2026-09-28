import fs from "node:fs";
import { LIMITSC, STRC, type DiskLevel, type DiskPressureView } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { BrainWiring } from "../brain/types";
import type { SseHub } from "../gateway/sse-hub";
import { loadPrompt } from "../prompts";
import type { HiddenSpec } from "../runner/turn-runner";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export function nextLevel(prev: DiskLevel, free: number, total: number): DiskLevel {
  const pct = (free / total) * 100;
  const L = LIMITSC;
  if (free <= L.diskHardBytes || pct <= L.diskHardPct) return "hard";
  if (prev === "hard" && !(free > L.diskHardExitBytes && pct > L.diskHardExitPct)) return "hard";
  if (free <= L.diskSoftBytes || pct <= L.diskSoftPct) return "soft";
  if (prev !== "ok" && !(free > L.diskSoftExitBytes && pct > L.diskSoftExitPct)) return "soft";
  return "ok";
}

interface Ledger { episode: number; level: DiskLevel; reminded: string[]; diskSaverBotId: string | null }

/** CMP-15: 60-second poll, soft/hard episodes, one reminder per Bot per episode. */
export class DiskGuard {
  private ledger: Ledger;
  private last: DiskPressureView;
  private now: () => number;

  constructor(private o: { path: string; hub: SseHub; ledgerFile: string; statfs?(p: string): { free: number; total: number }; onEpisode?(level: DiskLevel): void; now?(): number }) {
    this.now = o.now ?? Date.now;
    this.ledger = readJson<Ledger>(o.ledgerFile, { episode: 0, level: "ok", reminded: [], diskSaverBotId: null });
    this.last = { level: this.ledger.level, freeBytes: 0, totalBytes: 0, freePct: 100, checkedAt: 0, diskSaverBotId: this.ledger.diskSaverBotId };
  }

  private stat(): { free: number; total: number } {
    if (this.o.statfs) return this.o.statfs(this.o.path);
    const s = fs.statfsSync(this.o.path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }

  private save(): void {
    writeJsonAtomic(this.o.ledgerFile, this.ledger);
  }

  poll(): DiskPressureView {
    let free: number, total: number;
    try {
      ({ free, total } = this.stat());
    } catch (err) {
      console.error(`[DiskGuard] statfs failed; keeping last-known view: ${err instanceof Error ? err.message : String(err)}`);
      return this.last;
    }
    const level = nextLevel(this.ledger.level, free, total);
    if (level !== "ok" && this.ledger.level === "ok") {
      this.ledger.episode += 1;
      this.ledger.reminded = [];
      this.o.onEpisode?.(level);
    }
    this.ledger.level = level;
    this.save();
    this.last = { level, freeBytes: free, totalBytes: total, freePct: Math.round((free / total) * 1000) / 10, checkedAt: this.now(), diskSaverBotId: this.ledger.diskSaverBotId };
    this.o.hub.publish({ channel: "box-disk-pressure", payload: this.last });
    return this.last;
  }

  view(): DiskPressureView {
    return this.last;
  }

  reminderFor(botId: string): string | null {
    if (this.ledger.level === "ok" || this.ledger.reminded.includes(botId)) return null;
    this.ledger.reminded.push(botId);
    this.save();
    return STRC.diskReminder;
  }

  setDiskSaver(id: string | null): void {
    this.ledger.diskSaverBotId = id;
    this.last = { ...this.last, diskSaverBotId: id };
    this.save();
  }
}

export function withDiskReminder(w: BrainWiring, o: { botId: string; guard: DiskGuard }): BrainWiring {
  return {
    ...w,
    postToolUse: async (call, output) => {
      const r = await w.postToolUse(call, output);
      const note = o.guard.reminderFor(o.botId);
      if (!note) return r;
      return { ...r, additionalContext: r.additionalContext ? `${r.additionalContext}\n\n${note}` : note };
    },
  };
}

/** BOT-16: the system Bot that audits the disk and proposes cleanups. */
export class DiskSaver {
  constructor(private o: { bots: BotService; enqueueHidden(botId: string, spec: HiddenSpec): void; guard: DiskGuard }) {}

  find(): string | null {
    return this.o.bots.ids().find((id) => this.o.bots.require(id).store.getKv<string | null>("purpose", null) === "disk-saver") ?? null;
  }

  ensure(): { id: string; created: boolean } {
    const have = this.find();
    if (have) return { id: have, created: false };
    const id = this.o.bots.create({
      origin: "user", kickstart: false, name: STRC.diskSaverName, title: "Disk space",
      description: "Keeps the shared computer's disk tidy. Finds what's taking space and proposes cleanups; deletes nothing without your OK.",
    });
    this.o.bots.require(id).store.setKv("purpose", "disk-saver");
    this.o.guard.setDiskSaver(id);
    this.o.enqueueHidden(id, { source: "disk-saver", lane: "background", silenceAllowed: false, text: loadPrompt("disk-saver-kickstart.md").trim() });
    return { id, created: true };
  }

  open(): string {
    const r = this.ensure();
    if (!r.created) this.o.enqueueHidden(r.id, { source: "disk-saver", lane: "background", silenceAllowed: false, text: loadPrompt("wakes/disk-saver.md").trim() });
    return r.id;
  }
}
