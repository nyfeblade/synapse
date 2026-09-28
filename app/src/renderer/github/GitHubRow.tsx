import { useEffect } from "react";
import { GITHUB_DEVICE_URL, GITHUB_SCOPES, STRGH } from "@synapse/shared";
import { useKeyedState } from "../async-resource";
import { callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { nativeCall } from "../native";
import { copyWithConfirmation } from "../toast";

type View =
  | { s: "loading" }
  | { s: "out" }
  | { s: "starting" }
  | { s: "waiting"; code: string; url: string }
  | { s: "in"; login: string | null }
  | { s: "error"; message: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Bug-log 195: Bot settings → GitHub. The Bot's own `gh` signs in with GitHub's device flow (host/github/signin.ts):
 * the host returns a one-time code, the user enters it on github.com/login/device in their own browser, and the
 * host's "github" events say when it is done. The token never reaches the app.
 */
export function GitHubRow({ botId }: { botId: string }) {
  const [v, setV] = useKeyedState<View>(botId, { s: "loading" });

  useEffect(() => {
    let live = true;
    // Quiet: the row itself shows a failure in place.
    callQuiet("getGitHubStatus", { id: botId })
      .then((r) => { if (live) setV(r.pending ? { s: "waiting", ...r.pending } : r.signedIn ? { s: "in", login: r.login } : { s: "out" }); })
      .catch(() => { if (live) setV({ s: "out" }); });
    const off = subscribeChannel("github", (e) => {
      if (e.botId !== botId) return;
      if (e.state === "waiting") setV({ s: "waiting", code: e.code, url: e.url });
      else if (e.state === "signed-in") setV({ s: "in", login: e.login });
      else if (e.state === "signed-out") setV({ s: "out" });
      else setV({ s: "error", message: e.state === "expired" ? STRGH.expired : STRGH.failed(e.reason) });
    });
    return () => { live = false; off(); };
  }, [botId, setV]);

  const start = () => {
    setV({ s: "starting" });
    // Quiet: a refusal is shown in the row, with Try again.
    callQuiet("startGitHubSignIn", { id: botId })
      .then((r) => setV((cur) => (cur.s === "starting" ? { s: "waiting", ...r } : cur)))
      .catch((e: unknown) => setV({ s: "error", message: messageOf(e) }));
  };
  const signOut = () => {
    // Quiet: shown in the row.
    callQuiet("signOutGitHub", { id: botId })
      .then((r) => setV(r.signedIn ? { s: "in", login: r.login } : { s: "out" }))
      .catch((e: unknown) => setV({ s: "error", message: messageOf(e) }));
  };
  // Always GitHub's own device page: never a URL that arrived in a payload.
  const open = (code: string) => {
    void copyWithConfirmation(code);
    void nativeCall("openExternal", { url: GITHUB_DEVICE_URL }).catch(() => {});
  };

  return (
    <div className="settings-card" data-setting="github">
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{STRGH.row}</span>
        {v.s === "out" && <button type="button" className="btn-outline" onClick={start}>{STRGH.signIn}</button>}
        {v.s === "starting" && <button type="button" className="btn-outline" disabled>{STRGH.starting}</button>}
        {v.s === "waiting" && <span className="muted" role="status">{STRGH.waiting}</span>}
        {v.s === "in" && (
          <>
            <span className="muted">{STRGH.signedInAs(v.login)}</span>
            <button type="button" className="btn-outline" onClick={signOut}>{STRGH.signOut}</button>
          </>
        )}
        {v.s === "error" && <button type="button" className="btn-outline" onClick={start}>{STRGH.tryAgain}</button>}
      </div>
      {v.s === "waiting" && (
        <div className="settings-row gap">
          <span className="gh-code">{v.code}</span>
          <button type="button" className="btn-outline" onClick={() => void copyWithConfirmation(v.code)}>{STRGH.copy}</button>
          <button type="button" className="btn-primary" onClick={() => open(v.code)}>{STRGH.openGitHub}</button>
        </div>
      )}
      {v.s === "waiting" && <div className="settings-row"><span className="muted">{STRGH.access(GITHUB_SCOPES)}</span></div>}
      {v.s === "error" && <div className="settings-row"><span className="error" role="alert">{v.message}</span></div>}
    </div>
  );
}
