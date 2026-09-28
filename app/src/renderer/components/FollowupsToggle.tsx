import { STR5 } from "@synapse/shared";
import { call } from "../bridge";
import { acceptAgent, useUi } from "../store";

/** SET-15: under Advanced (D14), per-Bot "Proactive follow-ups", default off (ORIG-11). */
export function FollowupsToggle({ botId }: { botId: string }) {
  const on = useUi((s) => s.bots[botId]?.settings.advanced?.followups === true);
  // Hand-testing round: this used to snapshot the advanced flag once at mount via
  // getPhase5Settings, so toggling "Show advanced controls" in Settings left this row disagreeing
  // with the Advanced card mounted right beside it in the same panel. Both now read the same live
  // store value that AdvancedSettingsCard writes.
  const advanced = useUi((s) => s.settings?.advancedEnabled ?? false);
  if (!advanced) return null;
  return (
    <div className="settings-row">
      <span style={{ flexGrow: 1 }}>{STR5.proactiveFollowups}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={STR5.proactiveFollowups} className={on ? "switch on" : "switch"} onClick={() => void call("setAgentFollowups", { id: botId, enabled: !on }).then((r) => acceptAgent(r.agent), () => {})} />
    </div>
  );
}
