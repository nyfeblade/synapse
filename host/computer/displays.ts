import { randomBytes } from "node:crypto";
import path from "node:path";
import { LIMITSC, STRC, type DisplayInfo } from "@synapse/shared";
import type { HostConfig } from "../config";
import { botOsUser } from "../walls/bot-uid";
import type { SseHub } from "../gateway/sse-hub";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { writeHostOwnedFileAtomic } from "../util/host-owned-file";
import { log } from "../util/log";
import type { DisplayControl } from "./display-control";
import { execBuf, XRunner, type Exec, type XEnv } from "./x-exec";

export class DisplayFullError extends Error {
  constructor() {
    super(STRC.screensFull);
  }
}

interface Ledger { assignments: Record<string, number>; tokens: Record<string, string> }

export interface DisplayManagerOptions {
  cfg: HostConfig;
  control: DisplayControl;
  hub: SseHub;
  exec?: Exec;
  maxScreens?: number;
  capture?: "ffmpeg" | "import";
  now?: () => number;
  /** Where the advisory busy markers go; defaults to a bothost-private folder, never a shared /tmp. */
  busyDir?: string;
  xauthDir?: string;
  onStarted?(botId: string, index: number): void;
  /** Controller ruling 1: true when the Bot has no running turn, no takeover, no open preview or computer
   *  view, and no pending box-help. Composed by the caller (turn-runner + box-help + open VNC views). */
  idle?(botId: string): boolean;
}

/** CMP-04: one screen per Bot, first free index from :2, persisted owner tokens, lazy start, 30-minute idle stop. */
export class DisplayManager {
  private file: string;
  private ledger: Ledger;
  private running = new Set<number>();
  private starting = new Map<number, Promise<void>>();
  private gens = new Map<number, number>();
  private lastUse = new Map<string, number>();
  private idleSince = new Map<string, number>(); // controller ruling 1: continuous-idle tracking for auto-release
  private waiting = new Set<string>(); // Bots that hit "screens full" and are waiting for a seat
  private now: () => number;
  private max: number;

  constructor(private o: DisplayManagerOptions) {
    this.file = path.join(o.cfg.hostPrivate, "window-assignments.json");
    this.ledger = readJson<Ledger>(this.file, { assignments: {}, tokens: {} });
    this.now = o.now ?? Date.now;
    this.max = o.maxScreens ?? LIMITSC.maxScreens;
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.ledger);
  }

  private publish(): void {
    this.o.hub.publish({ channel: "displays", payload: { displays: this.list(), waiting: this.waitingIds() } });
  }

  private retired = new Set<string>(); // I6: a deleted Bot never gets a screen again

  indexFor(botId: string): number | null {
    if (this.retired.has(botId)) return null;
    const have = this.ledger.assignments[botId];
    if (have !== undefined) return have;
    const used = new Set(Object.values(this.ledger.assignments));
    for (let i = LIMITSC.firstDisplay; i < LIMITSC.firstDisplay + this.max; i++) {
      if (used.has(i)) continue;
      return this.assign(botId, i);
    }
    // Controller ruling 1: no free seat — reclaim the least-recently-used idle Bot's, if one exists.
    const victim = this.lruIdleVictim(botId);
    if (victim === null) return null;
    const i = this.ledger.assignments[victim]!;
    delete this.ledger.assignments[victim];
    delete this.ledger.tokens[victim];
    this.lastUse.delete(victim);
    this.idleSince.delete(victim);
    void this.stopIndexFor(i).catch(() => {}); // only the open windows are lost; cookies/profile persist elsewhere
    return this.assign(botId, i);
  }

  private assign(botId: string, i: number): number {
    this.ledger.assignments[botId] = i;
    this.ledger.tokens[botId] = randomBytes(16).toString("base64url");
    this.persist();
    return i;
  }

  private lruIdleVictim(exclude: string): string | null {
    if (!this.o.idle) return null;
    const candidates = Object.keys(this.ledger.assignments).filter((id) => id !== exclude && this.o.idle!(id));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0));
    return candidates[0]!;
  }

  waitingIds(): string[] {
    return [...this.waiting];
  }

  info(botId: string): DisplayInfo | null {
    const i = this.ledger.assignments[botId];
    if (i === undefined) return null;
    return { botId, index: i, display: `:${i}`, cdpPort: LIMITSC.cdpBase + i, running: this.running.has(i), generation: this.gens.get(i) ?? 0 };
  }

  list(): DisplayInfo[] {
    return Object.keys(this.ledger.assignments).map((id) => this.info(id) as DisplayInfo).sort((a, b) => a.index - b.index);
  }

  env(botId: string): Record<string, string> {
    const i = this.indexFor(botId);
    return i === null ? {} : { DISPLAY: `:${i}`, BOT_CDP_PORT: String(LIMITSC.cdpBase + i) };
  }

  async ensure(botId: string): Promise<DisplayInfo> {
    const i = this.indexFor(botId);
    if (i === null) {
      if (!this.waiting.has(botId)) { this.waiting.add(botId); this.publish(); }
      throw new DisplayFullError();
    }
    if (this.waiting.delete(botId)) this.publish();
    if (!this.running.has(i)) {
      let p = this.starting.get(i);
      if (!p) {
        p = this.startIndex(botId, i).finally(() => this.starting.delete(i));
        this.starting.set(i, p);
      }
      await p;
    }
    this.touch(botId);
    return this.info(botId) as DisplayInfo;
  }

  private async startIndex(botId: string, i: number): Promise<void> {
    const token = this.ledger.tokens[botId] as string;
    // Bug #66: the screen (X session, Chrome and its profile) runs as the Bot's own account once the box is migrated.
    const account = botOsUser(this.o.cfg, botId)?.name;
    const start = () => (account ? this.o.control.start(i, token, account) : this.o.control.start(i, token));
    if ((await start()) === "owned") {
      await this.o.control.stop(i); // a stale owner from a lost ledger; our ledger is the authority
      if ((await start()) === "owned") throw new Error(`Display :${i} is owned by another process`);
    }
    // Item 6: the Bot was deleted while its screen was starting — stop it again; it never runs for a retired Bot.
    if (this.retired.has(botId)) {
      await this.o.control.stop(i);
      throw new Error("This Bot was deleted.");
    }
    this.running.add(i);
    this.gens.set(i, (this.gens.get(i) ?? 0) + 1);
    this.publish();
    this.o.onStarted?.(botId, i);
  }

  /**
   * BRW-03's advisory busy marker. It used to be a plain writeFileSync on /tmp/bot-monitor-busy-<i>:
   * a fully predictable name in a directory the Bot shares (bot-shell's systemd-run --uid=box has
   * no PrivateTmp, and /tmp's sticky bit only protects names that already exist), so the Bot could
   * pre-plant every index as a symlink and have bothost truncate whatever it pointed at — silently,
   * because the failure was swallowed. It now lives in a bothost-private folder and is published
   * through the shared host-owned writer (host-owned chain, O_EXCL|O_NOFOLLOW temp file, rename),
   * and a refused write is logged once per index instead of being lost.
   */
  touch(botId: string): void {
    const t = this.now();
    this.lastUse.set(botId, t);
    const i = this.ledger.assignments[botId];
    if (i === undefined) return;
    const dir = this.busyDir();
    if (!writeHostOwnedFileAtomic(path.dirname(dir), dir, `bot-monitor-busy-${i}`, String(t), 0o640) && !this.busyWarned.has(i)) {
      this.busyWarned.add(i);
      log.warn("busy marker write refused", { dir, index: i });
    }
  }

  private busyWarned = new Set<number>();

  private busyDir(): string {
    return this.o.busyDir ?? path.join(this.o.cfg.hostPrivate, "busy");
  }

  lastActivity(botId: string): number {
    return this.lastUse.get(botId) ?? 0;
  }

  generation(botId: string): number {
    const i = this.ledger.assignments[botId];
    return i === undefined ? 0 : this.gens.get(i) ?? 0;
  }

  xenv(index: number): XEnv {
    return { display: `:${index}`, xauthority: path.join(this.o.xauthDir ?? "/run/bot-x", `${index}.xauth`) };
  }

  x(botId: string): XRunner {
    const i = this.ledger.assignments[botId];
    if (i === undefined || !this.running.has(i)) throw new Error("This Bot's screen is not running.");
    return new XRunner(this.o.exec ?? execBuf, this.xenv(i), this.o.capture);
  }

  private async stopIndexFor(i: number): Promise<void> {
    if (!this.running.has(i)) return;
    await this.o.control.stop(i);
    this.running.delete(i);
    this.publish();
  }

  async stop(botId: string): Promise<void> {
    const i = this.ledger.assignments[botId];
    if (i === undefined) return;
    await this.stopIndexFor(i);
  }

  /** I6: release the Bot's screen for good (it was deleted). */
  async retire(botId: string): Promise<void> {
    this.retired.add(botId);
    // Item 6: wait for a start already in flight (it stops the screen itself once it sees the retired flag).
    const i = this.ledger.assignments[botId];
    const inflight = i === undefined ? undefined : this.starting.get(i);
    if (inflight) await inflight.catch(() => {});
    await this.release(botId);
  }

  async release(botId: string): Promise<void> {
    await this.stop(botId);
    delete this.ledger.assignments[botId];
    delete this.ledger.tokens[botId];
    this.lastUse.delete(botId);
    this.idleSince.delete(botId);
    this.persist();
    this.publish();
  }

  async tick(): Promise<void> {
    const t = this.now();
    for (const [botId, i] of Object.entries(this.ledger.assignments)) {
      // Controller ruling 1: a Bot continuously idle (no turn, no takeover, no open preview/view, no
      // box-help) for screenIdleMs loses its seat outright, not just its X server.
      if (this.o.idle) {
        if (this.o.idle(botId)) {
          const since = this.idleSince.get(botId) ?? t;
          this.idleSince.set(botId, since);
          if (t - since >= LIMITSC.screenIdleMs) { await this.release(botId); continue; }
        } else {
          this.idleSince.delete(botId);
        }
      }
      if (this.running.has(i) && t - this.lastActivity(botId) >= LIMITSC.displayIdleStopMs) await this.stop(botId);
    }
    for (const botId of [...this.waiting]) {
      if (this.indexFor(botId) !== null) this.waiting.delete(botId);
    }
  }

  async reconcile(): Promise<void> {
    for (const [botId, i] of Object.entries(this.ledger.assignments)) {
      if ((await this.o.control.status(i)) === "running") {
        this.running.add(i);
        this.gens.set(i, 1);
        this.lastUse.set(botId, this.now());
      }
    }
    this.publish();
  }
}
