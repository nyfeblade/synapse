import { useEffect, useRef, useState } from "react";
import { DEFAULT_WORK_NOTIFY, STR, STR_HEALTH, type HostSettingsView, type WorkNotify } from "@synapse/shared";
import { call } from "../../bridge";
import { nativeCall, onNative } from "../../native";
import { acceptSettings, useUi } from "../../store";
import { SavedSwitch } from "../SavedSwitch";
import { Segmented } from "../Segmented";
import { registerGeneralBlock } from "./sections";

/** Whether Telegram is paired (main's bridge); the Telegram row shows only then. */
function useTelegramPaired(): boolean {
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    const load = () => void nativeCall<{ enabled?: boolean; owner?: unknown }>("telegram.status").then((v) => setPaired(!!v?.enabled && !!v.owner), () => setPaired(false));
    load();
    return onNative("telegram", () => load());
  }, []);
  return paired;
}

/** 4.4: Settings → General → Notifications: Work finished (On, Only long tasks, Off), and Also on Telegram. */
export function WorkNotifyBlock() {
  const s = useUi((x) => x.settings);
  const [pending, setPending] = useState<{ mode?: WorkNotify; telegram?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const paired = useTelegramPaired();
  const mode = pending.mode ?? (s ? s.workNotify ?? DEFAULT_WORK_NOTIFY : null);
  const telegram = pending.telegram ?? (s ? s.workNotifyTelegram === true : null);
  const put = (patch: Partial<HostSettingsView>, local: { mode?: WorkNotify; telegram?: boolean }) => {
    if (!s || busy.current) return;
    busy.current = true;
    setError(null);
    setPending(local);
    const settle = () => { busy.current = false; setPending({}); };
    void call("setHostSettings", patch).then((view) => { acceptSettings(view); settle(); }, () => { settle(); setError(STR.settingNotSaved); });
  };
  return (
    <>
      <h3>{STR.notifications}</h3>
      <div className="settings-card" data-setting="work-finished">
        <div className="settings-row">
          <span className="grow">{STR_HEALTH.workNotify}</span>
          {mode === null ? <span className="muted switch-pending" role="status" aria-label={STR_HEALTH.workNotify}>{STR.loading}</span> : (
            <Segmented<WorkNotify> label={STR_HEALTH.workNotify} value={mode} onChange={(v) => { if (v !== mode) put({ workNotify: v }, { mode: v }); }}
              options={[{ value: "on", label: STR_HEALTH.workNotifyOn }, { value: "long", label: STR_HEALTH.workNotifyLong }, { value: "off", label: STR_HEALTH.workNotifyOff }]} />
          )}
        </div>
        {paired && mode !== "off" && (
          <div className="settings-row">
            <span className="grow">{STR_HEALTH.workNotifyTelegram}</span>
            <SavedSwitch label={STR_HEALTH.workNotifyTelegram} value={telegram} busy={busy.current} onToggle={() => put({ workNotifyTelegram: !telegram }, { telegram: !telegram })} />
          </div>
        )}
        {error && <div className="settings-row"><span className="error" role="alert">{error}</span></div>}
      </div>
    </>
  );
}

registerGeneralBlock("work-finished", 5, WorkNotifyBlock);
