import { useEffect, useRef, useState } from "react";
import { STR } from "@synapse/shared";
import { asResource } from "../../async-resource";
import { setTimeZone } from "../../bot-actions";
import { call } from "../../bridge";
import { acceptSettings, useUi } from "../../store";
import { AdvancedSettingsCard } from "../AdvancedSettingsCard";
import { Async } from "../Async";
import { PencilIcon, TrashIcon } from "../Icons";
import { generalExtraBlocks } from "./sections";

type Behavior = "allow" | "ask";

export function AutoReviewSection() {
  const { settings, settingsFocus, bootstrap, loadAll } = useUi();
  const [text, setText] = useState("");
  const [behavior, setBehavior] = useState<Behavior>("allow");
  const [editing, setEditing] = useState<{ behavior: Behavior; rule: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (settingsFocus !== "auto-review") return;
    focusRef.current?.scrollIntoView?.({ block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2000); // SET-18: highlight the linked row for 2 s
    return () => clearTimeout(t);
  }, [settingsFocus]);
  // `return null` here made a failed bootstrap indistinguishable from a Settings modal that had not
  // finished opening: the whole General pane was simply absent, with no way to ask for it again.
  // `settings` is filled in by store.loadAll(), so its bootstrap status is this section's status.
  if (!settings) {
    return (
      <>
        <h2>{STR.autoReview}</h2>
        <Async resource={asResource(bootstrap, () => void loadAll())}>{() => null}</Async>
      </>
    );
  }

  const put = async (patch: { autoReviewEnabled?: boolean; allowInstructions?: string[]; blockInstructions?: string[] }) => {
    try {
      setError(null);
      const view = await call("setHostSettings", patch);
      acceptSettings(view);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const listOf = (b: Behavior) => (b === "allow" ? settings.allowInstructions : settings.blockInstructions);
  const patchFor = (b: Behavior, list: string[]) => (b === "allow" ? { allowInstructions: list } : { blockInstructions: list });
  // Hand-testing round, two defects here:
  //   * `editing` held a positional index, and the Delete buttons stay live during an edit, so
  //     deleting any earlier rule shifted every later index down and the save landed on the wrong
  //     rule (or vanished). The edit is now keyed to the rule's text, looked up at save time.
  //   * There was no way out of edit mode: the button still said "Add Rule", there was no Cancel,
  //     and nothing cleared `editing` but a completed save — so the next rule the user typed
  //     silently overwrote the one they had opened for editing.
  const addRule = async () => {
    const rule = text.trim();
    if (!rule) return;
    const at = editing ? listOf(editing.behavior).indexOf(editing.rule) : -1;
    if (editing && at >= 0) {
      if (editing.behavior === behavior) await put(patchFor(behavior, listOf(behavior).map((r, i) => (i === at ? rule : r))));
      else await put({ ...patchFor(editing.behavior, listOf(editing.behavior).filter((_, i) => i !== at)), ...patchFor(behavior, [...listOf(behavior), rule]) });
    } else await put(patchFor(behavior, [...listOf(behavior), rule])); // no edit, or the edited rule is gone: append
    setText("");
    setEditing(null);
  };
  const cancelEdit = () => { setEditing(null); setText(""); };
  const rows = [
    ...settings.allowInstructions.map((r, i) => ({ r, i, b: "allow" as const })),
    ...settings.blockInstructions.map((r, i) => ({ r, i, b: "ask" as const })),
  ];

  return (
    <>
      <h2>{STR.autoReview}</h2>
      <div className="settings-card">
        <div ref={focusRef} className={flash ? "settings-block flash" : "settings-block"}>
          <div className="settings-row">
            <span style={{ flexGrow: 1 }}>{STR.autoReview}</span>
            <button type="button" role="switch" aria-checked={settings.autoReviewEnabled} aria-label={STR.autoReview} className={settings.autoReviewEnabled ? "switch on" : "switch"}
              onClick={() => void put({ autoReviewEnabled: !settings.autoReviewEnabled })} />
          </div>
          <div className="rules">
            <label htmlFor="rule-action">{STR.rulesWhen}</label>
            <input id="rule-action" type="text" value={text} maxLength={1000} placeholder={STR.rulesPlaceholder} onChange={(e) => setText(e.target.value)}
              // Escape here used to race the modal's own handler and lose: the whole Settings dialog
              // went, taking the half-typed rule with it. The innermost handler gets first refusal —
              // when there is something to cancel, this cancels the field's edit and stops the event
              // before the overlay stack sees it. With nothing pending, Escape still closes Settings.
              onKeyDown={(e) => {
                if (e.key === "Enter") { void addRule(); return; }
                if (e.key !== "Escape" || (!text && editing === null)) return;
                e.stopPropagation();
                cancelEdit();
              }} />
            <div className="rule-controls">
              <label htmlFor="rule-behavior">{STR.rulesItShould}</label>
              <select id="rule-behavior" className="dropdown" value={behavior} onChange={(e) => setBehavior(e.target.value as Behavior)}>
                <option value="allow">{STR.allowAutomatically}</option>
                <option value="ask">{STR.askFirst}</option>
              </select>
              <span style={{ flexGrow: 1 }} />
              {editing && <button type="button" className="btn-secondary" onClick={cancelEdit}>{STR.cancel}</button>}
              <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => void addRule()}>{editing ? STR.saveRule : STR.addRule}</button>
            </div>
            {error && <span className="error" role="alert">{error}</span>}
            {/* UI polish pass (critique 3.6): no empty "Action | Behavior" header — the table appears with its first rule. */}
            {rows.length > 0 && <div role="table" aria-label="Auto-review rules" className="rules-table">
              <div role="row" className="rules-head"><span role="columnheader" style={{ flexGrow: 1 }}>{STR.rulesAction}</span><span role="columnheader" className="behavior-col">{STR.rulesBehavior}</span></div>
              {rows.map(({ r, i, b }) => (
                <div role="row" key={`${b}-${i}`} className="rules-row">
                  <span role="cell" className="rule-text" title={r}>{r}</span>
                  <span role="cell" className="behavior-col muted-2">{b === "allow" ? STR.allowAutomatically : STR.askFirst}</span>
                  <span role="cell" className="rule-actions">
                    <button type="button" className="icon-btn" aria-label="Edit rule" onClick={() => { setText(r); setBehavior(b); setEditing({ behavior: b, rule: r }); }}><PencilIcon /></button>
                    <button type="button" className="icon-btn" aria-label="Delete rule" onClick={() => void put(patchFor(b, listOf(b).filter((_, j) => j !== i)))}><TrashIcon /></button>
                  </span>
                </div>
              ))}
            </div>}
          </div>
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
