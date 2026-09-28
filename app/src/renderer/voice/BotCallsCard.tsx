import { useEffect, useState } from "react";
import { STR, STRV } from "@synapse/shared";
import { call } from "../bridge";
import { nativeCall } from "../native";
import { useUi } from "../store";

type Quiet = { start: string; end: string } | null;
const DEFAULT: NonNullable<Quiet> = { start: "22:00", end: "08:00" };
type Choice = "ask" | "yes" | "no";
const toChoice = (v: boolean | null | undefined): Choice => (v === true ? "yes" : v === false ? "no" : "ask");

/** Settings → Voice: when a Bot may ring (quiet hours; Focus is always respected) and which Bots may call at all. */
export function BotCallsCard() {
  const [quiet, setQuiet] = useState<Quiet | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const bots = useUi((s) => s.bots);
  // settings-persist: a failed read used to show the default window as if it were saved.
  useEffect(() => { void nativeCall<{ quietHours?: Quiet }>("calls.quiet.get").then((r) => setQuiet(r?.quietHours === undefined ? DEFAULT : r.quietHours), () => { setQuiet(DEFAULT); setErr(STR.settingNotLoaded); }); }, []);
  const saveQuiet = (q: Quiet) => {
    const was = quiet;
    setQuiet(q);
    // settings-persist: a failed save goes back to what is saved (it used to leave the new value on screen).
    void nativeCall<{ quietHours: Quiet }>("calls.quiet.set", { quietHours: q }).then(() => setErr(null), () => { setQuiet(was); setErr(STR.settingNotSaved); });
  };
  // The choice shows the Bot's saved value (the host's event); a refused save says so here as well as in the banner.
  const setPermission = (id: string, c: Choice) =>
    void call("setBotCallPermission", { id, mayCall: c === "yes" ? true : c === "no" ? false : null }).then(() => setErr(null), () => setErr(STR.settingNotSaved));
  const list = Object.values(bots).filter((b) => !b.archived && !b.group);
  if (quiet === undefined) return null;
  return (
    <div className="settings-card bot-calls-card">
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{STRV.callsFromBots}</span>
      </div>
      <div className="settings-row quiet-hours">
        <span style={{ flexGrow: 1 }}>{STRV.quietHours}</span>
        {quiet && (
          <>
            <label>{STRV.quietFrom} <input type="time" aria-label={STRV.quietFrom} value={quiet.start} onChange={(e) => e.target.value && saveQuiet({ ...quiet, start: e.target.value })} /></label>
            <label>{STRV.quietTo} <input type="time" aria-label={STRV.quietTo} value={quiet.end} onChange={(e) => e.target.value && saveQuiet({ ...quiet, end: e.target.value })} /></label>
          </>
        )}
        <button type="button" role="switch" aria-checked={quiet !== null} aria-label={STRV.quietHours} className={quiet ? "switch on" : "switch"} onClick={() => saveQuiet(quiet ? null : DEFAULT)} />
      </div>
      {err && <span className="error" role="alert">{err}</span>}
      {list.map((b) => (
        <div className="settings-row" key={b.id}>
          <label htmlFor={`may-call-${b.id}`} style={{ flexGrow: 1 }}>{b.profile.name}</label>
          <select id={`may-call-${b.id}`} className="dropdown" aria-label={STRV.mayCall(b.profile.name)} value={toChoice(b.settings.mayCall)} onChange={(e) => setPermission(b.id, e.target.value as Choice)}>
            {(["ask", "yes", "no"] as const).map((c) => <option key={c} value={c}>{STRV.mayCallChoices[c]}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}
