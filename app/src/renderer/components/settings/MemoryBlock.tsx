import { STR5 } from "@synapse/shared";
import { useAsync } from "../../async-resource";
import { call, callQuiet } from "../../bridge";
import { Async } from "../Async";
import { registerGeneralBlock } from "./sections";

// MEM-07 / ORIG-06: the Memory dropdown (Standard / Dreaming), a General settings block
// (registered below; GeneralSection renders the registry's blocks).
//
// It used to be `useState<Phase5SettingsView | null>(null)` + `.catch(() => {})` + `if (!v) return
// null`: a host that would not answer deleted the Memory setting from Settings entirely, with no
// message and nothing to retry, looking exactly like a build where the feature did not exist.
export function MemoryBlock() {
  // callQuiet: this block presents its own failure, in place, where the dropdown would have been.
  const settings = useAsync(() => callQuiet("getPhase5Settings", {}), []);
  return (
    <div className="settings-card">
      <Async resource={settings} label={STR5.memory}>
        {(v) => (
          <div className="settings-row">
            <label htmlFor="memory-mode" style={{ flexGrow: 1 }}>{STR5.memory}</label>
            <select id="memory-mode" className="dropdown" value={v.memoryMode}
              onChange={(e) => void call("setMemoryMode", { mode: e.target.value as "standard" | "dreaming" }).then(settings.setValue)}>
              <option value="standard">{STR5.memoryStandard}</option>
              <option value="dreaming">{STR5.memoryDreaming}</option>
            </select>
          </div>
        )}
      </Async>
    </div>
  );
}

registerGeneralBlock("memory", 1, MemoryBlock); // under the Bot heading, with the time zone
