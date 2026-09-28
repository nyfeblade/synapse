import { DEFAULT_HISTORY_KEEP, HISTORY_KEEPS, STR, STR5, historyKeepLabel, isHistoryKeep, type AgentContextView } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { call, callQuiet } from "../bridge";
import { acceptAgent, useUi } from "../store";
import { Async } from "./Async";

// Task 34 fuzz: a failed call surfaces in the sidebar's action error instead of an unhandled rejection.
const showError = (e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });
const k = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`);

export function AdvancedSection({ botId }: { botId: string }) {
  const on = useUi((s) => s.settings?.advancedEnabled ?? false);
  const updatedAt = useUi((s) => s.bots[botId]?.updatedAt);
  const keep = useUi((s) => s.bots[botId]?.settings?.advanced?.historyKeep) ?? DEFAULT_HISTORY_KEEP;
  // Bug #19: this was `useState(null)` + an effect that only wrote when an ANSWER arrived, so after a
  // switch the previous Bot's meter stayed on screen until the new one landed — and forever if the
  // new call failed, because a rejection left the old value untouched. `useAsync` keys the value to
  // [botId, updatedAt] and drops it in the render the key changes, so there is nothing to forget.
  // callQuiet: a failed read is presented here, in place, with Retry — not also in the sidebar banner.
  const ctx = useAsync<AgentContextView>(() => callQuiet("getAgentContext", { id: botId }), [botId, updatedAt], { enabled: on });
  if (!on) return null;
  return (
    <section className="settings-card" aria-label={STR.advanced}>
      <div className="settings-row"><span className="grow">{STR.advanced}</span></div>
      <Async resource={ctx} label={STR.advanced}>
        {(v) => {
          // The FUZZ host answers this command with null (task-34-report.md); a Bot with no session
          // yet has no meter to draw, which is "ready, nothing to show", not a failure.
          if (!v) return null;
          const pct = Math.round(v.ratio * 100);
          return (
            <div className="settings-row column">
              <span className="muted">{STR.contextMeter(pct, k(v.ctxTokens), k(v.window))}</span>
              <span className="meter" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></span>
            </div>
          );
        }}
      </Async>
      <label className="settings-row column" data-setting="history-keep">
        <span>{STR.keepMoreHistory}</span>
        
        <select className="field-input" aria-label={STR.keepMoreHistory} value={keep}
          onChange={(e) => {
            if (!isHistoryKeep(e.target.value)) return;
            void call("setAgentHistoryKeep", { id: botId, keep: e.target.value })
              .then((r) => { if (r?.agent) acceptAgent(r.agent); })
              .catch(showError);
          }}>
          {HISTORY_KEEPS.map((h) => <option key={h} value={h}>{historyKeepLabel(h)}</option>)}
        </select>
      </label>
      <div className="settings-row gap stack">
        <button type="button" className="btn-outline" onClick={() => void call("compactAgentNow", { id: botId }).catch(showError)}>{STR.compactNow}</button>
        <button type="button" className="btn-outline" onClick={() => void call("newAgentSession", { id: botId }).catch(showError)}>{STR.newSession}</button>
        <button type="button" className="btn-outline" disabled title={STR5.notAvailableYet}>{STR.showMemoryFiles}</button>
      </div>
    </section>
  );
}
