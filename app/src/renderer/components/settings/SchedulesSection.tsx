import { useCallback, useEffect, useState } from "react";
import { STR, STRS, type RoutineView } from "@synapse/shared";
import { call, callQuiet } from "../../bridge";
import { StandupCard } from "../../standup/StandupCard";
import { useStandup, wireStandup } from "../../standup/store";
import { useUi } from "../../store";
import { ScheduleLabel } from "../ScheduleLabel";
import { registerSettingsSection } from "./sections";

/** Settings → Schedules: every Bot's schedules and triggers in one list, and the daily standup. */
export function SchedulesSection() {
  const bots = useUi((s) => s.bots);
  const openBot = useUi((s) => s.openBot);
  const openRoutine = useUi((s) => s.openRoutine);
  const closeSettings = useUi((s) => s.closeSettings);
  const [all, setAll] = useState<RoutineView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void callQuiet("listAllAutomations", {}).then((r) => setAll(r.routines), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  // A Bot's own list changing (a tool edit, a run) reloads this one.
  const perBot = useUi((s) => s.routines);
  useEffect(load, [perBot, load]);

  const standup = useStandup();
  useEffect(() => { wireStandup(); void standup.load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = standup.view?.settings;

  const toggle = async (r: RoutineView) => {
    await call("setAgentAutomationEnabled", { id: r.botId, routineId: r.id, enabled: !r.enabled });
    load();
  };
  const open = async (r: RoutineView) => {
    closeSettings();
    await openBot(r.botId);
    openRoutine(r.id);
  };
  const byBot = new Map<string, RoutineView[]>();
  for (const r of all ?? []) byBot.set(r.botId, [...(byBot.get(r.botId) ?? []), r]);

  return (
    <>
      <h2>{STRS.schedules}</h2>
      <div className="settings-card">
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span id="standup-label">{STRS.standup}</span></span>
          <button type="button" role="switch" aria-checked={st?.enabled ?? false} aria-labelledby="standup-label" className={st?.enabled ? "switch on" : "switch"} disabled={!st}
            onClick={() => void standup.update({ enabled: !st?.enabled })} />
        </div>
        {st?.enabled && (
          <>
            <div className="settings-row">
              <label htmlFor="standup-time" style={{ flexGrow: 1 }}>{STRS.standupTime}</label>
              <input id="standup-time" type="time" className="text-input" value={st.time} onChange={(e) => e.target.value && void standup.update({ time: e.target.value })} />
            </div>
            {/* UI-controls pass (2026-09-29): an on/off setting in a Settings row is a switch, right-aligned,
                like every other row here — these two were the only checkboxes in a Settings row. */}
            <div className="settings-row">
              <span id="standup-weekdays-label" style={{ flexGrow: 1 }}>{STRS.standupWeekdays}</span>
              <button type="button" role="switch" aria-checked={st.weekdaysOnly} aria-labelledby="standup-weekdays-label" className={st.weekdaysOnly ? "switch on" : "switch"}
                onClick={() => void standup.update({ weekdaysOnly: !st.weekdaysOnly })} />
            </div>
            <div className="settings-row">
              <span id="standup-spoken-label" style={{ flexGrow: 1 }}>{STRS.standupSpoken}</span>
              <button type="button" role="switch" aria-checked={st.spoken} aria-labelledby="standup-spoken-label" className={st.spoken ? "switch on" : "switch"}
                onClick={() => void standup.update({ spoken: !st.spoken })} />
            </div>
          </>
        )}
        <div className="settings-row">
          <span className="muted" style={{ flexGrow: 1 }}>{standup.view?.latest ? "" : STRS.standupNone}</span>
          <button type="button" className="btn-outline small" disabled={standup.running} onClick={() => void standup.runNow()}>{standup.running ? STR.loading : STRS.standupRunNow}</button>
        </div>
      </div>
      {standup.view?.latest && <StandupCard card={standup.view.latest} />}

      {error && <div className="routines-empty"><span className="error" role="alert">{error}</span> <button type="button" className="link-btn" onClick={load}>{STR.retry}</button></div>}
      {all && all.length === 0 && <p className="muted">{STRS.schedulesEmpty}</p>}
      {[...byBot].map(([botId, list]) => (
        <div key={botId} className="settings-card schedules-bot">
          <div className="settings-row schedules-bot-name">{bots[botId]?.profile.name ?? botId}</div>
          {list.map((r) => (
            <div key={r.id} className="settings-row">
              <button type="button" className="link-btn schedules-open" style={{ flexGrow: 1, textAlign: "left" }} onClick={() => void open(r)}>
                <span className="routine-name">{r.name}</span>
                <ScheduleLabel routine={r} />
                {r.quietHours && <span className="muted"> · {STRS.quietHours} {r.quietHours}</span>}
              </button>
              <button type="button" role="switch" aria-checked={r.enabled} aria-label={`${r.name}: ${r.enabled ? "active" : STR.paused}`} className={r.enabled ? "switch on" : "switch"}
                onClick={() => void toggle(r)} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

registerSettingsSection("schedules", STRS.schedules, SchedulesSection);
