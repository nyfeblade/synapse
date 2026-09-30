import { useEffect, useState } from "react";
import { MAC_ACTION_FILTERS, STR, STRAL, dryRunTally, type MacActionFilter, type MacActionView } from "@synapse/shared";
import { useAsync } from "../../async-resource";
import { callQuiet } from "../../bridge";
import { nativeCall } from "../../native";
import { blobToBase64 } from "../../uploads";
import { useUi } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { Segmented } from "../Segmented";
import { registerSettingsSection } from "./sections";

/**
 * 5.6: everything a Bot did on this Mac (the coordinator's action log), newest first, with a filter, a Bot picker,
 * Export and an Undo per file change. The log is read from this Mac only; the host never sees it.
 * Opened as "activity" or "activity/<botId>" (a Bot's settings link).
 */
const PAGE = 60;

/** The last three segments of a long path ("…/site/src/index.ts"); the whole one is the row's tooltip. */
export function shortTarget(t: string): string {
  if (!t.startsWith("/")) return t;
  const segs = t.split("/").filter(Boolean);
  return segs.length > 3 ? `…/${segs.slice(-3).join("/")}` : t;
}

function when(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function label(e: MacActionView): string {
  if (e.kind === "browser" || e.kind === "app") return e.act ?? STRAL.kind[e.kind];
  return STRAL.kind[e.kind];
}

function ActivityRow({ e, bot, onUndone }: { e: MacActionView; bot: string; onUndone(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = e.targets.length ? e.targets.map(shortTarget).join(" → ") : (e.command ?? "");
  const full = [...e.targets, ...(e.command ? [e.command] : []), ...(e.detail ? [e.detail] : [])].join("\n");
  const state = [e.dryRun ? STRAL.outcome.simulated : STRAL.outcome[e.outcome], STRAL.via[e.via]].filter(Boolean).join(" · ");
  const undo = async () => {
    if (!(await askConfirm({ title: STRAL.undoConfirm(`${label(e)} ${shortTarget(e.targets[0] ?? "")}`.trim()), verb: STRAL.undoVerb, tone: "neutral" }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await callQuiet("undoMacAction", { id: e.id, confirm: true });
      if (r.ok) onUndone();
      else setError(r.message);
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-row macact-row" data-action-id={e.id} data-kind={e.kind} data-outcome={e.outcome}>
      <span className="macact-time">{when(e.at)}</span>
      <span className="macact-bot" title={bot}>{bot}</span>
      <span className="macact-kind">{label(e)}</span>
      <span className="macact-target grow" title={full}>
        <span className="macact-target-text">{target}</span>
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      <span className={e.outcome === "failed" || e.outcome === "refused" ? "macact-state off" : "macact-state"}>{state}</span>
      <span className="macact-undo">
        {e.undo === "available" && <button type="button" className="btn-outline small" disabled={busy} aria-label={`${STRAL.undo} ${label(e)} ${target}`} onClick={() => void undo()}>{STRAL.undo}</button>}
        {e.undo === "undone" && <span className="muted">{STRAL.undone}</span>}
        {e.undo === "expired" && <span className="muted">{STRAL.expired}</span>}
      </span>
    </div>
  );
}

export function ActivitySection() {
  const focus = useUi((s) => s.settingsFocus);
  const bots = useUi((s) => s.bots);
  const connected = useUi((s) => s.connection.kind === "connected");
  const focusBot = (focus ?? "").startsWith("activity/") ? (focus ?? "").slice("activity/".length) : "";
  const [botId, setBotId] = useState(focusBot);
  const [filter, setFilter] = useState<MacActionFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setBotId(focusBot), [focusBot]);
  // Keyed by what is asked (Bot, filter, page): a switch never shows the previous Bot's rows.
  const r = useAsync(() => callQuiet("listMacActions", { ...(botId ? { botId } : {}), filter, limit }), [botId, filter, limit, connected]);
  const { reload } = r;
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  const rows: MacActionView[] | null = r.status === "ready" ? r.value.entries : null;
  const more = r.status === "ready" && r.value.more;
  const load = reload;

  const exportLog = async () => {
    try {
      const r = await callQuiet("exportMacActions", botId ? { botId } : {});
      const bytesBase64 = await blobToBase64(new Blob([r.text], { type: "application/jsonl" }));
      await nativeCall("saveFile", { defaultName: r.fileName, bytesBase64, filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const botName = (id: string) => bots[id]?.profile.name ?? id;
  const names = Object.values(bots).sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  const dry = filter === "dry-run" && rows?.length ? dryRunTally(rows.map((r) => r.kind)) : null;
  return (
    <>
      <h2>{STRAL.section}</h2>
      <div className="macact-bar">
        <Segmented label={STRAL.section} value={filter} options={MAC_ACTION_FILTERS.map((f) => ({ value: f, label: STRAL.filters[f] }))} onChange={(f) => { setFilter(f); setLimit(PAGE); }} />
        <select className="dropdown" aria-label="Bot" value={botId} onChange={(e) => { setBotId(e.target.value); setLimit(PAGE); }}>
          <option value="">{STRAL.allBots}</option>
          {names.map((b) => <option key={b.id} value={b.id}>{b.profile.name}</option>)}
        </select>
        <span className="grow" />
        <button type="button" className="btn-outline small" onClick={() => void exportLog()}>{STRAL.export}</button>
      </div>
      {(error || r.status === "error") && <div className="settings-card"><div className="settings-row"><span className="error grow" role="alert">{error ?? (r.status === "error" ? r.message : "")}</span><button type="button" className="btn-outline small" onClick={load}>{STR.retry}</button></div></div>}
      <div className="settings-card macact-list" data-setting="activity">
        {r.status === "loading" && <div className="settings-row"><span className="muted">{STR.loading}</span></div>}
        {rows?.length === 0 && <div className="settings-row"><span className="muted">{STRAL.empty}</span></div>}
        {dry && <div className="settings-row macact-tally"><span className="grow">{dry[0]!.toUpperCase() + dry.slice(1)}</span></div>}
        {rows?.map((e) => <ActivityRow key={e.id} e={e} bot={botName(e.botId)} onUndone={load} />)}
        {more && <div className="settings-row"><button type="button" className="link-btn" onClick={() => setLimit((l) => l + PAGE)}>{STRAL.more}</button></div>}
      </div>
    </>
  );
}

registerSettingsSection("activity", STRAL.section, ActivitySection);
