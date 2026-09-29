import { useCallback, useEffect, useRef, useState } from "react";
import { GITHUB_TOKEN_URL, STR_SETUP, setupView, type BoxReport, type OrbReport, type SetupStepState } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { nativeCall, onNative } from "../native";
import { useUi } from "../store";
import { AccountPanel } from "../components/settings/AccountSection";
import { Announce } from "../components/Announce";
import { useSetupGate } from "./store";

/**
 * Portable install: the first-run setup screen. OrbStack → the Bots' computer → the Anthropic API key are required; voices,
 * phone access and GitHub updates are optional. Each step says where it is (done / working / needs you),
 * the Bots' computer shows a real progress bar and a log, and everything resumes after a failure or a relaunch.
 * Titles and labels only.
 */
interface BoxState extends BoxReport { step: string | null; logTail: string[] }
interface Status { done: boolean; machine: string; orb: OrbReport & { version: string | null }; box: BoxState; connected: boolean; mac: { arm64: boolean; freeBytes: number | null } }
interface Pack { id: string; label: string; bytes: number; state: "available" | "installing" | "installed" | "failed"; progress: number; error?: string | null }

const STATE_WORD: Record<SetupStepState, string> = {
  done: STR_SETUP.stepDone, doing: STR_SETUP.stepDoing, "needs-you": STR_SETUP.stepNeedsYou, waiting: STR_SETUP.stepWaiting, optional: STR_SETUP.stepOptional,
};

function Step({ title, state, children, actions }: { title: string; state: SetupStepState; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <li className="setup-step" data-state={state} aria-label={title}>
      <div className="setup-step-head">
        <span className="setup-dot" aria-hidden="true" />
        <span className="setup-step-title">{title}</span>
        <span className="setup-step-state">{STATE_WORD[state]}</span>
        {actions}
      </div>
      {children && <div className="setup-step-body">{children}</div>}
    </li>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="setup-meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="meter"><span style={{ transform: `scaleX(${pct / 100})` }} /></div>
      <span className="setup-meter-pct">{pct}%</span>
    </div>
  );
}

function ComputerBody({ box, state }: { box: BoxState; state: SetupStepState }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!open) return;
    const pull = () => void nativeCall<string>("setup.box.log").then((l) => { setLog(l); requestAnimationFrame(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }); }).catch(() => {});
    pull();
    const t = setInterval(pull, 1500);
    return () => clearInterval(t);
  }, [open]);
  if (state === "waiting") return null;
  return (
    <>
      {state !== "done" && <Meter value={box.progress} label={STR_SETUP.computer} />}
      {box.error && <Announce><p role="alert" className="error">{box.error}</p></Announce>}
      <div className="setup-row-actions">
        {(box.phase === "failed" || box.phase === "cancelled") && <button type="button" className="btn-primary" onClick={() => void nativeCall("setup.box.start")}>{STR_SETUP.retry}</button>}
        {box.phase === "running" && <button type="button" className="btn-outline small" onClick={() => void nativeCall("setup.box.cancel")}>{STR_SETUP.stop}</button>}
        {box.phase !== "idle" && <button type="button" className="btn-outline small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? STR_SETUP.hideLog : STR_SETUP.log}</button>}
      </div>
      {open && <pre ref={pre} className="terminal setup-log" aria-label={STR_SETUP.log}>{log || box.logTail.join("\n")}</pre>}
    </>
  );
}

function VoicesBody() {
  const [kokoro, setKokoro] = useState<"ready" | "missing" | "checking">("checking");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [whisper, setWhisper] = useState<{ state: string; size: string } | null>(null);
  const [whisperBar, setWhisperBar] = useState<number | null>(null);
  useEffect(() => {
    void nativeCall<{ state: "ready" | "missing" | "checking" }>("kokoro.status").then((s) => setKokoro(s.state)).catch(() => setKokoro("missing"));
    void nativeCall<Pack[]>("voicePacks.list").then(setPacks).catch(() => setPacks([]));
    const refreshWhisper = () => void nativeCall<{ state: string; size: string }>("whisper.status.get").then(setWhisper).catch(() => setWhisper(null));
    refreshWhisper();
    const offPacks = onNative<Pack[]>("voice-packs", setPacks);
    const offWhisper = onNative<{ state: string; received?: number; total?: number }>("whisper", (p) => {
      if (p.state === "downloading" && p.total) setWhisperBar((p.received ?? 0) / p.total);
      else { setWhisperBar(null); refreshWhisper(); }
    });
    return () => { offPacks(); offWhisper(); };
  }, []);
  return (
    <div className="settings-card">
      <div className="settings-row"><span className="grow">{STR_SETUP.kokoro}</span><span className="muted">{kokoro === "ready" ? STR_SETUP.kokoroReady : kokoro === "missing" ? STR_SETUP.kokoroMissing : STR_SETUP.stepDoing}</span></div>
      {packs.map((p) => (
        <div className="settings-row" key={p.id}>
          <span className="grow">{p.label}</span>
          {p.state === "installed" && <span className="muted">{STR_SETUP.installed}</span>}
          {p.state === "installing" && <Meter value={p.progress} label={p.label} />}
          {(p.state === "available" || p.state === "failed") && <span className="muted">{STR_SETUP.size(p.bytes)}</span>}
          {(p.state === "available" || p.state === "failed") && <button type="button" className="btn-outline small" aria-label={`${p.state === "failed" ? STR_SETUP.retry : STR_SETUP.download} ${p.label}`} onClick={() => void nativeCall("voicePacks.install", { id: p.id })}>{p.state === "failed" ? STR_SETUP.retry : STR_SETUP.download}</button>}
          {p.state === "failed" && p.error && <Announce><span role="alert" className="error small">{p.error}</span></Announce>}
        </div>
      ))}
      {whisper && whisper.state !== "no-build" && (
        <div className="settings-row">
          <span className="grow">{STR_SETUP.whisper}</span>
          {whisper.state === "ready" ? <span className="muted">{STR_SETUP.installed}</span>
            : whisperBar !== null ? <Meter value={whisperBar} label={STR_SETUP.whisper} />
              : <><span className="muted">{STR_SETUP.size(574_041_195)}</span><button type="button" className="btn-outline small" aria-label={`${STR_SETUP.download} ${STR_SETUP.whisper}`} onClick={() => { setWhisperBar(0); void nativeCall("whisper.model.download"); }}>{STR_SETUP.download}</button></>}
        </div>
      )}
    </div>
  );
}

function UpdatesBody() {
  const [feed, setFeed] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void nativeCall<{ feed: string | null; hasToken: boolean }>("updates.source").then((s) => { setFeed(s.feed ?? ""); setHasToken(s.hasToken); }).catch(() => {}); }, []);
  const save = async () => {
    setMsg(null);
    try {
      await nativeCall("updates.setSource", { feed: feed.trim(), ...(token ? { token } : {}) });
      if (token) setHasToken(true);
      setToken("");
      setMsg(STR_SETUP.saved);
    } catch (e) { setMsg((e as Error).message); }
  };
  return <UpdatesFields feed={feed} setFeed={(v) => { setFeed(v); setMsg(null); }} token={token} setToken={(v) => { setToken(v); setMsg(null); }} hasToken={hasToken} msg={msg} save={save} idPrefix="setup" />;
}

/** The "Updates from GitHub" fields, shared with Settings → Updates. */
export function UpdatesFields(p: { feed: string; setFeed(v: string): void; token: string; setToken(v: string): void; hasToken: boolean; msg: string | null; save(): void; idPrefix: string }) {
  return (
    <div className="settings-card setup-updates">
      <div className="settings-row column">
        <label htmlFor={`${p.idPrefix}-feed`}>{STR_SETUP.updates}</label>
        <input id={`${p.idPrefix}-feed`} className="text-input" placeholder="owner/repo" value={p.feed} onChange={(e) => p.setFeed(e.target.value)} />
        <input id={`${p.idPrefix}-token`} aria-label="Read-only token" type="password" autoComplete="off" className="text-input"
          placeholder={p.hasToken ? STR_SETUP.tokenSaved : "github_pat_…"} value={p.token} onChange={(e) => p.setToken(e.target.value)} />
        <div className="setup-row-actions">
          <a href="#" onClick={(e) => { e.preventDefault(); void nativeCall("openExternal", { url: GITHUB_TOKEN_URL }); }}>{STR_SETUP.createToken}</a>
          <span className="grow" />
          {p.msg && <Announce><span className="muted" role="status">{p.msg}</span></Announce>}
          <button type="button" className="btn-outline small" onClick={p.save}>{STR_SETUP.save}</button>
        </div>
      </div>
    </div>
  );
}

export function SetupScreen({ onClose }: { onClose?(): void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  /** Why the sign-in check failed: the Claude step says so instead of "Working" for good. */
  const [signInError, setSignInError] = useState<string | null>(null);
  const connectedUi = useUi((s) => s.connection.kind === "connected");
  const started = useRef(false);
  const finish = useSetupGate((s) => s.finish);

  const refresh = useCallback(() => void nativeCall<Status>("setup.status").then(setStatus).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    const off = onNative<{ box: BoxState }>("setup", (p) => setStatus((s) => (s ? { ...s, box: p.box } : s)));
    return () => { clearInterval(t); off(); };
  }, [refresh]);

  const connected = connectedUi || !!status?.connected;
  useEffect(() => {
    if (!connected) { setSignedIn(null); setSignInError(null); return; }
    let live = true;
    // callQuiet: a failure is shown in place, under the Claude step (and asked again every 4 s).
    const ask = () => void callQuiet("getOnboarding", {})
      .then((o) => { if (live) { setSignedIn(o.tokenConfigured); setSignInError(null); } })
      .catch((e: unknown) => { if (live) setSignInError(e instanceof Error && e.message ? e.message : String(e)); });
    ask();
    const t = setInterval(ask, 4000);
    return () => { live = false; clearInterval(t); };
  }, [connected]);

  const view = status?.orb && status.box ? setupView({ orb: status.orb, box: status.box, connected, signedIn }) : null;
  useEffect(() => {
    if (view?.startBox && !started.current) {
      started.current = true;
      void nativeCall("setup.box.start").then(refresh);
    }
  }, [view?.startBox, refresh]);

  if (!status || !view) return <main className="onb setup" aria-busy="true"><h1>{STR_SETUP.title}</h1></main>;
  const gb = status.mac.freeBytes !== null ? Math.floor(status.mac.freeBytes / 1e9) : null;
  return (
    <main className="onb setup">
      <h1>{STR_SETUP.title}</h1>
      {!status.mac.arm64 && <Announce><p role="alert" className="error">{STR_SETUP.appleSilicon}</p></Announce>}
      {gb !== null && gb < 8 && view.steps.computer !== "done" && <Announce><p role="alert" className="error">{STR_SETUP.freeSpace(gb)}</p></Announce>}
      <ol className="setup-steps">
        <Step title={STR_SETUP.orbstack} state={view.steps.orbstack} actions={
          view.orbAction === "get" ? <button type="button" className="btn-primary" onClick={() => void nativeCall("setup.orb.download")}>{STR_SETUP.getOrbStack}</button>
            : view.orbAction === "start" ? <button type="button" className="btn-primary" onClick={() => void nativeCall("setup.orb.start").then(refresh)}>{STR_SETUP.startOrbStack}</button> : null
        } />
        <Step title={STR_SETUP.computer} state={view.steps.computer}>
          <ComputerBody box={status.box} state={view.steps.computer} />
        </Step>
        <Step title={STR_SETUP.claude} state={view.steps.claude}>
          {view.steps.claude === "needs-you" && (
            <AccountPanel onReady={() => setSignedIn(true)} />
          )}
          {view.steps.claude === "doing" && signInError && <Announce><p role="alert" className="error">{signInError}</p></Announce>}
        </Step>
        <Step title={STR_SETUP.voices} state="optional"><VoicesBody /></Step>
        <Step title={STR_SETUP.phone} state="optional" actions={
          <button type="button" className="btn-outline small" disabled={!view.complete}
            onClick={() => void finish().then(() => { onClose?.(); useUi.getState().openSettings("voice"); })}>{STR_SETUP.open}</button>
        } />
        <Step title={STR_SETUP.updates} state="optional"><UpdatesBody /></Step>
      </ol>
      <div className="onb-nav">
        {onClose && <button type="button" className="btn-outline" onClick={onClose}>{STR_SETUP.close}</button>}
        {!onClose && <button type="button" className="btn-primary" disabled={!view.complete} onClick={() => void finish()}>{STR_SETUP.finish}</button>}
      </div>
    </main>
  );
}
