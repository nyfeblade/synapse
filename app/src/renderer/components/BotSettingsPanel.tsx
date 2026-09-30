import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_EFFORT, EFFORT_LABELS, EFFORT_LEVELS, NO_LIMITS_CONFIRM, STR, STR5, modelLabel, parseAcpModelRef, type EffortLevel, type ModelId, type PermMode } from "@synapse/shared";
import { setNotify } from "../bot-actions";
import { nativeCall } from "../native";
import { call, callQuiet } from "../bridge";
import { useAsync } from "../async-resource";
import { acceptAgent, useUi } from "../store";
import { BotAvatar } from "../avatar/BotAvatar";
import { VoiceSettings } from "../voice/VoiceSettings";
import { AdvancedSection } from "./AdvancedSection";
import { BrowserRow } from "./BrowserRow";
import { MacAppRow } from "./MacAppRow";
import { ActivityEntry, DryRunRow } from "./DryRunRow";
import { AvatarEditor } from "./AvatarEditor";
import { FollowupsToggle } from "./FollowupsToggle";
import { MemoryEntry } from "./MemoryPanel";
import { GoogleToggle } from "../google/GoogleToggle";
import { ComposioBotRows } from "../composio/ComposioBotRows";
import { McpAccountRows } from "../marketplace/McpAccountRows";
import { GitHubRow } from "../github/GitHubRow";
import { askConfirm } from "./ConfirmDialog";
import { BackIcon, CheckIcon, ChevronDownIcon, CloseIcon } from "./Icons";
import { SecretsSection } from "./SecretsSection";
import { SettingLinksLayer } from "./settings/SettingLinksLayer";
import { overlaysOpen } from "../overlay-stack";
import { usePopOrigin } from "../pop-origin";
import { pickableModels, startModelAccessSync, useModelAccess } from "../model-access";
import { hasProviders, useModelCatalog } from "../model-catalog";
import { ModelPickerList } from "./ModelPicker";
import { RatingsRow } from "../feedback/Ratings";
import { AcpSignInRow } from "./AcpSignInRow";

/** feat-mac-access-parity: the per-Bot permission mode (Ask / Auto-accept edits / Full auto), with a clear warning
 *  on Full auto. Neutral copy; the guard chip stays green via the existing switch/select styling. */
/** Bug 258: "No limits" is the fourth choice, above Full auto; it is a label only (no help line). */
type ModeChoice = PermMode | "no-limits";
const PERM_MODES: { value: ModeChoice; label: string; help: string | null }[] = [
  { value: "ask", label: STR5.permModeAsk, help: STR5.permModeAskHelp },
  { value: "accept-edits", label: STR5.permModeAcceptEdits, help: STR5.permModeAcceptEditsHelp },
  { value: "full-auto", label: STR5.permModeFullAuto, help: STR5.permModeFullAutoHelp },
  { value: "no-limits", label: STR5.permModeNoLimits, help: null },
];
function PermModeRow({ botId, onError }: { botId: string; onError(m: string): void }) {
  const bot = useUi((s) => s.bots[botId]);
  const mode: PermMode = bot?.settings.permMode ?? "ask";
  const noLimits = mode === "full-auto" && bot?.settings.noLimits === true;
  const choice: ModeChoice = noLimits ? "no-limits" : mode;
  const chosen = PERM_MODES.find((m) => m.value === choice) ?? PERM_MODES[0]!;
  // fix-fullauto-adoption: this Mac's OWN record of the mode (the coordinator answers; the host is never asked). A native
  // <select> fires no change when the user re-picks the value it shows, so re-selecting could never write that record:
  // when they differ, "Allow on this Mac" re-sends the mode through the coordinator, which records it.
  const mac = useAsync(() => callQuiet("getLocalBotMode", { id: botId }), [botId, mode], { enabled: mode !== "ask" });
  const set = (value: PermMode) => void call("setAgentPermMode", { id: botId, mode: value })
    .then((r) => { acceptAgent(r.agent); mac.reload(); })
    .catch((e: unknown) => onError(e instanceof Error ? e.message : STR.statusUnavailable));
  // Bug 258: No limits only after the one confirm that says what it removes and the risk; leaving it is one click.
  const choose = (value: ModeChoice) => {
    if (value !== "no-limits") return set(value);
    void askConfirm({ title: STR5.noLimitsConfirmTitle, line: STR5.noLimitsConfirmLine, verb: STR5.noLimitsConfirmVerb }).then(async (ok) => {
      if (!ok) return;
      // Fix round (review of bug 258): a per-dialog nonce main mints, checked once by the daemon. If main can't
      // (a bare renderer in a test), fall back to the fixed token so the flow still works.
      const confirm = await nativeCall<{ nonce?: string }>("noLimits.mintNonce").then((r) => r?.nonce ?? NO_LIMITS_CONFIRM).catch(() => NO_LIMITS_CONFIRM);
      void call("setAgentNoLimits", { id: botId, enabled: true, confirm })
        .then((r) => { acceptAgent(r.agent); mac.reload(); })
        .catch((e: unknown) => onError(e instanceof Error ? e.message : STR.statusUnavailable));
    });
  };
  const notOnMac = mode !== "ask" && mac.status === "ready" && !!mac.value?.mode && mac.value.mode !== mode;
  return (
    <div className="settings-row" data-setting="perm-mode" style={{ alignItems: "flex-start" }}>
      <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <span>{STR5.permMode}</span>
        {choice === "full-auto" && <span className="error" role="note" style={{ marginTop: 4 }}>{STR5.permModeFullAutoWarning}</span>}
        {notOnMac && (
          <span className="muted" style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center" }}>
            {STR5.permModeNotOnMac}
            <button type="button" className="btn-outline" onClick={() => set(mode)}>{STR5.permModeApplyOnMac}</button>
          </span>
        )}
      </span>
      {/* New-user walk, finding 21: the mode's explanation is the tooltip, not a subtitle. */}
      <select className="dropdown" aria-label={STR5.permMode} title={chosen.help ?? undefined} value={choice} onChange={(e) => choose(e.target.value as ModeChoice)}>
        {PERM_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </div>
  );
}

/** cost-diet-2 lever 1: this Bot's "Save usage" (simple messages on a faster model). Shows the effective state: the
 *  Bot's own switch, else the account's (Settings → Advanced); a click stores this Bot's own choice. */
function SaveUsageRow({ botId, onError }: { botId: string; onError(m: string): void }) {
  const bot = useUi((s) => s.bots[botId]);
  const account = useUi((s) => s.settings?.saveUsage ?? false);
  const on = bot?.settings.saveUsage ?? account;
  const set = () => void call("setAgentSaveUsage", { id: botId, enabled: !on })
    .then((r) => acceptAgent(r.agent))
    .catch((e: unknown) => onError(e instanceof Error ? e.message : STR.statusUnavailable));
  return (
    <div className="settings-row" data-setting="save-usage">
      <span style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}><span>{STR.saveUsage}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-label={STR.saveUsage} className={on ? "switch on" : "switch"} onClick={set} />
    </div>
  );
}

export function BotSettingsPanel({ botId }: { botId: string }) {
  const bot = useUi((s) => s.bots[botId]);
  const setPanel = useUi((s) => s.setPanel);
  // New-user walk, nit 27: Escape closes this panel, as it closes the computer view (an open picker or overlay first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || overlaysOpen() || document.querySelector("[data-bot-settings] .listbox")) return;
      setPanel("closed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPanel]);
  // New-user walk, finding 8: token counts are plumbing, shown only with advanced controls.
  const advanced = useUi((s) => s.settings?.advancedEnabled ?? false);
  const [name, setName] = useState(bot?.profile.name ?? "");
  const [desc, setDesc] = useState(bot?.profile.description ?? "");
  const [editing, setEditing] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P4: the picker offers only models the saved API key can reach (checked by the host; unchecked ones stay listed).
  const access = useModelAccess((s) => s.view);
  useEffect(() => { startModelAccessSync(); }, []);
  // Spec §10: with a model provider set up, the picker groups models by provider, with badges and What works.
  const catalog = useModelCatalog((s) => s.view);
  useEffect(() => { if (modelOpen) void useModelCatalog.getState().load(); }, [modelOpen]);
  // The grouped picker is tall: it opens fully visible — the trigger scrolled into view first, then below it when
  // there's room, else above it (whichever side has more), capped to that side's space and scrolling inside.
  const [placement, setPlacement] = useState<{ up: boolean; max: number } | null>(null);
  useLayoutEffect(() => {
    if (!modelOpen) { setPlacement(null); return; }
    const btn = modelRef.current?.querySelector(".select") as HTMLElement | null;
    if (!btn) return;
    btn.scrollIntoView?.({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 360 && above > below;
    setPlacement({ up, max: Math.max(160, Math.floor(up ? above - 24 : below)) });
  }, [modelOpen, catalog]);
  // Like a native select, the list opens on the current model: the list scrolls inside itself, never the panel.
  useLayoutEffect(() => {
    const list = modelList.current as unknown as HTMLElement | null;
    const sel = list?.querySelector("[aria-selected=\"true\"]") as HTMLElement | null;
    if (!list || !sel || !placement) return;
    const top = sel.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - (list.clientHeight - sel.offsetHeight) / 2);
  }, [placement]);
  useEffect(() => { setName(bot?.profile.name ?? ""); setDesc(bot?.profile.description ?? ""); }, [botId, bot?.profile.name, bot?.profile.description]);
  // The open list is opaque and paints over the rows below it (VoiceSettings, Notifications), so without a
  // dismissal path the next click anywhere under it silently picked a model. Escape and an outside mousedown
  // close it first, the way `Menu` does (components/Menus.tsx).
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  // "Ultra liquid": each list grows out of its own select button (pop-origin.ts), not a fixed point.
  const modelList = useRef<HTMLUListElement>(null);
  const effortList = useRef<HTMLUListElement>(null);
  usePopOrigin(modelList, () => modelRef.current?.querySelector(".select")?.getBoundingClientRect(), modelOpen);
  usePopOrigin(effortList, () => effortRef.current?.querySelector(".select")?.getBoundingClientRect(), effortOpen);
  useEffect(() => {
    if (!modelOpen && !effortOpen) return;
    // Behind every overlay, so the same rule applies: an Escape meant for a dialog on top must not
    // also collapse this popover underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || overlaysOpen()) return;
      setModelOpen(false);
      setEffortOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false);
      if (!effortRef.current?.contains(e.target as Node)) setEffortOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [modelOpen, effortOpen]);
  if (!bot) return null;
  const model = (bot.profile.model ?? "claude-sonnet-5") as ModelId;  // a provider ref reads the same way (modelLabel)
  const effort = (bot.profile.effort ?? DEFAULT_EFFORT) as EffortLevel;
  const save = (patch: Record<string, unknown>) => {
    setError(null);
    call("updateAgent", { id: botId, ...patch })
      .then((r) => acceptAgent(r.agent))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : STR.statusUnavailable));
  };

  return (
    <aside aria-label="Conversation details" className="panel wide" data-bot-settings={botId}>
      <div className="panel-head">
        <button type="button" className="icon-btn" aria-label="Back to details" onClick={() => setPanel("details")}><BackIcon /></button>
        {/* One "Settings" (UI polish pass): app preferences are Settings; this Bot's own panel is "Bot". */}
        <span className="panel-title">{STR.chatSettings}</span>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={() => setPanel("closed")}><CloseIcon /></button>
      </div>
      {error && <span className="error" role="alert">{error}</span>}
      <button type="button" aria-label="Edit avatar" aria-expanded={editing} className="avatar-btn" onClick={() => setEditing(!editing)}>
        <BotAvatar bot={bot} size={72} />
      </button>
      {editing && (
        <AvatarEditor botId={botId} shape={bot.profile.avatarShape} color={bot.profile.avatarColor} hasImage={bot.profile.avatarKind === "image"}
          onCancel={() => setEditing(false)}
          onSave={(avatarShape, avatarColor) => { save({ avatarShape, avatarColor }); setEditing(false); }}
          onImageSaved={(agent) => { acceptAgent(agent); setEditing(false); }} />
      )}
      <div className="field">
        <label htmlFor="bot-name">{STR.name}</label>
        <input id="bot-name" aria-label="Bot name" type="text" value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name !== bot.profile.name) save({ name }); else setName(bot.profile.name); }} />
      </div>
      <div className="field">
        <label htmlFor="bot-desc">{STR.instructions}</label>
        <textarea id="bot-desc" aria-label="Bot instructions" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)}
          onBlur={() => { if (desc !== bot.profile.description) save({ description: desc }); }} />
      </div>
      <div className="field model-field" ref={modelRef}>
        <span id="model-label">{STR.model}</span>
        <button type="button" aria-haspopup="listbox" aria-expanded={modelOpen} aria-label={`Model: ${modelLabel(model)}`} className={modelOpen ? "dropdown select open" : "dropdown select"} onClick={() => setModelOpen(!modelOpen)}>
          <span>{modelLabel(model)}</span><ChevronDownIcon />
        </button>
        {modelOpen && hasProviders(catalog) && (
          <div ref={modelList as unknown as React.RefObject<HTMLDivElement>} className={placement?.up ? "listbox model-pop up" : "listbox model-pop"}
            style={placement ? { maxHeight: placement.max } : undefined}>
            <ModelPickerList view={catalog} current={model} botId={botId} onPick={(m) => { setModelOpen(false); if (m !== model) save({ model: m }); }} />
          </div>
        )}
        {modelOpen && !hasProviders(catalog) && (
          <ul ref={modelList} role="listbox" aria-labelledby="model-label" className="listbox">
            {pickableModels(access, model).map((m) => (
              <li key={m} role="option" aria-selected={m === model} className={m === model ? "opt selected" : "opt"} onClick={() => { setModelOpen(false); if (m !== model) save({ model: m }); }}>
                <span style={{ flexGrow: 1 }}>{modelLabel(m)}</span>{m === model && <CheckIcon />}
              </li>
            ))}
          </ul>
        )}
      </div>
      {parseAcpModelRef(model) && <AcpSignInRow botId={botId} vendor={parseAcpModelRef(model)!} />}
      <div className="field model-field" ref={effortRef}>
        <span id="effort-label">{STR.effort}</span>
        <button type="button" aria-haspopup="listbox" aria-expanded={effortOpen} aria-label={`${STR.effort}: ${EFFORT_LABELS[effort]}`} className={effortOpen ? "dropdown select open" : "dropdown select"} onClick={() => setEffortOpen(!effortOpen)}>
          <span>{EFFORT_LABELS[effort]}</span><ChevronDownIcon />
        </button>
        {effortOpen && (
          <ul ref={effortList} role="listbox" aria-labelledby="effort-label" className="listbox">
            {EFFORT_LEVELS.map((e) => (
              <li key={e} role="option" aria-selected={e === effort} className={e === effort ? "opt selected" : "opt"} onClick={() => { setEffortOpen(false); if (e !== effort) save({ effort: e }); }}>
                <span style={{ flexGrow: 1 }}>{EFFORT_LABELS[e]}</span>{e === effort && <CheckIcon />}
              </li>
            ))}
          </ul>
        )}
      </div>
      <VoiceSettings botId={botId} />
      <div className="settings-card">
        <div className="settings-row" data-setting="notifications">
          <span style={{ flexGrow: 1 }}>{STR.notifications}</span>
          <button type="button" role="switch" aria-checked={bot.settings.notifyOnAgentUpdates} aria-label={STR.notifications}
            className={bot.settings.notifyOnAgentUpdates ? "switch on" : "switch"} onClick={() => void setNotify(bot.id, !bot.settings.notifyOnAgentUpdates)} />
        </div>
        <div className="settings-row" data-setting="engineering-mode">
          <span style={{ flexGrow: 1 }} title={STR5.engineeringModeHint}>{STR5.engineeringMode}</span>
          {advanced && <span className="muted">{STR5.engineeringModeCost}</span>}
          <button type="button" role="switch" aria-checked={!!bot.settings.engineeringMode} aria-label={STR5.engineeringMode}
            className={bot.settings.engineeringMode ? "switch on" : "switch"}
            onClick={() => void call("setAgentEngineeringMode", { id: bot.id, enabled: !bot.settings.engineeringMode })
              .then((r) => acceptAgent(r.agent))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : STR.statusUnavailable))} />
        </div>
        <PermModeRow botId={botId} onError={setError} />
        <SaveUsageRow botId={botId} onError={setError} />
        <BrowserRow botId={botId} />
        <MacAppRow botId={botId} />
        <DryRunRow botId={botId} />
        <ActivityEntry botId={botId} />
        <RatingsRow botId={botId} />
        {/* No "Computer perception" row: Live is shelved (decisions.md 2026-09-21); every Bot runs Screenshots. */}
      </div>
      <MemoryEntry onOpen={() => setPanel("memory")} />
      <GoogleToggle botId={botId} />
      <ComposioBotRows botId={botId} />
      <McpAccountRows botId={botId} />
      <GitHubRow botId={botId} />
      <SecretsSection botId={botId} />
      <FollowupsToggle botId={botId} />
      <AdvancedSection botId={botId} />
      <SettingLinksLayer key={botId} />
    </aside>
  );
}
