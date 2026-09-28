import { useCallback, useEffect, useState } from "react";
import { STR, STRL } from "@synapse/shared";
import { useUi } from "../store";
import { ClockIcon, PauseIcon } from "./Icons";
import { ScheduleLabel } from "./ScheduleLabel";

/** When it next runs, in a word or two: "in 14h", "in 3m", "Tue". Blank when nothing is scheduled. */
function nextLabel(at: number | null): string {
  if (!at) return "";
  const ms = at - Date.now();
  if (ms <= 0) return "due";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The board's clock glyph (Main.dc.html right panel). */
const BoardClock = () => (
  <ClockIcon />
);

export function RoutinesSection({ botId }: { botId: string }) {
  const routines = useUi((s) => s.routines[botId]);
  const loadRoutines = useUi((s) => s.loadRoutines);
  const openRoutine = useUi((s) => s.openRoutine);
  const [error, setError] = useState<string | null>(null);
  // Hand-testing round: the rejection used to go into an empty catch, so `routines` stayed
  // undefined and both branches below stayed hidden — the section was its header over nothing,
  // with "still loading", "no routines" and "the call failed" all looking identical.
  const load = useCallback(() => {
    setError(null);
    void loadRoutines(botId).catch((e: Error) => setError(e.message));
  }, [botId, loadRoutines]);
  useEffect(load, [load]);
  return (
    <section aria-label={STR.routines} className="routines">
      <div className="routines-head">{STR.routines}</div>
      {!routines && (error
        ? <div className="routines-empty"><span className="error" role="alert">{error}</span> <button type="button" className="link-btn" onClick={load}>{STR.retry}</button></div>
        : <p className="routines-empty">{STR.loading}</p>)}
      {routines && routines.length === 0 && <p className="routines-empty pcard-empty">{STRL.scheduledEmpty}</p>}
      {routines?.map((r) => (
        <button key={r.id} type="button" className="routine-row" aria-label={`${r.name}, ${r.enabled ? r.description : STR.paused}`} onClick={() => openRoutine(r.id)}>
          <span className="routine-icon">{r.enabled ? <BoardClock /> : <PauseIcon />}</span>
          <span className="routine-text"><span className="routine-name">{r.name}</span><ScheduleLabel routine={r} /></span>
          <span className="routine-next">{nextLabel(r.nextRunAt)}</span>
        </button>
      ))}
    </section>
  );
}
