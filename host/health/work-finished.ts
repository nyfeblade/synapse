import { HEALTH_LIMITS, type SseEvent, type WorkNotify } from "@synapse/shared";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { SettledTurn, TurnObserver } from "../runner/observers";

/** The first line the Bot sent, as plain text, capped. */
export function summarize(text: string, max: number = HEALTH_LIMITS.summaryMax): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#>~]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Wakes that carry on the owner's task (what it was waiting for came back); their words can close it. */
const CONTINUES: ReadonlySet<string> = new Set(["shell-done", "subagent-done", "coding-agent", "box-handback", "approval-resume", "secret-provided", "mcp-auth", "restart-resume"]);

interface Task { startedAt: number; endedAt: number; summary: string | null; timer: unknown }

export interface WorkFinishedDeps {
  publish(e: SseEvent): void;
  now(): number;
  isIdle(botId: string): boolean;
  bot(botId: string): { name: string; notify: boolean } | null;
  setting(): { mode: WorkNotify; telegram: boolean };
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/**
 * 4.4: "<Bot> finished: <summary>" when a task the owner started is done. A task is the owner's turn plus whatever
 * follows it closely (a reply nudge, the shell it was waiting on); it is done once the Bot has been idle for
 * HEALTH_LIMITS.taskSettleMs. Heartbeats, scheduled runs that didn't ask, other Bots' messages and every silent wake
 * never start one. Settings → Work finished (On, Only long tasks, Off) is applied here; the coordinator adds the
 * focus rule (not while the owner is looking at that chat) and coalesces bursts.
 */
export class WorkFinished implements TurnObserver {
  private tasks = new Map<string, Task>();

  constructor(private d: WorkFinishedDeps) {}

  onEvent(botId: string): void {
    // The Bot is working again: the task goes on.
    const t = this.tasks.get(botId);
    if (t && t.timer !== null) { this.d.clearTimer(t.timer); t.timer = null; }
  }

  onSettled(s: SettledTurn): void {
    let t = this.tasks.get(s.botId);
    if (!t && !s.ownerTask && !s.notifyRequested) return;
    if (s.stopped) { this.drop(s.botId); return; } // the owner stopped it: they know
    if (!t) { t = { startedAt: s.startedAt, endedAt: s.endedAt, summary: null, timer: null }; this.tasks.set(s.botId, t); }
    const said = s.sentTexts.map((x) => summarize(x)).filter(Boolean).at(-1);
    if (said && (s.ownerTask || s.notifyRequested || CONTINUES.has(s.source))) t.summary = said;
    t.endedAt = s.endedAt;
    this.arm(s.botId, t);
  }

  forget(botId: string): void { this.drop(botId); }

  private arm(botId: string, t: Task): void {
    if (t.timer !== null) this.d.clearTimer(t.timer);
    t.timer = this.d.setTimer(() => { t.timer = null; this.finish(botId); }, HEALTH_LIMITS.taskSettleMs);
  }

  private drop(botId: string): void {
    const t = this.tasks.get(botId);
    if (t?.timer != null) this.d.clearTimer(t.timer);
    this.tasks.delete(botId);
  }

  private finish(botId: string): void {
    const t = this.tasks.get(botId);
    if (!t) return;
    if (!this.d.isIdle(botId)) { this.arm(botId, t); return; }
    this.tasks.delete(botId);
    const bot = this.d.bot(botId);
    // Nothing said, nothing to report (a Bot that stayed silent has no "finished: …" to show).
    if (!bot || !bot.notify || !t.summary) return;
    const { mode, telegram } = this.d.setting();
    if (mode === "off") return;
    if (mode === "long" && t.endedAt - t.startedAt < HEALTH_LIMITS.longTaskMs) return;
    this.d.publish({ channel: "work-finished", payload: { botId, name: bot.name, summary: t.summary, startedAt: t.startedAt, endedAt: t.endedAt, telegram } });
  }
}

export function createWorkFinishedModule(ctx: Pick<ModuleContext, "hub" | "bots" | "settings" | "now" | "isIdle">): HostModule {
  const w = new WorkFinished({
    publish: (e) => ctx.hub.publish(e), now: ctx.now, isIdle: ctx.isIdle, setting: () => ctx.settings.workNotify(),
    bot: (id) => {
      if (!ctx.bots.has(id)) return null;
      const b = ctx.bots.summary(id);
      return { name: b.profile.name, notify: b.settings.notifyOnAgentUpdates && !b.settings.hiddenFromSidebar && !b.group };
    },
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const off = ctx.hub.subscribe((e) => { if (e.channel === "agents") w.forget(e.payload.removedId); });
  return { name: "work-finished", handlers: {}, observers: [w], stop: () => { off(); } };
}
