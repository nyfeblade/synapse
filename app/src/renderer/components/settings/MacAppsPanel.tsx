import { useCallback, useEffect, useState } from "react";
import { STRMA, type MacPermission } from "@synapse/shared";
import { nativeCall } from "../../native";

/**
 * mac-apps: Settings → Computer → Apps. macOS needs Accessibility and a separate Automation consent per app
 * before a Bot can touch one, and nothing in code can grant them. So this panel does the three honest things:
 * it says where each capability stands, it triggers the one prompt macOS will raise on demand, and it opens the
 * exact System Settings pane for the rest.
 *
 * It RE-CHECKS ON FOCUS, because granting one of these means leaving the app; coming back is the moment the
 * answer changed. Reading status never raises a prompt, so refreshing costs the user nothing.
 * A denial is a plain line under the row, never a crash and never a retry loop.
 */
export function MacAppsPanel() {
  const [rows, setRows] = useState<MacPermission[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void nativeCall<{ permissions: MacPermission[] }>("macapp.permissions")
      .then((r) => setRows(r.permissions ?? []))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    load();
    // Back from System Settings, having just granted one of these.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const request = async (row: MacPermission) => {
    setBusy(row.id);
    try {
      await nativeCall("macapp.request", { id: row.id }).catch(() => null);
    } finally {
      setBusy(null);
      load();
    }
  };

  return (
    <>
      <h3>{STRMA.appsSection}</h3>
      <div className="settings-card" data-setting="mac-apps">
        <div className="settings-row">
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="btn-outline small" onClick={load}>{STRMA.recheck}</button>
        </div>
        {rows === null
          ? <div className="settings-row"><span className="muted">{STRMA.appsChecking}</span></div>
          : rows.length === 0
            ? <div className="settings-row"><span className="muted">{STRMA.appsUnavailable}</span></div>
            : rows.map((row) => (
              <div className="settings-row" key={row.id}>
                <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.label}>{row.label}</span>
                  {row.detail ? <span className="muted">{row.detail}</span> : null}
                </span>
                <span className="status-chip" role="status" aria-label={`${row.label}: ${STRMA.stateLabel[row.state]}`}>
                  {row.state === "granted" ? <span className="dot approved" aria-hidden="true" /> : null}
                  {STRMA.stateLabel[row.state]}
                </span>
                {row.state === "granted" ? null : row.state === "unknown" ? (
                  <button type="button" className="btn-outline small" disabled={busy === row.id} onClick={() => void request(row)}>{STRMA.turnOn}</button>
                ) : (
                  <button type="button" className="btn-outline small" onClick={() => void nativeCall("macapp.openSettings", { pane: row.pane }).catch(() => {})}>{STRMA.openSettings}</button>
                )}
              </div>
            ))}
      </div>
    </>
  );
}
