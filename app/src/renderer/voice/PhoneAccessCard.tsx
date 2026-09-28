import { useEffect, useState } from "react";
import { STR_PHONE } from "@synapse/shared";
import { nativeCall, onNative } from "../native";

/** What main's phone.status answers (app/src/main/phone/wire.ts). */
export interface PhoneStatusView {
  enabled: boolean;
  tailscale: { installed: boolean; running: boolean; state: string };
  url: string | null;
  qr: { size: number; path: string } | null;
  devices: { id: string; name: string; createdAt: number; lastSeenAt: number }[];
  pairing: boolean;
  enableUrl: string | null;
  error: string | null;
  inCall: boolean;
}

const PROBLEMS: Record<string, string> = {
  missing: STR_PHONE.tailscaleMissing,
  stopped: STR_PHONE.tailscaleStopped,
  "no-name": STR_PHONE.noMagicDns,
  unreachable: STR_PHONE.unreachable,
  "no-unix": STR_PHONE.noUnix,
  old: STR_PHONE.tooOld,
  "port-in-use": STR_PHONE.portInUse,
  funnel: STR_PHONE.funnelOn,
  "serve-status": STR_PHONE.serveStatus,
  "not-mapped": STR_PHONE.notMapped,
  "not-ours": STR_PHONE.notOurs,
  "unsafe-dir": STR_PHONE.unsafeDir,
  "socket-path": STR_PHONE.socket,
  socket: STR_PHONE.socket,
  "off-failed": STR_PHONE.offFailed,
  "shared-443": STR_PHONE.shared443,
};

export function problem(s: Pick<PhoneStatusView, "error">): string | null {
  if (!s.error) return null;
  return PROBLEMS[s.error] ?? STR_PHONE.failed(s.error);
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Bug 198: Settings → Voice → Phone access. The switch runs `tailscale serve` (on) / `serve off`;
 * while on: the tailnet address with Copy and a QR code, a one-time pairing code, and the paired
 * phones, each revocable.
 */
export function PhoneAccessCard() {
  const [s, setS] = useState<PhoneStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => void nativeCall<PhoneStatusView>("phone.status").then((v) => { if (v && typeof v.enabled === "boolean") setS(v); }, () => {});
  useEffect(() => {
    load();
    return onNative<{ type?: string }>("phone-access", () => load());
  }, []);
  // A code is shown until it is used (the phone paired), cancelled or out of time.
  useEffect(() => {
    if (!code) return;
    if (s && !s.pairing) { setCode(null); return; }
    const t = setTimeout(() => { setCode(null); load(); }, Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [code, s?.pairing]);
  if (!s) return null;
  const toggle = () => {
    setBusy(true);
    void nativeCall<PhoneStatusView>(s.enabled ? "phone.disable" : "phone.enable").then((v) => { if (v) setS(v); }, () => load()).finally(() => setBusy(false));
  };
  const retry = () => {
    setBusy(true);
    // A mapping left sharing :443 with the user's own handlers: Retry is the clean-up (off), not an on.
    void nativeCall<PhoneStatusView>(s.error === "shared-443" ? "phone.disable" : "phone.enable").then((v) => { if (v) setS(v); }, () => load()).finally(() => setBusy(false));
  };
  const copy = () => {
    if (!s.url) return;
    void navigator.clipboard?.writeText(s.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  const pair = () => void nativeCall<{ code: string; expiresAt: number }>("phone.pair.start").then((c) => { if (c?.code) setCode(c); load(); }, () => {});
  const cancel = () => { setCode(null); void nativeCall("phone.pair.cancel").then(load, load); };
  const revoke = (id: string) => void nativeCall("phone.devices.revoke", { id }).then(load, load);
  const issue = problem(s);
  return (
    <div className="settings-card phone-access-card">
      <div className="settings-row">
        <span id="phone-access-label" style={{ flexGrow: 1 }}>{STR_PHONE.title}</span>
        {busy && <span className="muted">{STR_PHONE.working}</span>}
        <button type="button" role="switch" aria-checked={s.enabled} aria-labelledby="phone-access-label" disabled={busy}
          className={s.enabled ? "switch on" : "switch"} onClick={toggle} />
      </div>
      {issue && (
        <div className="settings-row">
          <span className="error" role="alert" style={{ flexGrow: 1 }}>{issue}</span>
          {s.error === "missing" && <button type="button" className="btn-outline small" onClick={() => void nativeCall("openExternal", { url: "https://tailscale.com/download/mac" }).catch(() => {})}>{STR_PHONE.getTailscale}</button>}
          {!s.enabled && s.error !== "off-failed" && <button type="button" className="btn-outline small" disabled={busy} onClick={retry}>{STR_PHONE.retry}</button>}
        </div>
      )}
      {s.enableUrl && (
        <div className="settings-row">
          <span style={{ flexGrow: 1 }}>{STR_PHONE.enableServe}</span>
          <button type="button" className="btn-outline small" onClick={() => void nativeCall("openExternal", { url: s.enableUrl }).catch(() => {})}>{STR_PHONE.openTailscale}</button>
        </div>
      )}
      {s.enabled && s.url && (
        <>
          <div className="settings-row phone-address">
            <span className="muted">{STR_PHONE.address}</span>
            <code className="phone-url grow" data-testid="phone-url">{s.url}</code>
            <button type="button" className="btn-outline small" onClick={copy}>{copied ? STR_PHONE.copied : STR_PHONE.copy}</button>
          </div>
          {s.qr && (
            <div className="settings-row phone-qr-row">
              <svg className="phone-qr" role="img" aria-label={STR_PHONE.qrLabel} viewBox={`0 0 ${s.qr.size} ${s.qr.size}`} width={168} height={168} shapeRendering="crispEdges">
                <rect width={s.qr.size} height={s.qr.size} fill="#FFFFFF" />
                <path d={s.qr.path} fill="#000000" />
              </svg>
            </div>
          )}
          <div className="settings-row">
            {code ? (
              <>
                <span className="muted">{STR_PHONE.pairingCode}</span>
                <b className="phone-code grow" data-testid="phone-code" aria-live="polite">{code.code.slice(0, 3)} {code.code.slice(3)}</b>
                <button type="button" className="btn-outline small" onClick={cancel}>{STR_PHONE.cancel}</button>
              </>
            ) : (
              <button type="button" className="btn-outline small" onClick={pair}>{STR_PHONE.pairPhone}</button>
            )}
          </div>
          {s.devices.length > 0 && (
            <div className="phone-devices" role="list" aria-label={STR_PHONE.devices}>
              {s.devices.map((d) => (
                <div className="settings-row" role="listitem" key={d.id}>
                  <span style={{ flexGrow: 1 }}>{d.name}</span>
                  <span className="muted">{STR_PHONE.lastSeen(ago(d.lastSeenAt))}</span>
                  <button type="button" className="btn-outline small" aria-label={STR_PHONE.revokeDevice(d.name)} onClick={() => revoke(d.id)}>{STR_PHONE.revoke}</button>
                </div>
              ))}
            </div>
          )}
          {s.inCall && <div className="settings-row"><span className="muted" role="status">{STR_PHONE.inCall}</span></div>}
        </>
      )}
    </div>
  );
}
