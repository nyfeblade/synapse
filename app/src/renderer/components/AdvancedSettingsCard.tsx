import { STR } from "@synapse/shared";
import { call } from "../bridge";
import { acceptSettings, useUi } from "../store";

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <div className="settings-row">
      <span className="grow">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? "switch on" : "switch"} onClick={() => onChange(!on)} />
    </div>
  );
}

export function AdvancedSettingsCard() {
  const s = useUi((x) => x.settings);
  if (!s) return null;
  // Hand-testing round: this write had no catch, so a rejected gateway call was an unhandled
  // promise rejection and the switch simply did not move — a click with no effect and no message
  // anywhere. Every sibling write in the renderer routes failures into `actionError` (bot-actions.ts,
  // usage/store.ts, AdvancedSection.tsx), which the sidebar renders as a role="alert" banner.
  const set = async (patch: { advancedEnabled?: boolean; memoryRecall?: boolean; saveUsage?: boolean }) => {
    try {
      acceptSettings(await call("setHostSettings", patch));
    } catch (e) {
      useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <section className="settings-card" aria-label={STR.advanced}>
      {/* cost-diet-2 lever 1: account-wide "Save usage" (model routing), default off; a Bot's own switch wins. */}
      <Switch label={`${STR.saveUsage}: ${STR.saveUsageHint.toLowerCase()}`} on={s.saveUsage ?? false} onChange={(v) => void set({ saveUsage: v })} />
      {/* "Computer perception" (Screenshots / Live) was removed: Live is shelved (decisions.md 2026-09-21); every Bot runs Screenshots. */}
      <Switch label={STR.showAdvanced} on={s.advancedEnabled} onChange={(v) => void set({ advancedEnabled: v })} />
      {s.advancedEnabled && <Switch label={STR.perTurnRecall} on={s.memoryRecall} onChange={(v) => void set({ memoryRecall: v })} />}
    </section>
  );
}
