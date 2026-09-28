import { useRef, useState } from "react";
import {
  DEFAULT_SAVINGS, STR, STR5, savingsLine,
  type CallReplies, type HostSettingsView, type LongContextMode, type PromptCacheTtl, type SavingsEstimates,
} from "@synapse/shared";
import { call } from "../../bridge";
import { acceptSettings, useUi } from "../../store";
import { Segmented } from "../Segmented";

type Key = "promptCacheTtl" | "callReplies" | "longContext";
type Values = { promptCacheTtl: PromptCacheTtl; callReplies: CallReplies; longContext: LongContextMode };

/**
 * saving-settings: Settings → Usage → Savings. Labels only; the one extra line under each is real data, the measured
 * weekly figure from usage.db (host/usage/savings-estimate.ts), shown only once the host has sent it. Account settings,
 * kept by the host (setHostSettings): while they load each control is a neutral placeholder, a choice shows at once,
 * and a save that fails goes back to the saved value and says so.
 */
export function SavingsCard({ estimates }: { estimates: SavingsEstimates | undefined }) {
  const s = useUi((x) => x.settings);
  const [pending, setPending] = useState<Partial<Values>>({});
  const [error, setError] = useState<string | null>(null);
  const busy = useRef<Set<Key>>(new Set());

  const saved = (k: Key, v: HostSettingsView | null): string | null => (v ? (v[k] ?? DEFAULT_SAVINGS[k]) : null);
  const value = <K extends Key>(k: K): Values[K] | null => (pending[k] ?? saved(k, s)) as Values[K] | null;

  const pick = <K extends Key>(k: K, v: Values[K]) => {
    if (!s || busy.current.has(k) || v === value(k)) return;
    busy.current.add(k);
    setError(null);
    setPending((p) => ({ ...p, [k]: v }));
    // The pending choice is dropped in the same tick as the outcome lands, so one render shows the
    // saved value with its result; clearing it in a later .finally() let a render show the error
    // beside the choice that failed.
    const settle = () => {
      busy.current.delete(k);
      setPending((p) => { const n = { ...p }; delete n[k]; return n; });
    };
    void call("setHostSettings", { [k]: v } as Partial<HostSettingsView>).then(
      (view) => { acceptSettings(view); settle(); },
      () => { settle(); setError(STR.settingNotSaved); },
    );
  };

  const placeholder = (label: string) => <span className="muted switch-pending" role="status" aria-label={label}>{STR.loading}</span>;
  const figure = (parts: [string, number][]) => (estimates ? <div className="settings-row"><span className="muted">{savingsLine(parts)}</span></div> : null);

  const ttl = value("promptCacheTtl");
  const replies = value("callReplies");
  const long = value("longContext");
  return (
    <section aria-label={STR5.savings}>
      <h3>{STR5.savings}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <span className="grow">{STR5.keepConversationsReady}</span>
          {ttl === null ? placeholder(STR5.keepConversationsReady) : (
            <Segmented<PromptCacheTtl> label={STR5.keepConversationsReady} value={ttl} onChange={(v) => pick("promptCacheTtl", v)}
              options={[{ value: "1h", label: STR5.cacheTtl1h }, { value: "5m", label: STR5.cacheTtl5m }]} />
          )}
        </div>
        {figure([[STR5.cacheTtl5m, estimates?.cacheTtl5m ?? 0]])}
        <div className="settings-row">
          <span className="grow">{STR5.callReplies}</span>
          {replies === null ? placeholder(STR5.callReplies) : (
            <select className="dropdown" aria-label={STR5.callReplies} value={replies} onChange={(e) => pick("callReplies", e.target.value as CallReplies)}>
              <option value="default">{STR5.callRepliesDefault}</option>
              <option value="fast">{STR5.callRepliesFast}</option>
              <option value="match">{STR5.callRepliesMatch}</option>
            </select>
          )}
        </div>
        {figure([[STR5.callRepliesFast, estimates?.callFast ?? 0], [STR5.callRepliesMatch, estimates?.callMatch ?? 0]])}
        <div className="settings-row">
          <span className="grow">{STR5.longContextModel}</span>
          {long === null ? placeholder(STR5.longContextModel) : (
            <Segmented<LongContextMode> label={STR5.longContextModel} value={long} onChange={(v) => pick("longContext", v)}
              options={[{ value: "on", label: STR5.longContextOn }, { value: "when-needed", label: STR5.longContextWhenNeeded }]} />
          )}
        </div>
        {figure([[STR5.longContextWhenNeeded, estimates?.longContextWhenNeeded ?? 0]])}
        {error && <div className="settings-row"><span className="error" role="alert">{error}</span></div>}
      </div>
    </section>
  );
}
