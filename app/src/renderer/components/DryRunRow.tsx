import { useEffect, useState } from "react";
import { STR, STRAL, type DryRunMode } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { callQuiet } from "../bridge";
import { useUi } from "../store";
import { Segmented } from "./Segmented";

const MODES: readonly DryRunMode[] = ["off", "turn", "on"];

/**
 * 5.6: dry run for this Bot on this Mac (Off · Next turn · On), kept by the coordinator like the other per-Bot Mac
 * switches. The choice shows at once; the Mac's read-back is the truth, and a failed save goes back with an error.
 */
export function DryRunRow({ botId }: { botId: string }) {
  const connected = useUi((s) => s.connection.kind === "connected");
  const r = useAsync(() => callQuiet("getLocalDryRun", { id: botId }), [botId, connected]);
  const [pending, setPending] = useState<DryRunMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPending(null); setError(null); }, [botId]);
  const saved = r.status === "ready" ? r.value.mode : null;
  const set = (mode: DryRunMode) => {
    if (saved === null || mode === (pending ?? saved)) return;
    setPending(mode);
    setError(null);
    void callQuiet("setLocalDryRun", { id: botId, mode }).then(
      (res) => { r.setValue(res); if (res.mode !== mode) setError(STR.settingNotSaved); },
      (e: unknown) => setError(`${STR.settingNotSaved} ${e instanceof Error ? e.message : String(e)}`.trim()),
    ).finally(() => setPending(null));
  };
  return (
    <div className="settings-row" data-setting="dry-run">
      <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
        <span>{STRAL.dryRun}</span>
        {r.status === "error" && <span className="error" role="alert">{r.message || STR.settingNotLoaded}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      <Segmented label={STRAL.dryRun} value={pending ?? saved} options={MODES.map((m) => ({ value: m, label: STRAL.dryRunModes[m] }))} onChange={set} />
    </div>
  );
}

/** 5.6: the Bot's own Activity (Settings → Activity, filtered to it). */
export function ActivityEntry({ botId }: { botId: string }) {
  const open = useUi((s) => s.openSettings);
  return (
    <div className="settings-row" data-setting="activity">
      <span className="grow">{STRAL.activityLink}</span>
      <button type="button" className="btn-outline small" aria-label={`${STRAL.activityLink}: open`} onClick={() => open(`activity/${botId}`)}>Open</button>
    </div>
  );
}
