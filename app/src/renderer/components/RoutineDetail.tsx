import { useEffect, useRef, useState, type FocusEvent } from "react";
import { STR, type HostSettingsView, type RoutineRun, type RoutineView } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";
import { acceptSettings, useUi } from "../store";
import { ConnectListenerForm } from "./ConnectListenerCard";
import { BackIcon, CopyIcon, TrashIcon } from "./Icons";
import { askConfirm } from "./ConfirmDialog";
import { copyWithConfirmation } from "../toast";
import { MailboxForm } from "./MailboxForm";
import { usePopOrigin } from "../pop-origin";

const STATUS: Record<RoutineRun["status"], string> = { ok: "Succeeded", error: "Failed", running: "Running" };
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Motion-spec §7.5: a copy the user cannot tell from a misclick is a defect, not a polish item. */
const copy = (text: string) => void copyWithConfirmation(text);

/** Serialized-write toggle: flips what's shown at once, sends writes to the host one at a time in click
 *  order, and reconciles to the host's value once the last write settles (same fix as RoutineDetail's
 *  Active switch, controller ruling 2). */
function useSerializedToggle(saved: boolean, write: (next: boolean) => Promise<HostSettingsView>) {
  const [shown, setShown] = useState<boolean | null>(null);
  const q = useRef({ chain: null as Promise<void> | null, latest: 0 });
  const value = shown ?? saved;
  const toggle = () => {
    const next = !value;
    setShown(next);
    const mine = ++q.current.latest;
    const run = () => write(next).then((view) => acceptSettings(view));
    // A refused save used to reject this chain: nothing was shown, the optimistic value stayed on
    // screen as if it had been saved, and every later toggle inherited the rejection.
    const chain: Promise<void> = (q.current.chain ? q.current.chain.then(run) : run()).catch((e: unknown) => {
      useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });
    }).then(() => {
      if (q.current.latest !== mine) return;
      q.current.chain = null;
      setShown(null); // settled: show what the host saved
    });
    q.current.chain = chain;
  };
  return { value, toggle };
}

export function PublicWebhookRow() {
  const settings = useUi((s) => s.settings);
  const saved = settings?.publicWebhook?.enabled ?? false;
  const { value: on, toggle } = useSerializedToggle(saved, (enabled) => call("setHostSettings", { publicWebhook: { enabled, url: null } }));
  if (!settings) return null;
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span>{STR.publicWebhookUrl}</span>
        <span className="field-help">{settings.publicWebhook?.url ?? (settings.webhookLan ? "Off: the URL works from your Mac and local network only." : "Off: the URL works from this computer only.")}</span>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={STR.publicWebhookUrl} className={`switch${on ? " on" : ""}`} onClick={toggle} />
    </div>
  );
}

/** I5: the listener binds 127.0.0.1 unless the user turns this on. */
export function WebhookLanRow() {
  const settings = useUi((s) => s.settings);
  const saved = settings?.webhookLan ?? false;
  const { value: on, toggle } = useSerializedToggle(saved, (webhookLan) => call("setHostSettings", { webhookLan }));
  if (!settings) return null;
  // Bug 52: when the host could not bind the network address it puts the switch back and says why here.
  const failed = settings.webhookLanError ?? null;
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span>Reachable on your local network</span>
        <span className="field-help">Off: webhooks are accepted from this computer only.</span>
        {failed && <span id="webhook-lan-error" className="field-error" role="alert">{failed}</span>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label="Reachable on your local network" aria-describedby={failed ? "webhook-lan-error" : undefined} className={`switch${on ? " on" : ""}`} onClick={toggle} />
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <button type="button" className="copy-field" aria-label={`${label} ${value}`} onClick={() => copy(value)}>
      <span className="copy-label">{label}</span><code className="copy-value">{value}</code><CopyIcon />
    </button>
  );
}

function RunRow({ run }: { run: RoutineRun }) {
  const [menu, setMenu] = useState(false);
  // The menu grows out of the point that was right-clicked (pop-origin.ts).
  const at = useRef<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopOrigin(menuRef, () => at.current, menu);
  return (
    <li className={`run-row ${run.status}`} onContextMenu={(e) => { e.preventDefault(); at.current = { x: e.clientX, y: e.clientY }; setMenu(true); }}>
      <span className="run-status">{STATUS[run.status]}</span>
      <span className="run-time">{when(run.startedAt)}</span>
      {run.detail && <span className="run-detail">{run.detail}</span>}
      {menu && (
        <div ref={menuRef} role="menu" className="menu" onMouseLeave={() => setMenu(false)}>
          <button type="button" role="menuitem" onClick={() => { copy(run.requestId); setMenu(false); }}>{STR.copyRequestId}</button>
        </div>
      )}
    </li>
  );
}

/** RTN-03 routine detail inside the right panel ("<" back). Edits auto-save on blur; delete is immediate. */
export function RoutineDetail({ botId, routineId, onBack }: { botId: string; routineId: string; onBack(): void }) {
  const r = useUi((s) => s.routines[botId]?.find((x) => x.id === routineId));
  const upsert = useUi((s) => s.upsertRoutine);
  const [error, setError] = useState<string | null>(null);
  const [fullKey, setFullKey] = useState<{ key: string; header: string; url: string } | null>(null);
  const [mailbox, setMailbox] = useState(false);
  // Rapid Active clicks: show each flip at once and send the writes one at a time in click order, so N clicks
  // land on the host as N alternating writes (e2e S15: from the last saved value they all sent the same one).
  const [shownEnabled, setShownEnabled] = useState<boolean | null>(null);
  const toggles = useRef({ chain: null as Promise<void> | null, latest: 0 });
  // Hand-testing round: Name / Instruction / When-to-run were uncontrolled (`defaultValue`), while
  // `saveOnBlur` refused to save an emptied field. React therefore never restored the stored value:
  // the box sat there blank while the routine (and the row behind it) still held the old name, and
  // a value the host normalised ("every day at 9" -> "Every day at 9:00 AM") never appeared in the
  // box. Each field now shows its draft while it is being edited and falls back to what the routine
  // actually says the moment the draft is dropped or the host answers.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [whenDraft, setWhenDraft] = useState<string | null>(null);
  useEffect(() => setNameDraft(null), [r?.name]);
  useEffect(() => setPromptDraft(null), [r?.prompt]);
  useEffect(() => setWhenDraft(null), [r?.description]);
  if (!r) return null;
  const ids = { id: botId, routineId };
  const run = async (fn: () => Promise<{ routine: RoutineView } | unknown>) => {
    try {
      setError(null);
      const res = await fn();
      if (res && typeof res === "object" && "routine" in res) upsert((res as { routine: RoutineView }).routine);
    } catch (e) {
      setError(e instanceof GatewayCallError ? e.message : String(e));
    }
  };
  const saveOnBlur = (field: "name" | "prompt" | "schedule", current: string, drop: () => void) => (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value.trim();
    if (!v || v === current) { drop(); return; } // nothing to save: show what the routine says
    void run(() => call("updateAgentAutomation", { ...ids, [field]: v }));
  };
  const enabled = shownEnabled ?? r.enabled;
  const toggleActive = () => {
    const next = !enabled;
    setShownEnabled(next);
    const q = toggles.current;
    const mine = ++q.latest;
    const write = () => run(() => call("setAgentAutomationEnabled", { ...ids, enabled: next }));
    const chain: Promise<void> = (q.chain ? q.chain.then(write) : write()).then(() => {
      if (q.latest !== mine) return;
      q.chain = null;
      setShownEnabled(null); // settled: show what the host saved
    });
    q.chain = chain;
  };
  const listenerPlatform = r.triggerKind === "slack" || r.triggerKind === "github" || r.triggerKind === "linear" || r.triggerKind === "sentry" ? r.triggerKind : null;

  return (
    <aside aria-label="Conversation details" className="panel routine-detail">
      <div className="panel-tools start">
        <button type="button" className="icon-btn" aria-label="Back to details" onClick={onBack}><BackIcon /></button>
        <span className="panel-title">{STR.routines}</span>
      </div>
      <input className="routine-title-input" aria-label="Routine name" value={nameDraft ?? r.name} maxLength={80}
        onChange={(e) => setNameDraft(e.target.value)} onBlur={saveOnBlur("name", r.name, () => setNameDraft(null))} />
      <label className="field-label" htmlFor="routine-prompt">{STR.instruction}</label>
      <textarea id="routine-prompt" aria-label={STR.instruction} value={promptDraft ?? r.prompt} rows={4}
        onChange={(e) => setPromptDraft(e.target.value)} onBlur={saveOnBlur("prompt", r.prompt, () => setPromptDraft(null))} />
      <label className="field-label" htmlFor="routine-when">{STR.whenToRun}</label>
      {r.triggerKind === "schedule" ? (
        <input id="routine-when" aria-label={STR.whenToRun} value={whenDraft ?? r.description} title={r.scheduleRaw ?? undefined}
          onChange={(e) => setWhenDraft(e.target.value)} onBlur={saveOnBlur("schedule", r.description, () => setWhenDraft(null))} />
      ) : (
        <span className="routine-when" id="routine-when">{r.description}</span>
      )}
      {error && <span role="alert" className="form-error">{error}</span>}

      <div className="setting-row">
        <span>{STR.active}</span>
        <button type="button" role="switch" aria-checked={enabled} aria-label={STR.active} className={`switch${enabled ? " on" : ""}`} onClick={toggleActive} />
      </div>
      <button type="button" className="btn-outline" onClick={() => void run(() => call("runAgentAutomationNow", ids))}>{STR.testRun}</button>
      <span className="field-help">{STR.testRunWarning}</span>

      {(r.triggerKind === "webhook" || r.webhook) && (
        <div className="webhook-fields">
          {r.webhook ? (
            <>
              <CopyField label={STR.postTo} value={fullKey?.url ?? r.webhook.url} />
              <CopyField label={STR.webhookKey} value={fullKey?.key ?? r.webhook.keyPreview} />
              <CopyField label={STR.webhookHeader} value={fullKey?.header ?? r.webhook.header} />
              <button type="button" className="link-btn" onClick={() => void run(async () => setFullKey(await call("rotateAutomationWebhookKey", ids)))}>{STR.rotateKey}</button>
            </>
          ) : (
            <span className="field-help">{STR.availableAfterSave}</span>
          )}
          <PublicWebhookRow />
          <WebhookLanRow />
        </div>
      )}
      {listenerPlatform && r.listenerConnected !== true && <ConnectListenerForm botId={botId} platform={listenerPlatform} />}
      {r.triggerKind === "email" && (
        <div className="email-fields">
          {mailbox ? <MailboxForm botId={botId} onDone={() => setMailbox(false)} /> : <button type="button" className="link-btn" onClick={() => setMailbox(true)}>{STR.addMailbox}</button>}
        </div>
      )}

      <div className="field-label">{STR.runHistory}</div>
      {r.runs.length === 0 ? <span className="field-help">{STR.noRunsYet}</span> : <ul className="runs">{r.runs.map((x) => <RunRow key={x.id} run={x} />)}</ul>}
      <span className="field-help">{STR.routineUsageHelp}</span>
      <button type="button" className="danger-btn" onClick={() => void askConfirm({ title: `Delete "${r.name}"?`, verb: STR.deleteVerb }).then((ok) => { if (ok) void run(async () => { await call("deleteAgentAutomation", ids); onBack(); }); })}>
        <TrashIcon /> {STR.deleteRoutine}
      </button>
    </aside>
  );
}
