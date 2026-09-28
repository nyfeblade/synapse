import { useState } from "react";
import { STR, type ThemePreference } from "@synapse/shared";
import { launchPrefs, setLaunchPref, type LaunchPref } from "../../launch/prefs";
import { SavedSwitch } from "../SavedSwitch";
import { useUi } from "../../store";
import { setTheme, THEME_ORDER } from "../../theme";
import { registerGeneralBlock } from "./sections";

// SET-02 · General → Appearance: Theme — Follow System / Light / Dark. A three-way choice that
// shows what is saved, plus the launch snap's two switches; the command palette's "Theme: …" row is the accelerator for the same value.
// There is no Bot-colour control: the app is neutral, and a Bot's colour appears only on its own face.
export function AppearanceBlock() {
  const pref = useUi((s) => s.settings?.themePreference ?? "system");
  // The launch snap's switches: this Mac's own display preferences (launch/prefs.ts).
  const [launch, setLaunch] = useState(launchPrefs);
  const flip = (k: LaunchPref) => { setLaunchPref(k, !launch[k]); setLaunch(launchPrefs()); };
  return (
    <>
      <h3>{STR.appearance}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <label htmlFor="theme-pref" style={{ flexGrow: 1 }}>{STR.theme}</label>
          <select
            id="theme-pref"
            className="dropdown"
            aria-label={STR.theme}
            value={pref}
            onChange={(e) => void setTheme(e.target.value as ThemePreference)}
          >
            {THEME_ORDER.map((p) => <option key={p} value={p}>{STR.themeLabels[p]}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <span className="grow">{STR.launchAnimation}</span>
          <SavedSwitch label={STR.launchAnimation} value={launch.animation} onToggle={() => flip("animation")} />
        </div>
        <div className="settings-row">
          <span className="grow">{STR.launchSound}</span>
          <SavedSwitch label={STR.launchSound} value={launch.sound} onToggle={() => flip("sound")} />
        </div>
      </div>
    </>
  );
}

registerGeneralBlock("appearance", 5, AppearanceBlock);
