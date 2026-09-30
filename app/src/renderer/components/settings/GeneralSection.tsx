import { useEffect, useRef, useState } from "react";
import { STR, STR_RULES } from "@synapse/shared";
import { asResource } from "../../async-resource";
import { setTimeZone } from "../../bot-actions";
import { call } from "../../bridge";
import { acceptSettings, useUi } from "../../store";
import { AdvancedSettingsCard } from "../AdvancedSettingsCard";
import { Async } from "../Async";
import { TrashIcon } from "../Icons";
import { RulesHome } from "./RulesSection";
import { generalExtraBlocks, SectionBlocks } from "./sections";

/** Safety v2: Settings → Rules (was Auto-review): the switch, the preset, rules in plain English, guidelines, trusted people. */
export function AutoReviewSection() {
  const { settings, settingsFocus, bootstrap, loadAll } = useUi();
  const focusRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settingsFocus !== "auto-review") return;
    focusRef.current?.scrollIntoView?.({ block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2000); // SET-18: highlight the linked row for 2 s
    return () => clearTimeout(t);
  }, [settingsFocus]);
  // `return null` here made a failed bootstrap indistinguishable from a Settings modal that had not
  // finished opening. `settings` is filled in by store.loadAll(), so its bootstrap status is this section's status.
  if (!settings) {
    return (
      <>
        <h2>{STR_RULES.rules}</h2>
        <Async resource={asResource(bootstrap, () => void loadAll())}>{() => null}</Async>
      </>
    );
  }
  const putTrusted = async (trustedRecipients: string[]) => {
    try {
      setError(null);
      acceptSettings(await call("setHostSettings", { trustedRecipients }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div ref={focusRef} className={flash ? "settings-block flash" : "settings-block"}>
      <RulesHome trusted={<>
        {error && <span className="error" role="alert">{error}</span>}
        <TrustedPeople list={settings.trustedRecipients ?? []} save={putTrusted} />
      </>} />
      <SectionBlocks section="auto-review" />
    </div>
  );
}

/** Smarter approvals: sends to only these people (and you) skip the card. Set here only; a Bot can't change it. */
function TrustedPeople({ list, save }: { list: string[]; save: (next: string[]) => Promise<void> }) {
  const [text, setText] = useState("");
  const add = async () => {
    const e = text.trim().toLowerCase();
    if (!e) return;
    await save([...list.filter((x) => x !== e), e]);
    setText("");
  };
  return (
    <>
      <h3>{STR.trustedPeople}</h3>
      <div className="settings-card">
        <div className="rules">
          <div className="rule-controls">
            <input type="email" aria-label={STR.trustedPeople} value={text} maxLength={254} placeholder={STR.trustedPlaceholder} style={{ flexGrow: 1 }}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
            <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => void add()}>{STR.add}</button>
          </div>
          {list.length > 0 && <div role="table" aria-label={STR.trustedPeople} className="rules-table">
            {list.map((e) => (
              <div role="row" key={e} className="rules-row">
                <span role="cell" className="rule-text" title={e}>{e}</span>
                <span role="cell" className="rule-actions">
                  <button type="button" className="icon-btn" aria-label={`Remove ${e}`} onClick={() => void save(list.filter((x) => x !== e))}><TrashIcon /></button>
                </span>
              </div>
            ))}
          </div>}
        </div>
      </div>
    </>
  );
}

/**
 * New-user walk, finding 22: General is the Bot's basics, then Appearance, Connected accounts and Advanced, each under
 * its own heading (accounts and memory used to sit under "Appearance"); Auto-review is a section of its own.
 */
export function GeneralSection() {
  const { settings, bootstrap, loadAll } = useUi();
  if (!settings) {
    return (
      <>
        <h2>{STR.general}</h2>
        <Async resource={asResource(bootstrap, () => void loadAll())}>{() => null}</Async>
      </>
    );
  }
  const blocks = generalExtraBlocks();
  return (
    <>
      <h2>{STR.general}</h2>
      <h3>{STR.bot}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <span style={{ flexGrow: 1 }}>{STR.timezone}</span>
          <select className="dropdown" aria-label={STR.timezone} value={settings.userTimeZoneOverride ?? ""} onChange={(e) => void setTimeZone(e.target.value)}>
            <option value="">{STR.timezoneAuto(Intl.DateTimeFormat().resolvedOptions().timeZone)}</option>
            {Intl.supportedValuesOf("timeZone").map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>
      {blocks.map(({ id, Component }) => <Component key={id} />)}
      <h3>{STR.advanced}</h3>
      <AdvancedSettingsCard />
    </>
  );
}
