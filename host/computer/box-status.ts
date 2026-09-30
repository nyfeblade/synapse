import fs from "node:fs";
import path from "node:path";
import { APP_NAME, COMPUTER_NAME, type ForeverBoxStatus } from "@synapse/shared";
import type { SseHub } from "../gateway/sse-hub";
import { fillTemplate, loadPrompt } from "../prompts";
import type { DisplayManager } from "./displays";
import type { Exec } from "./x-exec";

/** Bug 292: Synapse's own tone ids (the box's bot-wallpaper still paints the old ids, for an older host). */
export type Tone = "dawn" | "day" | "dusk" | "evening" | "night";

/** CMP-10 tone boundaries (ours): 05–09 dawn, 09–16 day, 16–19 dusk, 19–23 evening, 23–05 night. */
export function toneAt(ms: number, timeZone: string): Tone {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date(ms)));
  if (h >= 5 && h < 9) return "dawn";
  if (h >= 9 && h < 16) return "day";
  if (h >= 16 && h < 19) return "dusk";
  if (h >= 19 && h < 23) return "evening";
  return "night";
}

export class WallpaperScheduler {
  private painted = new Map<number, Tone>();
  private now: () => number;
  constructor(private o: { exec: Exec; displays: DisplayManager; timeZone(): string; now?(): number }) {
    this.now = o.now ?? Date.now;
  }
  async paint(index: number): Promise<void> {
    const tone = toneAt(this.now(), this.o.timeZone());
    const x = this.o.displays.xenv(index);
    await this.o.exec("/usr/local/bin/bot-wallpaper", ["paint", x.display, tone], { env: { DISPLAY: x.display, XAUTHORITY: x.xauthority }, timeoutMs: 15_000 });
    this.painted.set(index, tone);
  }
  async tick(): Promise<void> {
    const tone = toneAt(this.now(), this.o.timeZone());
    for (const d of this.o.displays.list()) if (d.running && this.painted.get(d.index) !== tone) await this.paint(d.index).catch(() => {});
  }
}

/** CMP-14. Best-effort: a reference dir the host can't write is logged, never a boot crash. */
export function writeReferenceDocs(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["debugging-the-box.md", "app-ui.md"]) {
      fs.writeFileSync(path.join(dir, f), fillTemplate(loadPrompt(`reference/${f}`), { APP_NAME, COMPUTER_NAME }), { mode: 0o644 });
    }
    return true;
  } catch (e) {
    console.error(`reference docs not written to ${dir}: ${(e as Error).message}`);
    return false;
  }
}

export class BoxStatus {
  private phase: ForeverBoxStatus["phase"] = "ready";
  private step: ForeverBoxStatus["step"] = null;
  private error: string | null = null;
  private maintenance = false;
  private doctor = { ranAt: null as number | null, failed: [] as string[] };
  private now: () => number;

  constructor(private o: { hub: SseHub; exec: Exec; imageVersionFile?: string; snapshots(): { latestAt: number | null; running: boolean }; busyBotIds(): string[]; now?(): number }) {
    this.now = o.now ?? Date.now;
  }

  private imageVersion(): string {
    try { return fs.readFileSync(this.o.imageVersionFile ?? "/etc/bots/image-version", "utf8").trim(); } catch { return "dev"; }
  }

  view(): ForeverBoxStatus {
    const snap = this.o.snapshots();
    return {
      phase: this.phase, step: this.step, imageVersion: this.imageVersion(), latestVersion: true, // the Mac compares with its bundled version (T22)
      backupReady: snap.latestAt !== null && !snap.running, lastSnapshotAt: snap.latestAt, busyBotIds: this.o.busyBotIds(),
      doctor: this.doctor, error: this.error, maintenance: this.maintenance,
    };
  }

  private lastPublished = "";

  private publish(): void {
    const v = this.view();
    this.lastPublished = JSON.stringify(v);
    this.o.hub.publish({ channel: "forever-box", payload: v });
  }

  /** Portable install: new turns are held while the Mac re-provisions the box (a quiet status line, not a banner). */
  setMaintenance(on: boolean): void {
    if (this.maintenance === on) return;
    this.maintenance = on;
    this.publish();
  }

  setPhase(phase: ForeverBoxStatus["phase"], step: ForeverBoxStatus["step"] = null, error: string | null = null): void {
    this.phase = phase;
    this.step = step;
    this.error = error;
    this.publish();
  }

  /** Task 30 fuzz: publish when the view changed (a backup appeared, busy Bots changed), so Settings → Updates isn't stale. */
  refresh(): void {
    if (JSON.stringify(this.view()) !== this.lastPublished) this.publish();
  }

  async runDoctor(): Promise<{ ranAt: number; failed: string[] }> {
    const r = await this.o.exec("/usr/local/bin/box-doctor", [], { timeoutMs: 30_000 });
    const lines = r.stdout.toString("utf8").split("\n");
    const failed = lines.filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5).trim());
    // 0.1.4 first-run: a doctor that reported nothing (it died, or couldn't start) is a failure, never a clean pass.
    if (!lines.some((l) => l.startsWith("PASS ") || l.startsWith("FAIL "))) failed.push("box-doctor");
    this.doctor = { ranAt: this.now(), failed };
    return { ranAt: this.doctor.ranAt as number, failed };
  }
}
