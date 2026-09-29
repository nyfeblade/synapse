import { useEffect, useState } from "react";
import { API_KEY_RE, STR, STR_AUTH, modelLabel, type AuthTestResult, type AuthView, type KeyCheckView } from "@synapse/shared";
import { callQuiet } from "../../bridge";
import { subscribeChannel } from "../../feature-store";
import { nativeCall } from "../../native";
import { useModelAccess } from "../../model-access";
import { SectionBlocks } from "./sections";
import { noteIfSlow, SIGN_IN_TIMEOUT_MS } from "../../within-time";

/** Fired on this window when the key changes (the one-time prompts re-check, KeyPrompts.tsx). */
export const API_KEY_CHANGED = "synapse:api-key-changed";
const changed = () => window.dispatchEvent(new Event(API_KEY_CHANGED));

/** An IPC rejection arrives as "Error invoking remote method 'auth:save-key': Error: <reason>". */
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || STR.hostNoAnswer;

/**
 * The Anthropic API key: the only way Bots reach Claude (synapse-public). The key is typed here and handed to the main
 * process (window.synapse.auth), which seals it to the box; the host only ever answers with `sk-ant-…last4`. A new key
 * applies from each Bot's next turn. Used by Settings → Account and the first-run Sign in step.
 */
export function AccountPanel({ onReady, timeoutMs = SIGN_IN_TIMEOUT_MS }: {
  /** A key is saved (a first-run step moves on). */
  onReady?(): void;
  /** Tests only: how long a step may take before it fails with a plain line. */
  timeoutMs?: number;
}) {
  const [view, setView] = useState<AuthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [test, setTest] = useState<AuthTestResult | "testing" | null>(null);
  const [check, setCheck] = useState<KeyCheckView | null>(null);
  // callQuiet: the panel shows this failure itself, in place of the key field.
  useEffect(() => {
    void noteIfSlow(callQuiet("getAuth", {}), timeoutMs, () => setError(STR.hostTimeout))
      .then((v) => { setView(v); setError(null); }).catch((e) => setError(reason(e)));
  }, [timeoutMs]);
  // Bug 281: the API-key check's last answer, and each new one (after a key is saved, or from Check).
  useEffect(() => {
    const take = (v: unknown) => { if (isKeyCheck(v)) setCheck(v); };
    void callQuiet("checkApiKey", {}).then(take).catch(() => {});
    return subscribeChannel("key-check", take);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    // Slow: say so, but keep the buttons off until main's call settles (a late Save must not overtake a Remove).
    let slow = false;
    try {
      await noteIfSlow(fn(), timeoutMs, () => { slow = true; setError(STR.hostTimeout); });
      if (slow) setError((e) => (e === STR.hostTimeout ? null : e));
    } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const k = key.trim();
    if (!API_KEY_RE.test(k)) throw new Error(STR_AUTH.badKeyFormat);
    const saved = (await window.synapse.auth.saveKey(k)) as (AuthView & { macSaved?: boolean; macError?: string }) | null;
    // An answer without a saved key is never a silent no-op (the typed key stays, for Save again).
    if (!saved?.apiKey) throw new Error(STR_AUTH.keyNotSaved);
    setKey("");
    setTest(null);
    setView(saved);
    changed();
    // Review fix 4: the box has the key, but this Mac couldn't keep its copy (the Bots' claude here can't run yet).
    if (saved.macSaved === false && saved.macError) setError(`${STR_AUTH.macKeyNotSaved} ${saved.macError}`);
    onReady?.();
  });

  const remove = () => run(async () => {
    setTest(null);
    // Through main, so this Mac's copy of the key goes too (auth-key.ts).
    setView((await window.synapse.auth.removeKey()) as AuthView);
    changed();
  });

  const testNow = () => run(async () => {
    setTest("testing");
    const typed = key.trim();
    try {
      setTest(typed ? ((await window.synapse.auth.testKey(typed)) as AuthTestResult) : await callQuiet("testAuthConnection", {}));
    } catch (e) { setTest(null); throw e; }
  });

  const checkNow = async () => {
    setChecking(true);
    setError(null);
    try {
      let slow = false;
      const v = await noteIfSlow(callQuiet("checkApiKey", { refresh: true }), timeoutMs, () => { slow = true; setError(STR.hostTimeout); });
      if (slow) setError((e) => (e === STR.hostTimeout ? null : e));
      if (isKeyCheck(v)) setCheck(v);
      void useModelAccess.getState().load(); // the check re-probed the models
    } catch (e) { setError(reason(e)); } finally { setChecking(false); }
  };
  const typed = key.trim() !== "";

  if (!view) return <div className="settings-card"><p className="muted" role={error ? "alert" : undefined}>{error ?? "Loading…"}</p></div>;
  return (
    <div className="settings-card account-panel">
      <div className="account-key">
        <p className="muted">{view.apiKey ? STR_AUTH.savedKey(view.apiKey.masked) : STR_AUTH.noKey}</p>
        <form className="settings-row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input aria-label={STR_AUTH.keyLabel} type="password" autoComplete="off" spellCheck={false} className="text-input grow" placeholder={STR_AUTH.keyPlaceholder}
            value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="btn-primary" disabled={busy || !key.trim()}>{view.apiKey ? STR_AUTH.replaceKey : STR_AUTH.saveKey}</button>
        </form>
        <div className="settings-row">
          {/* Bug 281: a saved key is checked on the host (Check); a typed one is tested before it's saved. */}
          {view.apiKey && !typed
            ? <button type="button" className="btn-outline" disabled={busy || checking || check?.checking === true} onClick={() => void checkNow()}>{checking || check?.checking ? STR_AUTH.checking : STR_AUTH.check}</button>
            : <button type="button" className="btn-outline" disabled={busy || !typed} onClick={() => void testNow()}>{test === "testing" ? STR_AUTH.testing : STR_AUTH.testConnection}</button>}
          {view.apiKey && <button type="button" className="btn-outline" disabled={busy} onClick={() => void remove()}>{STR_AUTH.removeKey}</button>}
          <span className="grow" />
          <a href="#" onClick={(e) => { e.preventDefault(); void nativeCall("openExternal", { url: STR_AUTH.consoleKeysUrl }); }}>{STR_AUTH.createKey}</a>
        </div>
        {view.apiKey && !typed && check && check.checkedAt !== null && <KeyCheckResult v={check} />}
        {test && test !== "testing" && (
          <p role="status" className={test.ok ? "account-test ok" : "account-test"}><strong>{test.title}</strong>{test.detail ? <span className="muted"> {test.detail}</span> : null}</p>
        )}
      </div>
      {view.apiKey ? <p className="muted">{STR_AUTH.appliesNext}</p> : null}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

const isKeyCheck = (v: unknown): v is KeyCheckView => !!v && typeof v === "object" && "works" in v && Array.isArray((v as KeyCheckView).models);

/** Bug 281: what the key check found. Titles and plain labels only. */
function KeyCheckResult({ v }: { v: KeyCheckView }) {
  const yesNo = (b: boolean | null, yes: string, no: string) => (b === null ? STR_AUTH.unknown : b ? yes : no);
  return (
    <div role="status" className="account-check">
      <p className={v.works ? "account-test ok" : "account-test"}>
        <strong>{v.works ? STR_AUTH.keyWorks : v.problem?.title ?? STR_AUTH.unknown}</strong>
        {!v.works && v.problem?.detail ? <span className="muted"> {v.problem.detail}</span> : null}
      </p>
      <dl className="account-check-rows">
        <div><dt>{STR_AUTH.rowModels}</dt><dd>{v.models.length ? v.models.map(modelLabel).join(", ") : STR_AUTH.none}</dd></div>
        <div><dt>{STR_AUTH.rowLongContext}</dt><dd>{yesNo(v.longContext, STR_AUTH.available, STR_AUTH.notAvailable)}</dd></div>
        <div><dt>{STR_AUTH.rowWebSearch}</dt><dd>{yesNo(v.webSearch, STR_AUTH.on, STR_AUTH.off)}</dd></div>
      </dl>
    </div>
  );
}

export function AccountSection() {
  return (
    <section aria-label={STR_AUTH.sectionTitle}>
      <h2>{STR_AUTH.sectionTitle}</h2>
      <AccountPanel />
      <SectionBlocks section="account" />
    </section>
  );
}
