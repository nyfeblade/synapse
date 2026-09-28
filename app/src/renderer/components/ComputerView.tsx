import { LIMITSC, STR, STRC, computerTitle, type BoxHelpView, type TranscriptEntry } from "@synapse/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { call } from "../bridge";
import { useComputer } from "../computer-state";
import { useUi } from "../store";
import { createRfb, type RfbLike } from "../vnc/rfb";
import { ctrlChord, isMacChord } from "../vnc/keys";
import { useScreenAbsence } from "../screen-absence";
import { CursorOverlay } from "./CursorOverlay";
import { focusables, useOverlayLayer } from "./Dialog";
import { ScreenAbsenceNote } from "./ScreenAbsenceNote";
import { RecordingFrame, TeachSurface } from "./TeachBanner";
import { TeachPill } from "./TeachPill";
import { ShapeAvatar } from "./ShapeAvatar";
import { ExitFullscreenIcon } from "./Icons";

function useDocumentHidden(): boolean {
  const read = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const [hidden, setHidden] = useState(read);
  useEffect(() => {
    const on = () => setHidden(read());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

export function pendingBoxHelp(entries: TranscriptEntry[]): BoxHelpView | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "send-message" && e.message.type === "box-help") return e.message.request.status === "pending" ? e.message.request : null;
  }
  return null;
}

/** CMP-09 / CMP-18: full-window view of a Bot's screen inside the app; interactive only while the user is in control. */
export function ComputerView() {
  const open = useComputer((s) => s.open);
  const displays = useComputer((s) => s.displays);
  const close = useComputer((s) => s.closeComputer);
  const botId = open?.botId ?? "";
  const bot = useUi((s) => s.bots[botId]);
  const help = useUi((s) => pendingBoxHelp(s.transcripts[botId] ?? []));
  const [driving, setDriving] = useState(false);
  const inControl = Boolean(help?.inControl) || driving;
  const view = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbLike | null>(null);
  const [you, setYou] = useState<{ x: number; y: number } | null>(null);
  // This view draws its own frame (no scrim, full window), so it takes the behaviour from
  // useOverlayLayer rather than from <Dialog>: it joins the stack, takes focus, traps Tab and hands
  // focus back. Its old capture-phase keydown handled Escape with NO predicate at all, so a palette
  // opened on top of it closed both with one press.
  //
  // `layer: "page"` (bug 31) is the one way it differs from every other surface. `.computer-view` is
  // `position: fixed; inset: 0` at z-index 40 — it genuinely covers the app, which is what earns it
  // aria-modal, but it is a page-level VIEW that transient surfaces open over, and the shared
  // `.scrim` sits above it at 50. It can also be raised while a modal is already up (Take over on a
  // box-help card, a display event), and pushing last used to make it the top of the stack: it then
  // owned Escape and pulled focus into its title bar behind the Settings scrim. Page-level keeps it
  // in the one ordering decision without letting it sort above something painted on top of it.
  const panel = useRef<HTMLDivElement>(null);
  const releaseHintId = useId();
  const inControlRef = useRef(inControl);
  inControlRef.current = inControl;
  useOverlayLayer({
    active: !!open,
    onClose: close,
    panelRef: panel,
    layer: "page",
    // Bug 32: while the user is driving the remote, Tab inside `.cv-canvas` is the remote's Tab.
    // ⌘Esc or F6 (below, advertised in the in-control bar) returns focus to the title bar, where the trap resumes. Free design — both
    // "always trap" and "never trap while in control" were worse (WCAG 2.4.11 / remote unusable).
    passTab: () => {
      const a = document.activeElement;
      if (inControlRef.current && a instanceof HTMLElement && view.current?.contains(a)) return false;
      return true;
    },
  });
  useEffect(() => { setDriving(false); }, [botId, open]);
  const screens = Object.values(displays).filter((d) => d.running).sort((a, b) => a.index - b.index);

  const hasScreen = Boolean(displays[botId]);
  // Bug 36: the stage used to be an empty grey rectangle whenever this Bot had no screen, whatever
  // the reason — a failed getDisplays, a host with no display for it, or a seat it is queued for.
  const absence = useScreenAbsence(botId);
  // Bug 38: a display the host assigned is not a live picture. Same connect / disconnect / 15s
  // timeout as vnc/pool.ts; the stage reused ScreenAbsenceNote so the two surfaces cannot drift.
  const [dial, setDial] = useState<"idle" | "connecting" | "connected" | "failed">("idle");
  const [dialGen, setDialGen] = useState(0);
  // Headless: while the window is hidden (minimized, hidden, fully covered) and the user is only watching,
  // nothing streams: the box stops encoding for this view and the Bot's idle screen can be reclaimed.
  // In control, the Bot is paused on the user, so the connection stays.
  const pageHidden = useDocumentHidden();
  const paused = pageHidden && !inControl;
  useEffect(() => {
    // Only a Bot the host gave a screen: any other /vnc dial is refused (404 → the proxy's 502, console errors).
    const url = botId && hasScreen && !paused ? window.synapse.vncUrl(botId) : null;
    if (!view.current || !url) {
      setDial("idle");
      return;
    }
    let cancelled = false;
    let status: "connecting" | "connected" | "failed" = "connecting";
    setDial("connecting");
    const rfb = createRfb(view.current, url);
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.focusOnClick = true;
    rfb.viewOnly = !inControl;
    const finishFailed = () => {
      if (cancelled || status === "failed") return;
      status = "failed";
      setDial("failed");
    };
    const timer = setTimeout(() => {
      if (status === "connecting") {
        rfb.disconnect();
        finishFailed();
      }
    }, LIMITSC.previewStatusTimeoutMs);
    const onConnect = () => {
      if (cancelled) return;
      clearTimeout(timer);
      status = "connected";
      setDial("connected");
    };
    const onDisconnect = () => {
      clearTimeout(timer);
      finishFailed();
    };
    const onClip = (e: CustomEvent) => void navigator.clipboard?.writeText((e.detail as { text: string }).text).catch(() => {});
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    rfb.addEventListener("clipboard", onClip);
    rfbRef.current = rfb;
    return () => {
      cancelled = true;
      clearTimeout(timer);
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.removeEventListener("clipboard", onClip);
      rfb.disconnect();
      rfbRef.current = null;
    };
  }, [botId, hasScreen, dialGen, paused]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !inControl;
    if (!inControl) return;
    let last = "";
    const t = setInterval(() => {
      void navigator.clipboard?.readText().then((txt) => { if (txt && txt !== last) { last = txt; rfbRef.current?.clipboardPasteFrom(txt); } }).catch(() => {});
    }, LIMITSC.clipboardPollMs);
    const onUnload = () => { if (help) void call("handBackForeverBox", { id: botId, requestId: help.id, outcome: "viewer_closed" }); };
    window.addEventListener("beforeunload", onUnload);
    return () => { clearInterval(t); window.removeEventListener("beforeunload", onUnload); };
  }, [inControl, botId, help]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const letter = isMacChord(e);
      if (letter && inControl && rfbRef.current) { e.preventDefault(); ctrlChord(rfbRef.current, letter); return; }
      // Bug 32: the way out of the remote. ⌘Esc is the advertised key (the in-control bar says so);
      // F6 is the platform's next-pane key and does the same. Both are stopped HERE, in the capture
      // phase: noVNC listens on the canvas, and a release key that is also typed on the Bot's Mac is
      // not a release. preventDefault also keeps ⌘Esc from reaching the overlay stack's Escape.
      if (e.key === "F6" || (e.key === "Escape" && e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        const bar = panel.current?.querySelector(".cv-titlebar");
        if (bar instanceof HTMLElement) (focusables(bar)[0] ?? bar).focus();
        return;
      }
      if (!inControl && (e.key === "ArrowRight" || e.key === "ArrowLeft") && screens.length > 1) {
        const i = screens.findIndex((d) => d.botId === botId);
        const next = screens[(i + (e.key === "ArrowRight" ? 1 : screens.length - 1)) % screens.length]!;
        useComputer.getState().openComputer(next.botId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inControl, botId, screens, open, close]);

  if (!open || !bot) return null;
  const shownAbsence = absence ?? (dial === "connecting" ? { kind: "connecting" as const } : dial === "failed" ? { kind: "dial-failed" as const } : null);
  const takeOver = () => {
    if (help) void call("setTakeoverActive", { id: botId, requestId: help.id, active: true });
    else setDriving(true);
  };
  const done = async () => {
    if (help) {
      await call("handBackForeverBox", { id: botId, requestId: help.id, outcome: "done" });
      close();
      return;
    }
    setDriving(false);
  };
  const shown = screens.slice(0, LIMITSC.monitorsShown);
  const more = screens.slice(LIMITSC.monitorsShown);

  return (
    <div ref={panel} role="dialog" aria-modal="true" aria-label={computerTitle()} tabIndex={-1} className="computer-view">
      <div className="cv-titlebar">
        <span className="cv-dots" aria-hidden="true"><span /><span /><span /></span>
        <span className="cv-title">
          <ShapeAvatar shape={bot.profile.avatarShape} color={bot.profile.avatarColor} size={18} />
          <span className="cv-name">{bot.profile.name}</span>
          <span className="cv-sub">{hasScreen ? STRC.inUse : STRC.idle}</span>
        </span>
        <span className="cv-monitors" role="group" aria-label="Screens">
          {shown.map((d) => <button key={d.botId} type="button" className={`cv-monitor${d.botId === botId ? " current" : ""}`} aria-pressed={d.botId === botId} onClick={() => useComputer.getState().openComputer(d.botId)}>:{d.index}</button>)}
          {more.length > 0 && (
            <select aria-label={STRC.moreScreens} value="" onChange={(e) => e.target.value && useComputer.getState().openComputer(e.target.value)}>
              <option value="">{STRC.moreScreens}</option>
              {more.map((d) => <option key={d.botId} value={d.botId}>:{d.index}</option>)}
            </select>
          )}
        </span>
        <TeachPill botId={botId} />
        <button type="button" className="icon-btn" aria-label={STRC.exitFullscreen} onClick={close}>
          <ExitFullscreenIcon />
        </button>
      </div>
      {/* TCH-02 on the surface the user is demonstrating on (bug 42). It sits BELOW the title bar and
          ABOVE the stage, in the same chrome as the pill that opens it: a strip floating over the
          stage would cover the very screen the user is being asked to work on, and the red
          .teach-frame already marks the stage itself. `.cv-teach:empty` collapses when idle. */}
      <div className="cv-teach"><TeachSurface surface="computer" botId={botId} /></div>
      <div className="cv-stage">
        <div
          className={`cv-viewport${inControl ? " in-control" : ""}`}
          role="application" aria-label={STR.screenCaption(bot.profile.name)}
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setYou({ x: e.clientX - r.left, y: e.clientY - r.top }); }}
          onMouseLeave={() => setYou(null)}
        >
          <div ref={view} className="cv-canvas" tabIndex={inControl ? 0 : -1} aria-describedby={inControl && hasScreen ? releaseHintId : undefined} />
          {shownAbsence && (
            <ScreenAbsenceNote
              absence={shownAbsence}
              botName={bot.profile.name}
              variant="stage"
              onRetry={shownAbsence.kind === "dial-failed" ? () => setDialGen((g) => g + 1) : undefined}
            />
          )}
          <CursorOverlay botId={botId} label={bot.profile.name} scale={1} />
          <RecordingFrame botId={botId} />
          {inControl && you && <span className="you-label" style={{ left: you.x, top: you.y }} aria-hidden="true">{STRC.you}</span>}
          {hasScreen && (
            <div role="status" className="cv-status">
              {inControl ? (
                <>
                  <span className="control-pill"><span className="dot" />{STRC.youreInControl}</span>
                  {help && <span className="cv-status-text">{STRC.pausedUntilHandBack(bot.profile.name)}</span>}
                  {/* Bug 32: Tab belongs to the remote now, so the way back to these controls is stated. */}
                  <span id={releaseHintId} className="cv-status-text cv-leave-hint"><kbd>⌘</kbd><kbd>Esc</kbd> {STRC.releaseKeyboard}</span>
                  <button type="button" className="btn-primary" onClick={() => void done()}>{STRC.imDone}</button>
                </>
              ) : (
                <>
                  {help && <span className="cv-status-text">{help.instruction}</span>}
                  <button type="button" className="btn-primary" onClick={takeOver}>{STRC.takeOver}</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
