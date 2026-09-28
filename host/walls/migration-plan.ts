import fs from "node:fs";
import path from "node:path";
import { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { SseHub } from "../gateway/sse-hub";
import { HostSettingsStore } from "../store/host-settings";
import { readJson } from "../util/atomic-json";
import { BOT_HOMES, botUserName, cliConfigDirFor } from "./bot-uid";

/**
 * Bug #66: what box/migrate-per-bot-uid.sh moves when the box switches from the one uid `box` to per-Bot accounts.
 * The plan is computed here (bothost can open every Bot's store) and APPLIED by the root script, which re-checks every
 * path it is given (only under the two known roots, no "..", never a link) and journals every move for the rollback.
 *
 *  - account: one per Bot (not per group), created by `bot-user ensure`.
 *  - session: every CLI session file the Bot's store records (current, rolled-over, previous, child subagents), and
 *    the CLI's sibling <sid>/ folder, from /home/box/.claude/projects/ to the same place under the Bot's own
 *    /home/bots/<account>/.claude/projects/. Session files no Bot records stay where they are (0600, uid box's).
 *  - chrome-profile: the profile of the screen the Bot holds (/home/box/.chrome-screens/<n>) becomes its own.
 */
export interface PlanBot { id: string; group: boolean; sessionFiles: string[]; display: number | null }
export type PlanStep =
  | { op: "account"; botId: string; account: string }
  | { op: "move"; what: "session" | "session-dir" | "chrome-profile"; botId: string; account: string; from: string; to: string };

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function buildMigrationPlan(cfg: Pick<HostConfig, "claudeConfigDir" | "boxHome"> & Partial<Pick<HostConfig, "botHomes">>, bots: PlanBot[]): PlanStep[] {
  const homes = cfg.botHomes ?? BOT_HOMES;
  const legacy = path.join(cfg.claudeConfigDir, "projects");
  const steps: PlanStep[] = [];
  for (const b of [...bots].sort((x, y) => x.id.localeCompare(y.id))) {
    if (b.group) continue;
    const account = botUserName(b.id);
    const home = path.join(homes, account);
    const mine = path.join(home, ".claude", "projects");
    steps.push({ op: "account", botId: b.id, account });
    const rels = new Set<string>();
    for (const f of b.sessionFiles) {
      // A record may already point at the Bot's own tree (a host started after a partial migration): same file.
      const base = [legacy, mine].find((r) => f.startsWith(`${r}/`));
      if (!base) continue;
      const rel = f.slice(base.length + 1);
      if (rel.split("/").length !== 2 || rel.includes("..") || !SESSION.test(path.basename(rel))) continue;
      rels.add(rel);
    }
    for (const rel of [...rels].sort()) {
      steps.push({ op: "move", what: "session", botId: b.id, account, from: path.join(legacy, rel), to: path.join(mine, rel) });
      const dir = rel.replace(/\.jsonl$/, "");
      steps.push({ op: "move", what: "session-dir", botId: b.id, account, from: path.join(legacy, dir), to: path.join(mine, dir) });
    }
    if (b.display !== null && b.display >= 2) {
      steps.push({ op: "move", what: "chrome-profile", botId: b.id, account, from: path.join(cfg.boxHome, ".chrome-screens", String(b.display)), to: path.join(home, "chrome-profile") });
    }
  }
  return steps;
}

/** One step per line, tab-separated; paths never contain a tab or newline (checked). */
export function planToTsv(steps: PlanStep[]): string {
  const bad = (s: string) => /[\t\n]/.test(s);
  return steps.map((s) => {
    const cols = s.op === "account" ? ["account", s.botId, s.account] : ["move", s.what, s.botId, s.account, s.from, s.to];
    if (cols.some(bad)) throw new Error("a path in the plan has a tab or newline");
    return cols.join("\t");
  }).join("\n") + (steps.length ? "\n" : "");
}

/** Reads every Bot as the plan needs it, straight from agents/ (the host must be stopped: it opens each store). */
export function readPlanBots(cfg: HostConfig): PlanBot[] {
  const legacyCfg = { ...cfg, perBotUid: false };
  const bots = new BotService({ cfg: legacyCfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  bots.loadAll();
  const ledger = readJson<{ assignments?: Record<string, number> }>(path.join(cfg.hostPrivate, "window-assignments.json"), {});
  const out: PlanBot[] = [];
  for (const id of bots.ids()) {
    const kv = (k: string) => bots.brainKv<{ file?: string }[]>(id, k, []).map((r) => r.file).filter((f): f is string => typeof f === "string");
    const files = [bots.sessionFilePath(id), ...kv("rolledSessionFiles"), ...kv("previousSessionIds"), ...kv("childSessionFiles")].filter((f): f is string => !!f);
    out.push({ id, group: !!bots.summary(id).group, sessionFiles: files, display: ledger.assignments?.[id] ?? null });
  }
  return out;
}

/**
 * Bug #66, on every host start: the session paths a Bot's store records (rolled-over, previous and child sessions)
 * point into the tree the Bot's CLI runs in now, its own account's once migrated and the shared one after a rollback.
 * Idempotent; returns how many records changed.
 */
export function relocateSessionRecords(cfg: HostConfig, bots: Pick<BotService, "ids" | "brainKv" | "setBrainKv">): number {
  const legacy = path.join(cfg.claudeConfigDir, "projects");
  const esc = cfg.botHomes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const perBot = new RegExp(`^${esc}/bot-[0-9a-f]{12}/\\.claude/projects/`);
  let changed = 0;
  for (const id of bots.ids()) {
    const want = path.join(cliConfigDirFor(cfg, id), "projects");
    for (const key of ["rolledSessionFiles", "previousSessionIds", "childSessionFiles"]) {
      const list = bots.brainKv<Record<string, unknown>[]>(id, key, []);
      let dirty = false;
      const next = list.map((r) => {
        const f = r.file;
        if (typeof f !== "string") return r;
        const m = f.startsWith(`${legacy}/`) ? `${legacy}/` : perBot.exec(f)?.[0];
        if (!m) return r;
        const to = path.join(want, f.slice(m.length));
        if (to === f) return r;
        dirty = true;
        changed++;
        return { ...r, file: to };
      });
      if (dirty) bots.setBrainKv(id, key, next);
    }
  }
  return changed;
}

export function runMigrationPlanCommand(cfg: HostConfig): number {
  if (!fs.existsSync(cfg.dataRoot)) { console.error(`no data at ${cfg.dataRoot}`); return 2; }
  process.stdout.write(planToTsv(buildMigrationPlan(cfg, readPlanBots(cfg))));
  return 0;
}
