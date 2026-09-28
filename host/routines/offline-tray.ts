import { STR, type Tray } from "@synapse/shared";
import type { TrayService } from "../trays/trays";
import type { RoutineStore } from "./routine-store";
import type { SchedulerDb } from "./scheduler-db";

const keyOf = (botId: string) => `${botId}:offline-skips`;

/** D5-A / ORIG-02 §02.5: one tray per Bot, detail = up to 5 routine names with counts; no run-history entries. */
export function raiseOfflineTrays(d: { db: SchedulerDb; store: RoutineStore; trays: TrayService }, botIds: string[]): void {
  for (const botId of new Set(botIds)) {
    const skips = d.db.offlineSkips(botId).sort((a, b) => b.count - a.count);
    if (!skips.length) continue;
    const total = skips.reduce((n, s) => n + s.count, 0);
    const names = skips.slice(0, 5).map((s) => `${d.store.get(botId, s.routineId)?.def.name ?? s.routineId} (${s.count})`);
    const more = skips.length > 5 ? `, and ${skips.length - 5} more` : "";
    for (const t of d.trays.list()) if (t.dedupeKey === keyOf(botId)) d.trays.dismiss(t.id);
    d.trays.add({ botId, title: STR.traySkippedOffline(total), detail: `${names.join(", ")}${more}`, dedupeKey: keyOf(botId) });
  }
}

/** The counts reset when the user dismisses the tray. */
export function onOfflineTrayDismissed(db: SchedulerDb, tray: Tray): void {
  if (tray.botId && tray.dedupeKey === keyOf(tray.botId)) db.clearOfflineSkips(tray.botId);
}
