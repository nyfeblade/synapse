import { LIMITSC, STR, STRC } from "@synapse/shared";
import { useAsync, useKeyedState } from "../async-resource";
import { relativeTime } from "../relative-time";
import { Async } from "./Async";

const EMPTY_FORM = { name: "", description: "", value: "" };

/**
 * SEC-05 / ORIG-12 §12.5: names and descriptions only; the value is write-only and never shown again.
 *
 * Hand-testing round: this fetch had no error handling and was called as `void load()`, so a
 * rejection was an unhandled promise rejection and `rows` stayed null — which renders as neither the
 * secrets, nor the deliberate "No secrets" copy, nor an error. A failed fetch must never be shown as
 * an empty list, and "still loading" must not look like "there are none". `useAsync` owns all three.
 *
 * Bug #19, and the serious half of it: every piece of state here is ABOUT ONE BOT, and none of it
 * used to be reset when `botId` changed — so switching Bots left the previous Bot's secret NAMES on
 * screen, with live Replace/Remove buttons, until the new list landed (forever, if it failed). Those
 * buttons close over the CURRENT `botId`, not the id the row was fetched with, so a Replace clicked
 * in that window called `secrets.save(newBotId, oldBotsSecretName, …)` and `vault.upsert` creates on
 * an unknown name — silently writing a secret onto the Bot the user had just switched TO. Keying the
 * list (`useAsync`) and the form beside it (`useKeyedState`) to `botId` makes that window not exist:
 * a row on screen was fetched for the `botId` this render is using, so its buttons cannot mis-aim.
 */
export function SecretsSection({ botId }: { botId: string }) {
  const secrets = useAsync(() => window.synapse.secrets.list(botId), [botId]);
  const [adding, setAdding] = useKeyedState(botId, false);
  const [replacing, setReplacing] = useKeyedState<string | null>(botId, null);
  const [renaming, setRenaming] = useKeyedState<string | null>(botId, null);
  const [form, setForm] = useKeyedState(botId, EMPTY_FORM);
  const [error, setError] = useKeyedState<string | null>(botId, null);
  const reset = () => { setForm(EMPTY_FORM); setAdding(false); setReplacing(null); setRenaming(null); };
  const rename = async (from: string) => {
    try {
      setError(null);
      await window.synapse.secrets.rename(botId, from, form.name);
      reset();
      secrets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async (name: string, description: string) => {
    try {
      setError(null);
      await window.synapse.secrets.save(botId, name, description, form.value);
      reset();
      secrets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const valueField = (
    <>
      <label className="field"><span>{STRC.secretValue}</span><input type="password" autoComplete="off" className="field-input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></label>
      {form.value.length >= LIMITSC.secretMinChars && form.value.length < LIMITSC.secretWarnBelow && <div className="muted small">{STRC.shortValueWarning}</div>}
    </>
  );
  return (
    <section aria-label={STRC.secrets} className="secrets-section">
      <h3 className="panel-subtitle">{STRC.secrets}</h3>
      <Async resource={secrets} label={STRC.secrets}>
        {(rows) => (
          <>
            {rows.length === 0 && !adding && <div className="muted">{STRC.noSecrets}</div>}
            {(() => {
              // Bug 57: never a silent state. The values stay on the box; the user decides to keep or re-enter them.
              const pending = rows.filter((r) => r.boxOnly && !r.kept).map((r) => r.name);
              return pending.length > 0 && (
                <div role="status" className="secret-notice">
                  <span>{STRC.boxOnlyNotice(pending.length)}</span>
                  <button type="button" className="btn-outline small" onClick={() => { setError(null); void window.synapse.secrets.keepOnBox(botId, pending).then(() => secrets.reload()).catch((e) => setError((e as Error).message)); }}>{STRC.keepOnBox}</button>
                </div>
              );
            })()}
            {rows.map((r) => (
              <div key={r.name} className="secret-row">
                <div className="secret-meta">
                  <span className="secret-name">{r.name}</span>
                  {r.description && <span className="muted">{r.description}</span>}
                  <span className="muted small">{STRC.updatedAgo(relativeTime(r.updatedAt, Date.now()))}</span>
                  {r.unusable && <span className="error small">{STRC.secretUnusable(r.unusable)}</span>}
                  {r.boxOnly && <span className="muted small">{STRC.boxOnlyRow}</span>}
                </div>
                {r.boxOnly && replacing !== r.name ? (
                  <span className="secret-actions">
                    <button type="button" className="btn-outline small" onClick={() => { reset(); setReplacing(r.name); }}>{STRC.reenter}</button>
                    <button type="button" className="btn-outline small" onClick={() => { setError(null); void window.synapse.secrets.remove(botId, r.name).then(() => secrets.reload()).catch((e) => setError((e as Error).message)); }}>{STRC.removeFromBox}</button>
                  </span>
                ) : renaming === r.name ? (
                  <div className="secret-edit">
                    <label className="field"><span>{STRC.newSecretName}</span><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} /></label>
                    <button type="button" className="btn-primary" disabled={!form.name} onClick={() => void rename(r.name)}>{STRC.renameSecret}</button>
                    <button type="button" className="btn-outline small" onClick={reset}>{STR.cancel}</button>
                  </div>
                ) : r.unusable ? (
                  // Bug 56: Replace would keep a name the Bot's env refuses, so this row offers the two actions that help.
                  <span className="secret-actions">
                    <button type="button" className="btn-outline small" aria-label={STRC.renameSecretAria(r.name)} onClick={() => { reset(); setRenaming(r.name); setForm({ ...EMPTY_FORM, name: r.name.toUpperCase() }); }}>{STRC.rename}</button>
                    <button type="button" className="btn-outline small" onClick={() => { setError(null); void window.synapse.secrets.remove(botId, r.name).then(() => secrets.reload()).catch((e) => setError((e as Error).message)); }}>{STRC.remove}</button>
                  </span>
                ) : replacing === r.name ? (
                  <div className="secret-edit">
                    {valueField}
                    <button type="button" className="btn-primary" disabled={form.value.length < LIMITSC.secretMinChars} onClick={() => void save(r.name, r.description)}>{STRC.replaceValue}</button>
                    <button type="button" className="btn-outline small" onClick={reset}>{STR.cancel}</button>
                  </div>
                ) : (
                  <span className="secret-actions">
                    <button type="button" className="btn-outline small" onClick={() => { reset(); setReplacing(r.name); }}>{STRC.replace}</button>
                    <button type="button" className="btn-outline small" onClick={() => { setError(null); void window.synapse.secrets.remove(botId, r.name).then(() => secrets.reload()).catch((e) => setError((e as Error).message)); }}>{STRC.remove}</button>
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </Async>
      {adding ? (
        <div className="secret-edit">
          <label className="field"><span>{STRC.secretName}</span><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>{STRC.secretDescription}</span><input className="field-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          {valueField}
          <button type="button" className="btn-primary" disabled={!form.name || form.value.length < LIMITSC.secretMinChars} onClick={() => void save(form.name, form.description)}>{STRC.saveSecret}</button>
          <button type="button" className="btn-outline small" onClick={reset}>{STR.cancel}</button>
        </div>
      ) : (
        <button type="button" className="btn-outline small" onClick={() => { reset(); setAdding(true); }}>{STRC.addSecret}</button>
      )}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}
