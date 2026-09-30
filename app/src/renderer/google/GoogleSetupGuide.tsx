import { useEffect, useMemo, useState } from "react";
import { useKeyedState } from "../async-resource";
import { GOOGLE_SETUP_GUIDE, STRB, STRG, STRGS, googleConsoleUrl, isGoogleProjectId, type GoogleSetupMode, type GoogleSetupStep, type GoogleSetupStepId } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { LocalPermissionRow, LOCAL_PERMISSION_CHANGED } from "../components/LocalPermissionRow";
import { nativeCall } from "../native";
import { useUi } from "../store";
import { useGoogle } from "./store";

export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="copy-field" aria-label={`${STRG.copy} ${label}`} title={value}
      onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      <span className="copy-label">{label}</span><span className="copy-value">{value}</span><span className="muted">{copied ? STRG.copied : STRG.copy}</span>
    </button>
  );
}

/** What the app can see for itself: the client is saved, the account is connected. Those checks aren't user ticks. */
function verified(id: GoogleSetupStepId, s: ReturnType<typeof useGoogle.getState>["status"]): boolean | null {
  if (id === "client") return s?.clientId || s?.setupTask?.clientSaved ? true : null;
  if (id === "connect") return s?.state === "connected";
  return null;
}

function Step({ step, n, children }: { step: GoogleSetupStep; n: number; children?: React.ReactNode }) {
  const { status, checks, tick, projectId } = useGoogle();
  const auto = verified(step.id, status);
  const done = auto ?? checks[step.id] === true;
  return (
    <li className={`google-step${done ? " done" : ""}`} data-step={step.id}>
      <div className="google-step-head">
        <input type="checkbox" aria-label={step.title} checked={done} disabled={auto !== null}
          onChange={(e) => tick(step.id, e.target.checked)} />
        <span className="google-step-n" aria-hidden="true">{n}</span>
        <span className="google-step-title">{step.title}</span>
        {step.links.map((l) => (
          <button key={l.path} type="button" className="btn-outline small" aria-label={`${l.label === STRGS.openInBrowser ? STRGS.openInBrowser : `${STRGS.openInBrowser}: ${l.label}`} (${step.title})`}
            onClick={() => void nativeCall("openExternal", { url: googleConsoleUrl(l.path, projectId) })}>{l.label}</button>
        ))}
      </div>
      {(step.copies.length > 0 || children) && (
        <div className="google-step-body">
          {step.copies.map((c) => <CopyRow key={c.label} label={c.label} value={c.value} />)}
          {children}
        </div>
      )}
    </li>
  );
}

/** Settings → Connected accounts → Google → Set up: six steps, each with its console page, Copy buttons and a check. */
export function GoogleSetupSteps({ connectFields }: { connectFields: React.ReactNode }) {
  const { projectId, setProjectId } = useGoogle();
  const bad = projectId.trim() !== "" && !isGoogleProjectId(projectId.trim());
  return (
    <ol aria-label="Setup steps" className="google-steps">
      {GOOGLE_SETUP_GUIDE.map((s, i) => (
        <Step key={s.id} step={s} n={i + 1}>
          {s.id === "project" && (
            <div className="field google-project">
              <label htmlFor="google-project-id">{STRGS.projectId}</label>
              <input id="google-project-id" type="text" autoComplete="off" spellCheck={false} value={projectId} placeholder="synapse-123456"
                aria-invalid={bad} onChange={(e) => setProjectId(e.target.value)} />
            </div>
          )}
          {s.id === "connect" && connectFields}
        </Step>
      ))}
    </ol>
  );
}

/** Whether each Bot may use the browser on this Mac (asked of the coordinator; null = couldn't tell). */
function useBrowserAllowed(ids: string[]): [Record<string, boolean | null>, (id: string, on: boolean) => void] {
  const key = ids.join(",");
  // Keyed by the Bot list, so a stale answer for an earlier list never shows (bug #19 guard).
  const [allowed, setAllowed] = useKeyedState<Record<string, boolean | null>>(key, {});
  useEffect(() => {
    let live = true;
    const read = () => void Promise.all(ids.map((id) => (callQuiet("getLocalBrowserAllowed", { id }) as Promise<{ allowed?: unknown }>)
      .then((r) => [id, r?.allowed === true] as const, () => [id, null] as const)))
      .then((rows) => { if (live) setAllowed(Object.fromEntries(rows)); });
    read();
    window.addEventListener(LOCAL_PERMISSION_CHANGED, read);
    return () => { live = false; window.removeEventListener(LOCAL_PERMISSION_CHANGED, read); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [allowed, (id, on) => setAllowed((a) => ({ ...a, [id]: on }))];
}

/** "Let a Bot do it" / "Let a Bot click through": pick a Bot with the Mac browser, start, watch, stop. */
export function GoogleBotPanel({ mode }: { mode: GoogleSetupMode }) {
  const { status, busy, startTask, stopTask, close } = useGoogle();
  const botsMap = useUi((s) => s.bots);
  const openBot = useUi((s) => s.openBot);
  const bots = useMemo(() => Object.values(botsMap).filter((b) => !b.group), [botsMap]);
  const [allowed, setAllowed] = useBrowserAllowed(bots.map((b) => b.id));
  const firstAllowed = bots.find((b) => allowed[b.id] === true)?.id;
  const [picked, setPicked] = useState<string | null>(null);
  const botId = picked ?? firstAllowed ?? bots[0]?.id ?? null;
  const task = status?.setupTask ?? null;

  if (task) {
    return (
      <section className="settings-card google-bot" aria-label={STRGS.letABot}>
        <div className="settings-row">
          <span className="grow">{STRGS.working(task.botName)}</span>
          <button type="button" className="link-btn" onClick={() => { close(); void openBot(task.botId); }}>{STRGS.openChat}</button>
          <button type="button" className="btn-outline small" onClick={() => void stopTask()}>{STRGS.cancel}</button>
        </div>
        {task.clientSaved && <div className="settings-row"><span className="muted">{STRGS.clientSaved}</span></div>}
      </section>
    );
  }
  if (!bots.length) return <p className="muted">{STRGS.noBots}</p>;
  const name = bots.find((b) => b.id === botId)?.profile.name ?? "";
  const ready = !!botId && allowed[botId] === true;
  return (
    <section className="settings-card google-bot" aria-label={mode === "reconnect" ? STRGS.letABotClick : STRGS.letABot}>
      <div className="settings-row">
        <label htmlFor="google-bot" className="grow">{STRGS.bot}</label>
        <select id="google-bot" className="select" value={botId ?? ""} onChange={(e) => setPicked(e.target.value)}>
          {bots.map((b) => <option key={b.id} value={b.id}>{b.profile.name}</option>)}
        </select>
        <button type="button" className="btn-primary" disabled={!ready || busy} onClick={() => botId && void startTask(botId, mode)}>{STRGS.start}</button>
      </div>
      {botId && allowed[botId] === false && (
        <LocalPermissionRow botId={botId} get="getLocalBrowserAllowed" set="setLocalBrowserAllowed" setting="google-bot-browser" label={STRGS.browserOff(name)} help={STRB.settingHelp} onSaved={(on) => setAllowed(botId, on)} />
      )}
    </section>
  );
}
