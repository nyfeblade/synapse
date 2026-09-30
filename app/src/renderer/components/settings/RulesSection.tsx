import { useEffect, useRef, useState } from "react";
import {
  PRESET_LABEL, STR, STR_RULES, TYPE_LABEL,
  type BotNetwork, type MacActionFacts, type PresetName, type RuleType, type SafetyCompileView, type SafetyRuleView, type SafetyView,
} from "@synapse/shared";
import { call } from "../../bridge";
import { acceptSettings, useUi } from "../../store";
import { Segmented } from "../Segmented";
import { TrashIcon } from "../Icons";

/** Safety v2: the rules, guidelines and network lists, read from the host and kept here (only this screen edits them). */
export function useSafety(): { view: SafetyView | null; set(v: SafetyView): void; error: string | null; setError(e: string | null): void } {
  const [view, set] = useState<SafetyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call("getSafety", {} as Record<string, never>).then((v) => { if (live && v && Array.isArray(v.rules)) set(v); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return { view, set, error, setError };
}

const PRESETS: readonly { value: PresetName; label: string }[] = [
  { value: "careful", label: PRESET_LABEL.careful },
  { value: "balanced", label: PRESET_LABEL.balanced },
  { value: "hands-off", label: PRESET_LABEL["hands-off"] },
];
const TYPES: RuleType[] = ["allow", "ask", "never"];

/** Plain English in, the exact rule and its preview out; nothing is saved until Add. */
function AddRule({ botId, draft, onSaved, onError }: { botId?: string | null; draft?: string | null; onSaved(v: SafetyView): void; onError(e: string | null): void }) {
  const [text, setText] = useState(draft ?? "");
  const [compiled, setCompiled] = useState<SafetyCompileView | null>(null);
  const seq = useRef(0);
  // The preview also replays the Mac's own action log (answered by the Mac; absent when no Mac is connected).
  const mac = useRef<MacActionFacts[]>([]);
  useEffect(() => {
    call("listMacActions", { limit: 50, ...(botId ? { botId } : {}) })
      .then((r) => { mac.current = (r?.entries ?? []).map((e) => ({ botId: e.botId, kind: e.kind, op: e.op, targets: e.targets, ...(e.act ? { act: e.act } : {}), ...(e.command ? { command: e.command } : {}), at: e.at })); })
      .catch(() => {});
  }, [botId]);
  useEffect(() => { if (draft) setText(draft); }, [draft]);
  useEffect(() => {
    const t = text.trim();
    if (!t) { setCompiled(null); return; }
    const n = ++seq.current;
    const timer = setTimeout(() => {
      call("compileSafetyRule", { text: t, botId: botId ?? null, ...(mac.current.length ? { macActions: mac.current } : {}) }).then((r) => { if (n === seq.current) setCompiled(r); }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [text, botId]);
  const add = async (asExceptionTo: string | null = null) => {
    try {
      onError(null);
      const v = await call("addSafetyRule", { text: text.trim(), botId: botId ?? null, asExceptionTo });
      onSaved(v);
      setText("");
      setCompiled(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const ok = compiled?.ok === true ? compiled : null;
  return (
    <div className="rules">
      <div className="rule-controls">
        <input type="text" aria-label={STR_RULES.addRule} value={text} maxLength={300} placeholder={botId ? STR_RULES.botRulePlaceholder : STR_RULES.rulePlaceholder} style={{ flexGrow: 1, minWidth: 0 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) void add();
            if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); }
          }} />
        <button type="button" className="btn-primary" disabled={!ok} onClick={() => void add()}>{STR_RULES.addRule}</button>
      </div>
      {ok && (
        <div className="rule-compiled" aria-label="Compiled rule">
          <span className="rule-words">{ok.words.map((w, i) => <span key={i} className="rule-word">{w}</span>)}</span>
          <span className="muted rule-preview">{STR_RULES.preview(ok.preview.changed, ok.preview.of)}</span>
          {ok.conflicts.map((c) => (
            <button key={c.id} type="button" className="link-btn" onClick={() => void add(c.id)}>{STR_RULES.asException(c.text)}</button>
          ))}
        </div>
      )}
      {compiled && !compiled.ok && text.trim() && <span className="muted rule-reason" role="status">{compiled.reason}</span>}
    </div>
  );
}

/** One row per rule: its type, its words, on or off, and delete. `focusId` flashes a rule ("Loosen this rule…"). */
function RuleRows({ rules, focusId, onChange, onError }: { rules: SafetyRuleView[]; focusId?: string | null; onChange(v: SafetyView): void; onError(e: string | null): void }) {
  const run = (p: Promise<SafetyView>) => p.then((v) => { onError(null); onChange(v); }).catch((e: Error) => onError(e.message));
  const flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusId) flashRef.current?.scrollIntoView?.({ block: "center" }); }, [focusId]);
  if (!rules.length) return null;
  return (
    <div role="table" aria-label={STR_RULES.rules} className="rules-table">
      <div role="row" className="rules-head"><span role="columnheader" style={{ flexGrow: 1 }}>{STR_RULES.ruleCol}</span><span role="columnheader" className="behavior-col">{STR_RULES.typeCol}</span></div>
      {rules.map((r) => (
        <div role="row" key={r.id} ref={r.id === focusId ? flashRef : undefined} className={`rules-row${r.id === focusId ? " flash" : ""}${r.enabled ? "" : " off"}`} data-rule={r.id}>
          <span role="cell" className="rule-text" title={r.words.join(" · ")}>
            {r.text}
            {r.source === "preset" && <span className="rule-tag">{STR_RULES.presetTag}</span>}
            {r.reviewOnly && <span className="rule-tag">{STR_RULES.reviewTag}</span>}
            {r.except.map((e, i) => (
              <button key={i} type="button" className="rule-tag except" aria-label={STR_RULES.removeExcept(Object.values(e).flat().join(", "))}
                onClick={() => void run(call("updateSafetyRule", { id: r.id, removeExcept: i }))}>− {Object.values(e).flat().join(", ")}</button>
            ))}
          </span>
          <span role="cell" className="behavior-col">
            <select className="dropdown compact" aria-label={STR_RULES.ruleType(r.text)} value={r.type} onChange={(e) => void run(call("updateSafetyRule", { id: r.id, type: e.target.value as RuleType }))}>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </span>
          <span role="cell" className="rule-actions">
            <button type="button" role="switch" aria-checked={r.enabled} aria-label={STR_RULES.ruleOn(r.text)} className={r.enabled ? "switch on small" : "switch small"}
              onClick={() => void run(call("updateSafetyRule", { id: r.id, enabled: !r.enabled }))} />
            <button type="button" className="icon-btn" aria-label={STR_RULES.deleteRule(r.text)} onClick={() => void run(call("deleteSafetyRule", { id: r.id }))}><TrashIcon /></button>
          </span>
        </div>
      ))}
    </div>
  );
}

function Guidelines({ view, botId, onChange, onError }: { view: SafetyView; botId: string | null; onChange(v: SafetyView): void; onError(e: string | null): void }) {
  const [text, setText] = useState("");
  const mine = view.guidelines.filter((g) => g.botId === botId);
  const save = (next: SafetyView["guidelines"]) =>
    call("setGuidelines", { guidelines: next }).then((v) => { onError(null); onChange(v); setText(""); }).catch((e: Error) => onError(e.message));
  return (
    <div className="rules">
      <div className="rule-controls">
        <input type="text" aria-label={STR_RULES.guidelines} value={text} maxLength={500} placeholder={STR_RULES.guidelinePlaceholder} style={{ flexGrow: 1 }}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) void save([...view.guidelines, { id: "", text: text.trim(), botId }]); }} />
        <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => void save([...view.guidelines, { id: "", text: text.trim(), botId }])}>{STR_RULES.addGuideline}</button>
      </div>
      {mine.length > 0 && <div role="table" aria-label={STR_RULES.guidelines} className="rules-table">
        {mine.map((g) => (
          <div role="row" key={g.id} className="rules-row">
            <span role="cell" className="rule-text" title={g.text}>{g.text}</span>
            <span role="cell" className="rule-actions">
              <button type="button" className="icon-btn" aria-label={STR_RULES.deleteGuideline(g.text)} onClick={() => void save(view.guidelines.filter((x) => x.id !== g.id))}><TrashIcon /></button>
            </span>
          </div>
        ))}
      </div>}
    </div>
  );
}

/** Settings → Rules: the Auto-review switch, the preset, the rules, guidelines and trusted people. */
export function RulesHome({ trusted }: { trusted: React.ReactNode }) {
  const { settings, settingsFocus } = useUi();
  const { view, set, error, setError } = useSafety();
  const [pending, setPending] = useState<{ preset: PresetName; diff: { adds: string[]; removes: string[]; changes: string[] } } | null>(null);
  // "Make this a rule…" opens here with a draft; "Loosen this rule…" with the rule to flash.
  const focus = settingsFocus ?? "";
  const draft = focus.startsWith("auto-review/add:") ? decodeURIComponent(focus.slice("auto-review/add:".length)) : null;
  const focusRule = focus.startsWith("auto-review/rule:") ? focus.slice("auto-review/rule:".length) : null;
  if (!settings) return null;
  const put = async (patch: { autoReviewEnabled?: boolean; allowInstructions?: string[] }) => {
    try { setError(null); acceptSettings(await call("setHostSettings", patch)); } catch (e) { setError((e as Error).message); }
  };
  const pick = (preset: PresetName) => {
    if (view && preset === view.preset) { setPending(null); return; }
    call("setSafetyPreset", { preset, preview: true }).then((r) => setPending({ preset, diff: r.diff })).catch((e: Error) => setError(e.message));
  };
  const apply = () => {
    if (!pending) return;
    call("setSafetyPreset", { preset: pending.preset }).then((r) => { set(r); setPending(null); }).catch((e: Error) => setError(e.message));
  };
  const global = view ? view.rules.filter((r) => !r.scope.bots?.length) : [];
  const legacyAllow = settings.allowInstructions;
  return (
    <>
      <h2>{STR_RULES.rules}</h2>
      <div className="settings-card">
        <div className="settings-row">
          <span style={{ flexGrow: 1 }}>{STR.autoReview}</span>
          <button type="button" role="switch" aria-checked={settings.autoReviewEnabled} aria-label={STR.autoReview} className={settings.autoReviewEnabled ? "switch on" : "switch"}
            onClick={() => void put({ autoReviewEnabled: !settings.autoReviewEnabled })} />
        </div>
        {view && (
          <div className="settings-row" data-setting="preset">
            <span style={{ flexGrow: 1 }}>{STR_RULES.preset}</span>
            {view.preset === "custom" && <span className="muted">{STR_RULES.presetCustom}</span>}
            <Segmented label={STR_RULES.preset} value={pending?.preset ?? (view.preset === "custom" ? null : view.preset)} options={PRESETS} onChange={pick} />
          </div>
        )}
        {pending && (
          <div className="settings-row preset-diff" role="group" aria-label={STR_RULES.presetSwitch(PRESET_LABEL[pending.preset])}>
            <span style={{ flexGrow: 1 }} className="preset-lines">
              {pending.diff.removes.length > 0 && <span><b>{STR_RULES.presetStops}</b> {pending.diff.removes.join(", ")}</span>}
              {pending.diff.adds.length > 0 && <span><b>{STR_RULES.presetStarts}</b> {pending.diff.adds.join(", ")}</span>}
              {pending.diff.changes.length > 0 && <span><b>{STR_RULES.presetStricter}</b> {pending.diff.changes.join(", ")}</span>}
              {!pending.diff.removes.length && !pending.diff.adds.length && !pending.diff.changes.length && <span>{STR_RULES.presetNoChange}</span>}
            </span>
            <button type="button" className="btn-outline" onClick={() => setPending(null)}>{STR.cancel}</button>
            <button type="button" className="btn-primary" onClick={apply}>{STR_RULES.presetSwitch(PRESET_LABEL[pending.preset])}</button>
          </div>
        )}
      </div>
      {error && <span className="error" role="alert">{error}</span>}
      {view && (
        <>
          <div className="settings-card rules-card">
            <AddRule draft={draft} onSaved={set} onError={setError} />
            <RuleRows rules={global} focusId={focusRule} onChange={set} onError={setError} />
            {legacyAllow.length > 0 && <div role="table" aria-label={STR_RULES.reviewTag} className="rules-table" style={{ marginBottom: 12 }}>
              {legacyAllow.map((r, i) => (
                <div role="row" key={`${i}-${r}`} className="rules-row">
                  <span role="cell" className="rule-text" title={r}>{r}<span className="rule-tag">{STR_RULES.reviewTag}</span></span>
                  <span role="cell" className="behavior-col muted-2">{STR.allowAutomatically}</span>
                  <span role="cell" className="rule-actions">
                    <button type="button" className="icon-btn" aria-label={STR_RULES.deleteRule(r)} onClick={() => void put({ allowInstructions: legacyAllow.filter((_, j) => j !== i) })}><TrashIcon /></button>
                  </span>
                </div>
              ))}
            </div>}
          </div>
          <h3>{STR_RULES.guidelines}</h3>
          <div className="settings-card">
            <Guidelines view={view} botId={null} onChange={set} onError={setError} />
          </div>
        </>
      )}
      {trusted}
    </>
  );
}

/** Bot settings: this Bot's network, its own rules and its guidelines. */
export function BotRulesBlock({ botId }: { botId: string }) {
  const { view, set, error, setError } = useSafety();
  const net: BotNetwork = view?.networks[botId] ?? { mode: "open", hosts: [] };
  const [hosts, setHosts] = useState<string | null>(null);
  if (!view) return null;
  const saveNet = (mode: BotNetwork["mode"], list: string[]) =>
    call("setBotNetwork", { botId, mode, hosts: list }).then((v) => { setError(null); set(v); setHosts(null); }).catch((e: Error) => setError(e.message));
  const hostText = hosts ?? net.hosts.join(", ");
  const listOf = (t: string) => t.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const mine = view.rules.filter((r) => r.scope.bots?.includes(botId));
  return (
    <div className="bot-rules" data-setting="bot-rules">
      <div className="settings-card">
        <div className="settings-row" data-setting="network">
          <span style={{ flexGrow: 1 }}>{STR_RULES.network}</span>
          <select className="dropdown" aria-label={STR_RULES.network} value={net.mode}
            onChange={(e) => { const m = e.target.value as BotNetwork["mode"]; if (m === "open" || listOf(hostText).length) void saveNet(m, listOf(hostText)); else set({ ...view, networks: { ...view.networks, [botId]: { mode: m, hosts: [] } } }); }}>
            <option value="open">{STR_RULES.networkOpen}</option>
            <option value="only">{STR_RULES.networkOnly}</option>
            <option value="block">{STR_RULES.networkBlock}</option>
          </select>
        </div>
        {net.mode !== "open" && (
          <div className="settings-row">
            <input type="text" aria-label={STR_RULES.networkHosts} value={hostText} placeholder={STR_RULES.networkPlaceholder} style={{ flexGrow: 1 }} className="inline-input"
              onChange={(e) => setHosts(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveNet(net.mode, listOf(hostText)); }} />
            <button type="button" className="btn-outline" disabled={hosts === null} onClick={() => void saveNet(net.mode, listOf(hostText))}>{STR_RULES.save}</button>
          </div>
        )}
      </div>
      <span className="field-label">{STR_RULES.thisBotsRules}</span>
      <div className="settings-card">
        <AddRule botId={botId} onSaved={set} onError={setError} />
        <RuleRows rules={mine} onChange={set} onError={setError} />
      </div>
      <span className="field-label">{STR_RULES.guidelines}</span>
      <div className="settings-card">
        <Guidelines view={view} botId={botId} onChange={set} onError={setError} />
      </div>
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
