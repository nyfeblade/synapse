import { useEffect } from "react";
import { ACP_VENDORS, STR_ACP, acpVendorLink, type AcpVendorId } from "@synapse/shared";
import { useKeyedState } from "../async-resource";
import { callQuiet } from "../bridge";
import { nativeCall } from "../native";
import { copyWithConfirmation } from "../toast";

type View =
  | { s: "checking" }
  | { s: "in" }
  | { s: "out"; detail: string }
  | { s: "starting" }
  | { s: "link"; url: string; code: string | null }
  | { s: "terminal"; command: string }
  | { s: "error"; message: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^[A-Z_]+: /, "");

/**
 * Wave 3: Bot settings, for a Bot on a vendor's coding CLI. "Sign in with <vendor>" runs the vendor's own sign-in as
 * the Bot; the token stays in the Bot's home and never reaches the app. A link is opened only on the vendor's own hosts.
 */
export function AcpSignInRow({ botId, vendor }: { botId: string; vendor: AcpVendorId }) {
  const [v, setV] = useKeyedState<View>(`${botId}:${vendor}`, { s: "checking" });
  const check = () => {
    setV({ s: "checking" });
    callQuiet("checkAcpLogin", { id: botId, vendor })
      .then((r) => setV(r.signedIn ? { s: "in" } : { s: "out", detail: r.detail }))
      .catch((e: unknown) => setV({ s: "error", message: messageOf(e) }));
  };
  useEffect(() => { check(); }, [botId, vendor]);
  const start = () => {
    setV({ s: "starting" });
    callQuiet("startAcpLogin", { id: botId, vendor })
      .then((r) => {
        if (r.kind === "link") {
          const url = acpVendorLink(r.url, ACP_VENDORS[vendor].loginHosts);
          setV(url ? { s: "link", url, code: r.code } : { s: "error", message: STR_ACP.stopped(vendor) });
        } else if (r.kind === "terminal") setV({ s: "terminal", command: r.command });
        else setV({ s: "error", message: r.detail });
      })
      .catch((e: unknown) => setV({ s: "error", message: messageOf(e) }));
  };
  const open = (url: string, code: string | null) => {
    if (code) void copyWithConfirmation(code);
    void nativeCall("openExternal", { url }).catch(() => {});
  };
  return (
    <div className="settings-card" data-setting="coding-cli-sign-in">
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{ACP_VENDORS[vendor].label}</span>
        <span className="muted">{STR_ACP.planNote(vendor)}</span>
      </div>
      <div className="settings-row">
        <span className="muted" role="status" style={{ flexGrow: 1 }}>
          {v.s === "checking" ? STR_ACP.checking : v.s === "in" ? STR_ACP.signedIn : v.s === "out" ? (v.detail || STR_ACP.notSignedIn) : ""}
        </span>
        {(v.s === "out" || v.s === "error") && <button type="button" className="btn-outline" onClick={start}>{STR_ACP.signIn(vendor)}</button>}
        {v.s === "starting" && <button type="button" className="btn-outline" disabled>{STR_ACP.signIn(vendor)}</button>}
        {(v.s === "link" || v.s === "terminal") && <button type="button" className="btn-outline" onClick={check}>{STR_ACP.check}</button>}
      </div>
      {v.s === "link" && (
        <div className="settings-row gap">
          {v.code && <span className="gh-code">{v.code}</span>}
          <button type="button" className="btn-primary" onClick={() => open(v.url, v.code)}>{STR_ACP.openLink}</button>
        </div>
      )}
      {v.s === "terminal" && <div className="settings-row"><span className="muted">{STR_ACP.terminalStep(v.command)}</span></div>}
      {v.s === "error" && <div className="settings-row"><span className="error" role="alert">{v.message}</span></div>}
    </div>
  );
}
