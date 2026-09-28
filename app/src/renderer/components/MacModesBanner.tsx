import { useMemo, useState } from "react";
import { STR, STR5, type PermMode } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { callQuiet } from "../bridge";
import { useUi } from "../store";
import { Announce } from "./Announce";

/**
 * Bug 256: ONE prompt when Bots the user set to Full auto (or Auto-accept edits) have no such record on this Mac —
 * after a permission reset, or any other time the Mac's own record fell behind. It replaces a silent card per command.
 * The one button records every listed Bot's mode on this Mac (the coordinator answers; the host is never asked).
 */
export function MacModesBanner() {
  const bots = useUi((s) => s.bots);
  const want = useMemo(() => Object.values(bots)
    .filter((b) => b && (b.settings.permMode === "full-auto" || b.settings.permMode === "accept-edits"))
    .map((b) => ({ id: b.id, mode: b.settings.permMode as PermMode })), [bots]);
  const key = want.map((b) => `${b.id}:${b.mode}`).join(",");
  const q = useAsync(() => callQuiet("getLocalPolicyReset", { bots: want }), [key], { enabled: want.length > 0 });
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = q.status === "ready" ? q.value : null;
  if (hidden || !state || state.missing.length === 0) return null;
  const names = state.missing.map((m) => bots[m.id]?.profile.name ?? "Bot");
  const fullAuto = state.missing.every((m) => m.mode === "full-auto");
  const restore = () => {
    setBusy(true);
    setError(null);
    void callQuiet("restoreLocalBotModes", { bots: state.missing })
      .then(() => q.reload(), (e: unknown) => setError(e instanceof Error ? e.message : STR.statusUnavailable))
      .finally(() => setBusy(false));
  };
  const later = () => {
    setHidden(true);
    void callQuiet("dismissLocalPolicyReset", { bots: state.missing }).catch(() => {});
  };
  return (
    <Announce>
      <div role="status" aria-live="polite" data-announcement="mac-modes" className="disk-banner mac-modes-banner">
        <span>{STR5.macModesResetTitle(state.reset, names, fullAuto)}</span>
        {error && <span className="error" role="alert">{error}</span>}
        <button type="button" className="btn-outline small" disabled={busy} onClick={restore}>{STR5.macModesRestore(state.reset, fullAuto)}</button>
        <button type="button" className="btn-outline small" onClick={later}>{STR5.macModesNotNow}</button>
      </div>
    </Announce>
  );
}
