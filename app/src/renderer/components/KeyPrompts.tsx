import { useCallback, useEffect, useState } from "react";
import { API_KEY_RE, STR_AUTH, STR_COST } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { API_KEY_CHANGED } from "./settings/AccountSection";
import { Announce } from "./Announce";
import { MoneyInput, formatMoney, parseMoney } from "./MoneyInput";

const MAC_KEY_DISMISSED = "synapse.macKeyPromptDismissed";
const readFlag = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const setFlag = (k: string) => { try { localStorage.setItem(k, "1"); } catch { /* storage unavailable: asks again next launch */ } };
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * Security review, minors 4 and 5: two one-time prompts once an
 * API key is on the box.
 *  - "Monthly budget": pre-filled from the last 30 days rounded up (host getBudgetPrompt). Save sets the account's
 *    monthly dollar budget (at it, new work asks first; near it the ladder slows); Not now ends the prompt. Change or
 *    clear it any time in Settings → Usage.
 *  - "Save the API key on this Mac": the box has a key (saved before the Mac kept a copy) but this Mac doesn't, so a
 *    Bot's claude on the Mac can't run. The box never sends the key back, so it is typed once more here.
 * Labels only.
 */
export function KeyPrompts() {
  const [budget, setBudget] = useState<string | null>(null);
  const [macKey, setMacKey] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    // The API key is the only sign-in: both prompts apply once the box has one (the host's getBudgetPrompt says when).
    try {
      const auth = await callQuiet("getAuth", {});
      setMacKey(!!auth.apiKey && !readFlag(MAC_KEY_DISMISSED) && !(await window.synapse.auth.hasMacKey()));
    } catch { setMacKey(false); }
    try {
      const b = await callQuiet("getBudgetPrompt", {});
      setBudget(b?.show ? formatMoney(b.suggestedUsd) : null);
    } catch { setBudget(null); }
  }, []);
  useEffect(() => {
    void check();
    const on = () => void check();
    window.addEventListener(API_KEY_CHANGED, on);
    return () => window.removeEventListener(API_KEY_CHANGED, on);
  }, [check]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  const saveBudget = () => run(async () => {
    const n = parseMoney(budget ?? "");
    if (n === null || n <= 0) throw new Error(STR_COST.amountInvalid);
    // Review fix 2: the host merges the monthly limit into the account policy (its other limits and settings stay).
    await callQuiet("setMonthlyBudget", { usd: n });
    await callQuiet("dismissBudgetPrompt", {});
    setBudget(null);
  });
  const skipBudget = () => run(async () => { await callQuiet("dismissBudgetPrompt", {}); setBudget(null); });
  const saveMacKey = () => run(async () => {
    const k = key.trim();
    if (!API_KEY_RE.test(k)) throw new Error(STR_AUTH.badKeyFormat);
    const v = (await window.synapse.auth.saveKey(k)) as { macSaved?: boolean; macError?: string }; // the box's copy is replaced with the same key
    if (v.macSaved === false) throw new Error(`${STR_AUTH.macKeyNotSaved} ${v.macError ?? ""}`.trim());
    setKey("");
    setMacKey(!(await window.synapse.auth.hasMacKey()));
  });
  const skipMacKey = () => { setFlag(MAC_KEY_DISMISSED); setMacKey(false); };

  if (budget === null && !macKey) return null;
  return (
    <Announce>
      <div className="key-prompts" data-announcement="key-prompts">
        {macKey && (
          <form className="disk-banner key-prompt" onSubmit={(e) => { e.preventDefault(); void saveMacKey(); }}>
            <label htmlFor="mac-api-key">{STR_AUTH.macKeyTitle}</label>
            <input id="mac-api-key" type="password" autoComplete="off" spellCheck={false} className="text-input" placeholder={STR_AUTH.keyPlaceholder} value={key} onChange={(e) => setKey(e.target.value)} />
            <button type="button" className="btn-secondary" disabled={busy} onClick={skipMacKey}>{STR_COST.notNow}</button>
            <button type="submit" className="btn-primary" disabled={busy || !key.trim()}>{STR_AUTH.save}</button>
          </form>
        )}
        {budget !== null && (
          <form className="disk-banner key-prompt" onSubmit={(e) => { e.preventDefault(); void saveBudget(); }}>
            <label htmlFor="monthly-budget">{STR_COST.monthlyBudget}</label>
            <MoneyInput id="monthly-budget" className="narrow" value={budget} onChange={setBudget}
              invalid={error === STR_COST.amountInvalid} aria-describedby={error ? "key-prompt-error" : undefined} />
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void skipBudget()}>{STR_COST.notNow}</button>
            <button type="submit" className="btn-primary" disabled={busy}>{STR_COST.save}</button>
          </form>
        )}
        {error && <p id="key-prompt-error" role="alert" className="error">{error}</p>}
      </div>
    </Announce>
  );
}
