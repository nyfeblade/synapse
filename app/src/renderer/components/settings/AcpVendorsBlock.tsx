import { useEffect, useState } from "react";
import { STR, STR_ACP, STR_PROVIDER_UI, type AcpVendorView, type AcpVendorsView } from "@synapse/shared";
import { callQuiet } from "../../bridge";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^[A-Z_]+: /, "") || STR.hostNoAnswer;

/**
 * Settings → Account, the coding CLIs (Wave 3): a Bot can run on a vendor's own coding CLI with the user's own plan.
 * Each vendor needs the one-time consent here; signing in happens per Bot, in its settings, with the vendor's own flow.
 */
export function AcpVendorsBlock() {
  const [view, setView] = useState<AcpVendorsView | null>(null);
  // Quiet: an older host without coding CLIs simply shows no block.
  useEffect(() => { void callQuiet("getAcpVendors", {}).then((v) => { if (Array.isArray(v?.vendors)) setView(v); }).catch(() => {}); }, []);
  // 0.1.6: an install runs in the background on the Bots' computer; while one does, the state is read again every 1.5 s.
  const busy = !!view?.vendors.some((v) => v.install?.state === "installing" || v.install?.state === "removing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { void callQuiet("getAcpVendors", {}).then((v) => { if (Array.isArray(v?.vendors)) setView(v); }).catch(() => {}); }, 1500);
    return () => clearInterval(t);
  }, [busy]);
  if (!view) return null;
  return (
    <div className="settings-card providers-block" data-setting="coding-clis">
      <h3>{STR_ACP.sectionTitle}</h3>
      {view.accountsNeeded && (
        <section className="provider-consent" aria-label={STR_ACP.accountsTitle}>
          <h4>{STR_ACP.accountsTitle}</h4>
          <p>{STR_ACP.accounts}</p>
        </section>
      )}
      {view.vendors.map((v) => <VendorRow key={v.id} v={v} accountsNeeded={!!view.accountsNeeded} onView={setView} />)}
    </div>
  );
}

function InstallControls({ v, accountsNeeded, onView }: { v: AcpVendorView; accountsNeeded: boolean; onView(x: AcpVendorsView): void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = v.install;
  if (!i) return null;
  const act = async (cmd: "installAcpVendor" | "removeAcpVendor") => {
    setError(null);
    try { onView(await callQuiet(cmd, { vendor: v.id })); setAsking(false); } catch (e) { setError(reason(e)); }
  };
  return (
    <>
      <div className="settings-row acp-install">
        <span className="grow muted" role="status">
          {i.state === "installed" ? STR_ACP.installed(i.version) : i.state === "installing" ? STR_ACP.installing : i.state === "removing" ? STR_ACP.removing
            : i.state === "unavailable" ? (i.pinned ? STR_ACP.offBox : STR_ACP.noVerifiedPackage) : STR_ACP.notInstalledShort}
        </span>
        {i.state === "not-installed" && !asking && <button type="button" className="btn-outline" disabled={accountsNeeded} onClick={() => setAsking(true)}>{STR_ACP.install}</button>}
        {i.state === "installed" && <button type="button" className="btn-outline" onClick={() => void act("removeAcpVendor")}>{STR_ACP.remove}</button>}
      </div>
      {asking && i.pinned && i.package && (
        <section aria-label={STR_ACP.installTitle(v.id, i.pinned)} className="provider-consent">
          <h4>{STR_ACP.installTitle(v.id, i.pinned)}</h4>
          <p>{STR_ACP.installText(v.id, i.package, i.pinned)}</p>
          <div className="settings-row">
            <span className="grow" />
            <button type="button" className="btn-outline" onClick={() => setAsking(false)}>{STR_PROVIDER_UI.consentCancel}</button>
            <button type="button" className="btn-primary" onClick={() => void act("installAcpVendor")}>{STR_ACP.install}</button>
          </div>
        </section>
      )}
      {(error ?? i.error) && <p role="alert" className="error">{error ?? i.error}</p>}
    </>
  );
}

function VendorRow({ v, accountsNeeded, onView }: { v: AcpVendorView; accountsNeeded: boolean; onView(x: AcpVendorsView): void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allow = async () => {
    setBusy(true);
    setError(null);
    try { onView(await callQuiet("consentAcpVendor", { vendor: v.id, textVersion: v.consentVersion })); setAsking(false); } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  return (
    <div className="provider-row" aria-label={v.label}>
      <div className="settings-row">
        <strong className="grow">{v.label}</strong>
        <span className="model-badge experimental">{STR_ACP.experimental}</span>
        <span className="muted">{v.planNote}</span>
        {!v.consented && !asking && <button type="button" className="btn-outline" disabled={busy} onClick={() => setAsking(true)}>{STR_PROVIDER_UI.allow}</button>}
        {v.consented && <span className="muted">{STR_PROVIDER_UI.allowed}</span>}
      </div>
      {asking && (
        <section aria-label={`Use ${v.label}?`} className="provider-consent">
          <h4>{`Use ${v.label}?`}</h4>
          <p>{v.consentText}</p>
          <div className="settings-row">
            <span className="grow" />
            <button type="button" className="btn-outline" disabled={busy} onClick={() => setAsking(false)}>{STR_PROVIDER_UI.consentCancel}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void allow()}>{STR_PROVIDER_UI.consentAllow}</button>
          </div>
        </section>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <InstallControls v={v} accountsNeeded={accountsNeeded} onView={onView} />
    </div>
  );
}
