import { useEffect, useState } from "react";
import { STRB } from "@synapse/shared";
import { nativeCall, onNative } from "../native";

/**
 * mac-browser, "Sign in to sites" (bug-log 150): opens the Bots' browser profile as normal Chrome (no automation) so
 * Google and other sites accept the sign-in; "Done signing in" closes it and the Bots reuse the saved sign-ins.
 */
export function BrowserSigninButton({ className = "btn-outline" }: { className?: string }) {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void nativeCall<{ active: boolean }>("browser.signin", { action: "status" }).then((r) => { if (live) setActive(!!r?.active); }).catch(() => {});
    const off = onNative<{ active: boolean }>("browser.signin", (p) => setActive(!!p?.active));
    return () => { live = false; off(); };
  }, []);
  const go = () => {
    setError(null);
    setBusy(true);
    nativeCall<{ active: boolean }>("browser.signin", { action: active ? "done" : "start" })
      .then((r) => setActive(!!r?.active))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={go}>{active ? STRB.signinDone : STRB.signinButton}</button>
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}
