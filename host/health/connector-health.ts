import {
  HEALTH_BOT_NOTE, HEALTH_LIMITS, STRGS, STR_HEALTH, isBadHealth,
  type ConnectorHealthView, type ConnectorKind, type HealthFix, type HealthState, type SseEvent, type Tray, type TrayButton,
} from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

/** What a connector's adapter says about it right now. */
export interface HealthReport {
  kind: ConnectorKind;
  name: string;
  state: HealthState;
  reason?: string | null;
  fix?: HealthFix | null;
  /** A network-type failure: it only reads Broken once it has lasted HEALTH_LIMITS.networkGraceMs. */
  network?: boolean;
}

/** One tool call's outcome, for connectors whose tools a Bot calls (MCP servers, Google, Composio apps). */
export type ToolOutcome = { ok: true } | { ok: false; auth: boolean; reason: string };

interface Persisted {
  /** Connectors that have worked at least once: only these can "break" (a new server waiting for its first
   *  sign-in is setup, not a break, and never raises a tray or a notification). */
  everOk: string[];
  /** The open break per connector and when it notified: one notification per break, across host restarts. */
  alerted: Record<string, number>;
  lastAlertAt: Record<string, number>;
  /** Connectors whose only source is an event (a Bot's GitHub sign-in), so they are still listed after a restart. */
  kept: Record<string, HealthReport>;
}

export interface HealthDeps {
  publish(e: SseEvent): void;
  trays: { add(t: { botId: string | null; title: string; detail?: string; dedupeKey?: string; buttons?: TrayButton[] }): Tray; list(): Tray[]; dismiss(id: string): void };
  now(): number;
  /** Where the break record is kept; null = memory only (tests). */
  file: string | null;
  /** Whether this Bot uses the connector (it hears about a break in its next turn). */
  uses(botId: string, c: ConnectorHealthView): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

const KIND_ORDER: ConnectorKind[] = ["provider", "google", "composio", "mcp", "github", "telegram"];
const trayKey = (id: string) => `health:${id}`;
const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
};

/**
 * 4.4: the one health model. Adapters `report()` a connector's state from its own signals; `noteTool()` adds what
 * the Bots' tool calls show (an auth error, failures in a row). The effective state drives, per break: one tray with
 * Fix, one macOS notification (coalesced, flap-guarded, remembered across restarts), and a note in the next turn of
 * each Bot that uses it. Recovery closes the tray and tells those Bots it works again.
 */
export class ConnectorHealth {
  private base = new Map<string, HealthReport>();
  private overlay = new Map<string, { state: HealthState; reason: string | null }>();
  private fails = new Map<string, number>();
  private views = new Map<string, ConnectorHealthView>();
  private open = new Set<string>();
  private netSince = new Map<string, number>();
  private graceTimers = new Map<string, unknown>();
  private told = new Map<string, Set<string>>();
  private back = new Map<string, Set<string>>();
  private pending: string[] = [];
  private alertTimer: unknown = null;
  private lastFlush = -Infinity;
  private p: Persisted;

  constructor(private d: HealthDeps) {
    const raw = d.file ? readJson<Partial<Persisted>>(d.file, {}) : {};
    this.p = { everOk: raw.everOk ?? [], alerted: raw.alerted ?? {}, lastAlertAt: raw.lastAlertAt ?? {}, kept: raw.kept ?? {} };
    for (const [id, r] of Object.entries(this.p.kept)) this.report(id, r);
  }

  list(): ConnectorHealthView[] {
    return [...this.views.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  }

  get(id: string): ConnectorHealthView | undefined { return this.views.get(id); }

  /** The adapter's current word on a connector; null = it isn't set up (or was turned off): it leaves the list. */
  report(id: string, r: HealthReport | null): void {
    if (r === null) { this.remove(id); return; }
    const prev = this.base.get(id);
    // A connector that comes back by its own signal (a reconnect, a fresh initialize) drops what its tools said.
    if (r.state === "ok" && prev && isBadHealth(prev.state)) { this.overlay.delete(id); this.fails.delete(id); }
    this.base.set(id, r);
    if (r.kind === "github" && JSON.stringify(this.p.kept[id]) !== JSON.stringify(r)) { this.p.kept[id] = r; this.save(); }
    this.recompute(id);
  }

  /** A Bot's call of one of this connector's tools. Ignored for a connector no adapter has reported. */
  noteTool(id: string, o: ToolOutcome): void {
    if (!this.base.has(id)) return;
    if (o.ok) {
      this.fails.delete(id);
      if (this.overlay.delete(id)) this.recompute(id);
      return;
    }
    if (o.auth) this.overlay.set(id, { state: "needs-sign-in", reason: null });
    else {
      const n = (this.fails.get(id) ?? 0) + 1;
      this.fails.set(id, n);
      if (n < HEALTH_LIMITS.toolFailuresToBreak) return;
      this.overlay.set(id, { state: "broken", reason: clip(o.reason, HEALTH_LIMITS.reasonMax) ?? STR_HEALTH.reasons.failing });
    }
    this.recompute(id);
  }

  /** The line for this Bot's next turn (once per break), or null. */
  noteFor(botId: string): string | null {
    const down = [...this.views.values()].filter((v) => isBadHealth(v.state) && this.open.has(v.id) && !this.told.get(v.id)?.has(botId) && this.d.uses(botId, v));
    for (const v of down) this.told.get(v.id)?.add(botId);
    const back = [...(this.back.get(botId) ?? [])];
    this.back.delete(botId);
    const parts: string[] = [];
    if (down.length) parts.push(HEALTH_BOT_NOTE.down(down.map((v) => (v.state === "needs-sign-in" ? HEALTH_BOT_NOTE.needsSignIn(v.name) : HEALTH_BOT_NOTE.broken(v.name, v.reason)))));
    if (back.length) parts.push(HEALTH_BOT_NOTE.back(back));
    return parts.length ? parts.join("\n") : null;
  }

  /** A deleted Bot. */
  forgetBot(botId: string): void {
    this.back.delete(botId);
    for (const s of this.told.values()) s.delete(botId);
    for (const id of [...this.views.keys()]) if (id === `github:${botId}`) this.remove(id);
  }

  stop(): void {
    if (this.alertTimer !== null) this.d.clearTimer(this.alertTimer);
    this.alertTimer = null;
    for (const t of this.graceTimers.values()) this.d.clearTimer(t);
    this.graceTimers.clear();
  }

  private remove(id: string): void {
    const had = this.views.delete(id);
    this.base.delete(id);
    this.overlay.delete(id);
    this.fails.delete(id);
    this.netSince.delete(id);
    const g = this.graceTimers.get(id);
    if (g !== undefined) { this.d.clearTimer(g); this.graceTimers.delete(id); }
    this.told.delete(id);
    if (this.open.delete(id)) this.dismissTray(id);
    let dirty = false;
    if (id in this.p.alerted) { delete this.p.alerted[id]; dirty = true; }
    if (id in this.p.kept) { delete this.p.kept[id]; dirty = true; }
    if (dirty) this.save();
    if (had) this.publish();
  }

  private effective(id: string, b: HealthReport): { state: HealthState; reason: string | null } {
    const o = this.overlay.get(id);
    const fromBase = isBadHealth(b.state);
    const e = fromBase ? { state: b.state, reason: b.reason ?? null } : o ?? { state: b.state, reason: b.reason ?? null };
    if (!(fromBase && b.state === "broken" && b.network)) {
      this.netSince.delete(id);
      const g = this.graceTimers.get(id);
      if (g !== undefined) { this.d.clearTimer(g); this.graceTimers.delete(id); }
      return e;
    }
    // A network-type failure: Checking until it has lasted the grace period, then Broken.
    const since = this.netSince.get(id) ?? this.d.now();
    this.netSince.set(id, since);
    const left = since + HEALTH_LIMITS.networkGraceMs - this.d.now();
    if (left <= 0) return e;
    if (!this.graceTimers.has(id)) {
      this.graceTimers.set(id, this.d.setTimer(() => { this.graceTimers.delete(id); if (this.base.has(id)) this.recompute(id); }, left));
    }
    return { state: "checking", reason: null };
  }

  private recompute(id: string): void {
    const b = this.base.get(id);
    if (!b) return;
    const { state, reason } = this.effective(id, b);
    const prev = this.views.get(id);
    const view: ConnectorHealthView = {
      id, kind: b.kind, name: b.name, state, reason: state === "broken" ? clip(reason, HEALTH_LIMITS.reasonMax) : null,
      since: prev && prev.state === state ? prev.since : this.d.now(), fix: b.fix ?? null,
    };
    this.views.set(id, view);
    if (state === "ok" && !this.p.everOk.includes(id)) { this.p.everOk.push(id); this.save(); }
    if (isBadHealth(state)) {
      if (!this.open.has(id)) {
        // Setup isn't a break: only a connector that worked once (or already broke before a restart) opens one.
        if (this.p.everOk.includes(id) || id in this.p.alerted) this.openBreak(view);
      } else if (prev && (prev.state !== state || prev.reason !== view.reason || prev.name !== view.name)) {
        this.dismissTray(id);
        this.addTray(view);
      }
    } else if (state === "ok" && this.open.has(id)) this.closeBreak(view);
    if (!prev || prev.state !== view.state || prev.reason !== view.reason || prev.name !== view.name || JSON.stringify(prev.fix) !== JSON.stringify(view.fix)) this.publish();
  }

  private openBreak(v: ConnectorHealthView): void {
    this.open.add(v.id);
    this.told.set(v.id, new Set());
    this.addTray(v);
    const now = this.d.now();
    if (v.id in this.p.alerted) return; // this break already notified (before a restart)
    this.p.alerted[v.id] = now;
    // A connector flapping (broke, came back, broke again within the hour) keeps its tray but doesn't notify again.
    if (now - (this.p.lastAlertAt[v.id] ?? -Infinity) >= HEALTH_LIMITS.alertFlapMs) {
      this.p.lastAlertAt[v.id] = now;
      this.queueAlert(v.id);
    }
    this.save();
  }

  private closeBreak(v: ConnectorHealthView): void {
    this.open.delete(v.id);
    this.dismissTray(v.id);
    delete this.p.alerted[v.id];
    this.save();
    for (const botId of this.told.get(v.id) ?? []) {
      const s = this.back.get(botId) ?? new Set<string>();
      s.add(v.name);
      this.back.set(botId, s);
    }
    this.told.delete(v.id);
  }

  private title(v: ConnectorHealthView): string {
    return v.state === "needs-sign-in" ? STR_HEALTH.trayNeedsSignIn(v.name) : STR_HEALTH.trayBroken(v.name);
  }

  private addTray(v: ConnectorHealthView): void {
    this.d.trays.add({
      botId: v.fix?.kind === "github" ? v.fix.botId : null, title: this.title(v), ...(v.reason ? { detail: v.reason } : {}), dedupeKey: trayKey(v.id),
      buttons: [
        ...(v.fix ? [{ label: STR_HEALTH.fix, action: "fix-connector" as const, target: v.id }] : []),
        // Google keeps its second way back: a Bot clicks through the sign-in (google-setup).
        ...(v.fix?.kind === "google" ? [{ label: STRGS.letABotClick, action: "reconnect-google-bot" as const }] : []),
      ],
    });
  }

  private dismissTray(id: string): void {
    for (const t of this.d.trays.list().filter((x) => x.dedupeKey === trayKey(id))) this.d.trays.dismiss(t.id);
  }

  private queueAlert(id: string): void {
    if (!this.pending.includes(id)) this.pending.push(id);
    if (this.alertTimer !== null) return;
    const wait = Math.max(HEALTH_LIMITS.alertCoalesceMs, this.lastFlush + HEALTH_LIMITS.alertMinGapMs - this.d.now());
    this.alertTimer = this.d.setTimer(() => { this.alertTimer = null; this.flush(); }, wait);
  }

  /** One notification for everything that broke in the window (only what is still broken when it goes out). */
  private flush(): void {
    const list = this.pending.splice(0).map((id) => this.views.get(id)).filter((v): v is ConnectorHealthView => !!v && isBadHealth(v.state));
    if (!list.length) return;
    this.lastFlush = this.d.now();
    const one = list.length === 1 ? list[0]! : null;
    this.d.publish({
      channel: "connector-alert",
      payload: { ids: list.map((v) => v.id), title: one ? this.title(one) : STR_HEALTH.alertMany(list.length), body: one ? one.reason ?? "" : list.map((v) => v.name).join(", ") },
    });
  }

  private publish(): void {
    this.d.publish({ channel: "connector-health", payload: { connectors: this.list() } });
  }

  private save(): void {
    if (this.d.file) writeJsonAtomic(this.d.file, this.p, 0o600);
  }
}

/**
 * A cheap periodic check, only for connectors that offer a free status call (Composio's account status, Google's
 * token refresh). One probe at a time; a probe that couldn't get an answer backs off (15 min, doubling, to a day).
 */
export class HealthProbes {
  private list = new Map<string, { run: () => Promise<boolean>; everyMs: number; nextAt: number; backoff: number }>();
  private timer: unknown = null;
  private busy = false;

  constructor(private d: { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void; tickMs?: number }) {}

  /** `run` resolves true when it got an answer (good or bad), false when it couldn't (then it backs off). */
  set(id: string, run: () => Promise<boolean>, o: { everyMs?: number; firstAt?: number } = {}): void {
    const everyMs = o.everyMs ?? HEALTH_LIMITS.probeEveryMs;
    const cur = this.list.get(id);
    this.list.set(id, { run, everyMs, nextAt: o.firstAt ?? cur?.nextAt ?? this.d.now() + everyMs, backoff: cur?.backoff ?? 0 });
  }

  delete(id: string): void { this.list.delete(id); }
  ids(): string[] { return [...this.list.keys()]; }
  nextAt(id: string): number | null { return this.list.get(id)?.nextAt ?? null; }

  start(): void {
    if (this.timer !== null) return;
    const arm = () => { this.timer = this.d.setTimer(() => { void this.tick().finally(arm); }, this.d.tickMs ?? 60_000); };
    arm();
  }

  stop(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  /** Runs every due probe, oldest first, one after another (never two at once). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.d.now();
      const due = [...this.list.entries()].filter(([, p]) => p.nextAt <= now).sort((a, b) => a[1].nextAt - b[1].nextAt).map(([id]) => id);
      for (const id of due) {
        const p = this.list.get(id);
        if (!p) continue;
        let answered = false;
        try { answered = await p.run(); } catch { answered = false; }
        const cur = this.list.get(id);
        if (!cur) continue;
        if (answered) { cur.backoff = 0; cur.nextAt = this.d.now() + cur.everyMs; }
        else {
          cur.backoff = Math.min(HEALTH_LIMITS.probeMaxBackoffMs, cur.backoff ? cur.backoff * 2 : HEALTH_LIMITS.probeRetryMs);
          cur.nextAt = this.d.now() + cur.backoff;
        }
      }
    } finally { this.busy = false; }
  }
}
