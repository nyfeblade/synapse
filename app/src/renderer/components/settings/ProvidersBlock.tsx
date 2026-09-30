import { useEffect, useState } from "react";
import { PROVIDER_KEY_RE, STR, STR_KEY_STEP, STR_PROVIDER_UI, isKeyedProvider, type ProviderTestResult, type ProviderView, type ProvidersView } from "@synapse/shared";
import { callQuiet } from "../../bridge";
import { KeyList } from "./KeyList";
import { useKeysView } from "./keys-store";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^[A-Z_]+: /, "") || STR.hostNoAnswer;

/**
 * Settings → Account, the model providers (spec §4, §10): one row each, with a key (sealed to the box in main,
 * window.synapse.providers) or "On this Mac", and the one-time consent sheet before anything is set up. The host only
 * answers with a masked key.
 */
export function ProvidersBlock() {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void callQuiet("getProviders", {}).then((v) => { if (Array.isArray(v?.providers)) setView(v); }).catch((e) => setError(reason(e))); }, []);
  if (!view) return error ? <p role="alert" className="error">{error}</p> : null;
  const refresh = () => void callQuiet("getProviders", {}).then((v) => { if (Array.isArray(v?.providers)) setView(v); }).catch((e) => setError(reason(e)));
  return (
    <div className="settings-card providers-block">
      <h3>{STR_PROVIDER_UI.sectionTitle}</h3>
      {view.providers.map((p) => <ProviderRow key={p.id} p={p} onView={setView} onKeys={refresh} />)}
    </div>
  );
}

/**
 * One provider: consent, then its key (or, on this Mac, a Test). Also the first-run key step's panel (`firstRun`,
 * onboarding/KeyStep.tsx): the consent shows at once, Save key tests the key before it saves it, and `onReady` fires
 * once the key (or the app on this Mac) answered.
 */
export function ProviderRow({ p, onView, firstRun = false, onReady, onKeys }: { p: ProviderView; onView(v: ProvidersView): void; firstRun?: boolean; onReady?(): Promise<void> | void; onKeys?(): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | "testing" | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  const allow = () => run(async () => {
    onView(await callQuiet("consentProvider", { provider: p.id, textVersion: p.consentVersion }));
    setAsking(false);
  });
  const save = () => run(async () => {
    const k = key.trim();
    if (!PROVIDER_KEY_RE.test(k)) throw new Error(STR_PROVIDER_UI.badFormat);
    if (firstRun) {
      // First run: only a key that works is saved (the step can't finish on one that doesn't).
      setTest("testing");
      const t = (await window.synapse.providers.testKey(p.id, k)) as ProviderTestResult;
      if (!t?.ok) { setTest(t ?? null); return; }
    }
    onView((await window.synapse.providers.saveKey(p.id, k)) as ProvidersView);
    setKey("");
    setTest(null);
    if (firstRun) await onReady?.();
  });
  const testNow = () => run(async () => {
    setTest("testing");
    let t: ProviderTestResult;
    try { t = (await window.synapse.providers.testKey(p.id, key.trim())) as ProviderTestResult; setTest(t); } catch (e) { setTest(null); throw e; }
    // First run, on this Mac: the app answered, so the step is done.
    if (firstRun && p.local && t?.ok) await onReady?.();
  });
  const remove = () => run(async () => { onView(await callQuiet("clearProviderKey", { provider: p.id })); setTest(null); });

  const consentOpen = asking || (firstRun && !p.consented);
  // 0.1.7: several keys per provider in Settings; a host before it (no key list) keeps the one-key form.
  const keys = useKeysView();
  const list = !firstRun && !!keys.view && isKeyedProvider(p.id);
  return (
    <div className="provider-row" aria-label={p.label}>
      {!firstRun && (
        <div className="settings-row">
          <strong className="grow">{p.label}</strong>
          {/* 0.1.7: a provider that's allowed lists its keys below (KeyList); the row keeps only its name. */}
          {(p.local || !p.consented || !list) && <span className="muted">{p.local ? STR_PROVIDER_UI.local : p.key ? p.key.masked : STR_PROVIDER_UI.noKey}</span>}
          {!p.consented && !asking && <button type="button" className="btn-outline" disabled={busy} onClick={() => setAsking(true)}>{STR_PROVIDER_UI.allow}</button>}
        </div>
      )}
      {consentOpen && (
        <section aria-label={STR_PROVIDER_UI.consentTitle(p.id)} className="provider-consent">
          <h4>{STR_PROVIDER_UI.consentTitle(p.id)}</h4>
          <p>{p.consentText}</p>
          <div className="settings-row">
            <span className="grow" />
            {!firstRun && <button type="button" className="btn-outline" disabled={busy} onClick={() => setAsking(false)}>{STR_PROVIDER_UI.consentCancel}</button>}
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void allow()}>{STR_PROVIDER_UI.consentAllow}</button>
          </div>
        </section>
      )}
      {p.consented && !p.local && list && isKeyedProvider(p.id) && <KeyList provider={p.id} onChanged={() => onKeys?.()} />}
      {p.consented && !p.local && !list && (
        <form className="settings-row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input aria-label={STR_PROVIDER_UI.keyLabel(p.id)} type="password" autoComplete="off" spellCheck={false} className="text-input grow" placeholder={STR_PROVIDER_UI.keyPlaceholder}
            value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="btn-primary" disabled={busy || !key.trim()}>{firstRun ? STR_KEY_STEP.saveKey : p.key ? STR_PROVIDER_UI.replace : STR_PROVIDER_UI.save}</button>
          <button type="button" className="btn-outline" disabled={busy || (!key.trim() && !p.key)} onClick={() => void testNow()}>{test === "testing" ? STR_PROVIDER_UI.testing : STR_PROVIDER_UI.test}</button>
          {p.key && !firstRun && <button type="button" className="btn-outline" disabled={busy} onClick={() => void remove()}>{STR_PROVIDER_UI.remove}</button>}
        </form>
      )}
      {p.consented && p.local && (
        <div className="settings-row">
          <span className="grow muted">{firstRun ? p.label : STR_PROVIDER_UI.allowed}</span>
          <button type="button" className="btn-outline" disabled={busy} onClick={() => void testNow()}>{test === "testing" ? STR_PROVIDER_UI.testing : STR_PROVIDER_UI.testLocal}</button>
        </div>
      )}
      {test && test !== "testing" && <p role="status" className={test.ok ? "account-test ok" : "account-test"}><strong>{test.title}</strong>{test.detail ? <span className="muted"> {test.detail}</span> : null}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
