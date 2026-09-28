import { useEffect, useState } from "react";
import { STR } from "@synapse/shared";
import { call } from "../bridge";
import { useComputer } from "../computer-state";
import { teachSessionBotId } from "../reducer";
import { useUi } from "../store";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STR_SAVING = "Saving the recording…";
const STR_LEARNING = "Learning from the recording…";

/** TCH-02: the setup banner, then the recording bar ("● REC m:ss", "<Name> is watching and taking notes", Stop & save / Discard). */
export function TeachBanner({ botId }: { botId: string }) {
  const teach = useUi((s) => s.teach);
  const setupFor = useUi((s) => s.teachSetupFor);
  const name = useUi((s) => s.bots[botId]?.profile.name ?? "");
  const recording = teach.state === "RECORDING" && teach.botId === botId;
  const paused = teach.state === "PAUSED" && teach.botId === botId;
  // FINALIZING/ANALYZING used to render nothing at all: the bar vanished and any failure with it.
  const finishing = teach.botId === botId && (teach.state === "FINALIZING" || teach.state === "ANALYZING");
  const now = useNow(recording);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A setup banner left over from before a recording started would pop open on its own once the
  // recording ended; the moment teach leaves IDLE that pending setup is stale.
  useEffect(() => {
    if (teach.state !== "IDLE" && setupFor === botId) useUi.setState({ teachSetupFor: null });
  }, [teach.state, setupFor, botId]);

  const run = async (cmd: "startTeachRecording" | "stopTeachRecording" | "discardTeachRecording" | "resumeTeachRecording", args: { id: string; goal?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = (await call(cmd, args as never)) as { status: typeof teach };
      useUi.setState({ teach: r.status, teachSetupFor: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (recording) {
    const elapsed = Math.max(0, now - (teach.startedAtMs ?? now));
    return (
      <div className="teach-bar" role="status">
        <span className="teach-rec">{STR.teachRec(elapsed)}</span>
        {/* Bug 47: the host could not start event capture — say so instead of "watching and taking notes". */}
        <span className="teach-watching">{teach.videoOnly ? STR.teachVideoOnly : STR.teachWatching(name)}</span>
        {error ? <span className="teach-error" role="alert">{error}</span> : null}
        <span className="teach-spacer" />
        <button type="button" className="btn-compact btn-compact-primary" disabled={busy} onClick={() => void run("stopTeachRecording", { id: botId })}>{STR.teachStopSave}</button>
        <button type="button" className="btn-compact" disabled={busy} onClick={() => void run("discardTeachRecording", { id: botId })}>{STR.teachDiscard}</button>
      </div>
    );
  }
  if (paused) {
    return (
      <div className="teach-bar" role="status">
        <span className="teach-rec">{STR.teachPaused(teach.elapsedMs)}</span>
        <span className="teach-watching">{STR.teachPausedNote}</span>
        {teach.videoOnly ? <span className="teach-watching">{STR.teachVideoOnly}</span> : null}
        {error ? <span className="teach-error" role="alert">{error}</span> : null}
        <span className="teach-spacer" />
        <button type="button" className="btn-compact btn-compact-primary" disabled={busy} onClick={() => void run("resumeTeachRecording", { id: botId })}>{STR.teachContinue}</button>
        <button type="button" className="btn-compact" disabled={busy} onClick={() => void run("stopTeachRecording", { id: botId })}>{STR.teachStopSave}</button>
        <button type="button" className="btn-compact" disabled={busy} onClick={() => void run("discardTeachRecording", { id: botId })}>{STR.teachDiscard}</button>
      </div>
    );
  }
  if (finishing) {
    return (
      <div className="teach-bar" role="status">
        <span className="teach-watching">{teach.state === "FINALIZING" ? STR_SAVING : STR_LEARNING}</span>
        {error ? <span className="teach-error" role="alert">{error}</span> : null}
      </div>
    );
  }
  if (setupFor !== botId) return null;
  return (
    <div className="teach-banner" role="region" aria-label={STR.teachTask}>
      <p className="teach-banner-text">{STR.teachBanner}</p>
      <textarea className="teach-goal" aria-label="The result you want" placeholder="e.g. File an expense report from the receipt in my inbox" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
      <p className="teach-warning">{STR.teachNoSecrets}</p>
      {error ? <p className="teach-error" role="alert">{error}</p> : null}
      <div className="teach-actions">
        <button type="button" className="btn-compact" onClick={() => useUi.setState({ teachSetupFor: null })}>{STR.cancel}</button>
        <button type="button" className="btn-compact btn-compact-primary" disabled={busy || !goal.trim()} onClick={() => void run("startTeachRecording", { id: botId, goal: goal.trim() })}>Start recording</button>
      </div>
    </div>
  );
}

/**
 * WHICH SURFACE SHOWS THE TEACH UI, AND FOR WHICH BOT — the fix for bug 42, and for its class:
 * a control that mutates state owned by a surface it does not belong to.
 *
 * `TeachPill` sets `teachSetupFor` from three places (the computer view's title bar, the screen
 * preview's hover row, the composer's + menu) and `TeachBanner` — the form that reads it — was
 * mounted only in `ChatView`. Two of the three entry points sit on the chat, so they worked. The
 * third does not: `.computer-view` is `position: fixed; inset: 0; z-index: 40` over an OPAQUE
 * `var(--bg)`, and App.tsx raises it over a still-mounted ChatView, so the form rendered perfectly,
 * behind a full-window cover. The button looked dead, and because `startTeachRecording` was never
 * reached, so did the whole feature (bug 5).
 *
 * Rather than mount a second banner and hope the two never collide, this is the ONE place that
 * answers the question, and both surfaces ask it:
 *
 *  - OWNERSHIP. The computer view is a full-window cover, so while it is up it is the only surface
 *    a user can see and it owns the teach UI; the chat owns it the rest of the time. Exactly one
 *    surface renders, so there is never a duplicate form or a second `role="status"` bar.
 *  - SUBJECT. A pending setup belongs to one Bot (the pill's own), but a live recording does not —
 *    TCH-01 allows one app-wide — so the bar and its Stop & save follow the user onto whatever
 *    surface is on top instead of staying in the chat it was started from.
 *  - NO ORPHANS. A pending setup the visible surface cannot show is stale, exactly as a pending
 *    setup is stale once a recording has started (the effect inside TeachBanner). Leaving the
 *    computer view, or switching it to another Bot's screen, drops it instead of leaving a banner
 *    to pop open unbidden in that Bot's chat later.
 *
 * TeachBanner itself is untouched: it still owns the form, `call()` over `callQuiet`, the local
 * error, and the timer.
 */
export function TeachSurface({ surface, botId }: { surface: "chat" | "computer"; botId: string }) {
  const covered = useComputer((s) => s.open !== null);
  const mine = surface === "computer" ? covered : !covered;
  const sessionBotId = useUi(teachSessionBotId);
  const setupFor = useUi((s) => s.teachSetupFor);
  const idle = useUi((s) => s.teach.state === "IDLE");
  useEffect(() => {
    if (mine && idle && setupFor !== null && setupFor !== botId) useUi.setState({ teachSetupFor: null });
  }, [mine, idle, setupFor, botId]);
  if (!mine) return null;
  return <TeachBanner botId={sessionBotId ?? botId} />;
}

/** The red frame over the Bot's screen while it records (TCH-02). */
export function RecordingFrame({ botId }: { botId: string }) {
  const on = useUi((s) => s.teach.state === "RECORDING" && s.teach.botId === botId);
  return on ? <div className="teach-frame" data-testid="teach-frame" aria-hidden="true" /> : null;
}
