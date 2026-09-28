import { useCallback, useEffect, useRef, useState } from "react";
import { STR } from "@synapse/shared";
import { nativeCall } from "../native";

/**
 * settings-persist: a switch that shows a SAVED value. Until that value has been read it draws no switch at all —
 * a neutral placeholder, never an Off (or an On) standing in for an answer nobody has — and while a save is in
 * flight it takes no second click, so a fast double-click can't race itself.
 */
export function SavedSwitch({ label, value, busy = false, failed = false, onToggle }: { label: string; value: boolean | null; busy?: boolean; failed?: boolean; onToggle(): void }) {
  if (value === null) {
    // A failed read is explained beside the row (an error line with Retry); a pending one says it is loading.
    return failed ? null : <span className="muted switch-pending" role="status" aria-label={label}>{STR.loading}</span>;
  }
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} aria-busy={busy} disabled={busy}
      className={value ? "switch on" : "switch"} onClick={() => { if (!busy) onToggle(); }} />
  );
}

/**
 * One boolean kept by the main process behind `<get>` / `<set>` native handlers ({ on }). Read once; a toggle
 * flips at once, takes the handler's answer as the truth, and a failure goes back to the LAST CONFIRMED value
 * (never to whatever happened to be on screen) and reports `settingNotSaved`.
 */
export function useSavedNativeSwitch(get: string, set: string, onError: (m: string | null) => void): { value: boolean | null; failed: boolean; busy: boolean; toggle(): void } {
  const [value, setValue] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmed = useRef<boolean | null>(null);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    let live = true;
    void nativeCall<{ on?: unknown }>(get).then(
      (r) => { if (!live) return; const v = r?.on !== false; confirmed.current = v; setValue(v); },
      () => { if (!live) return; setFailed(true); report.current(STR.settingNotLoaded); },
    );
    return () => { live = false; };
  }, [get]);
  const toggle = useCallback(() => {
    if (busy || confirmed.current === null) return;
    const want = !confirmed.current;
    setBusy(true);
    setValue(want);
    report.current(null);
    void nativeCall<{ on?: unknown }>(set, { on: want }).then(
      (r) => {
        const kept = typeof r?.on === "boolean" ? r.on : want;
        confirmed.current = kept;
        setValue(kept);
        if (kept !== want) report.current(STR.settingNotSaved);
      },
      () => { setValue(confirmed.current); report.current(STR.settingNotSaved); },
    ).finally(() => setBusy(false));
  }, [busy, set]);
  return { value, failed, busy, toggle };
}
