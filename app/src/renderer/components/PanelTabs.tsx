import { STRL } from "@synapse/shared";
import { useUi } from "../store";
import type { UiState } from "../reducer";
import { CloseIcon, GearIcon } from "./Icons";

const TABS = [
  { panel: "details", label: STRL.tabs.now },
  { panel: "memory", label: STRL.tabs.memory },
  { panel: "files", label: STRL.tabs.files },
] as const satisfies readonly { panel: UiState["panel"]; label: string }[];

/**
 * The right column's bar: Now / Memory / Files, then the Bot's settings and Close. The tabs ARE the
 * panel's state (store `panel`), so every view of the column — the Now cards, the memory ledger, the
 * files — is one click from any other, and Bot settings stays reachable from all of them.
 */
export function PanelTabs({ current }: { current: "details" | "memory" | "files" }) {
  const setPanel = useUi((s) => s.setPanel);
  return (
    <div className="panel-bar">
      <div className="panel-tabs" role="tablist" aria-label={STRL.detailsTabs}>
        {TABS.map((t) => (
          <button key={t.panel} type="button" role="tab" aria-selected={t.panel === current} tabIndex={t.panel === current ? 0 : -1} onClick={() => setPanel(t.panel)}>{t.label}</button>
        ))}
      </div>
      <button type="button" className="icon-btn" aria-label="Bot settings" onClick={() => setPanel("settings")}><GearIcon /></button>
      <button type="button" className="icon-btn" aria-label="Close details" onClick={() => setPanel("closed")}><CloseIcon /></button>
    </div>
  );
}
