import { STR, STRC } from "@synapse/shared";
import { useEffect, useRef, useState } from "react";
import { loadDisplays, useComputer } from "../computer-state";
import { useScreenAbsence } from "../screen-absence";
import { screenPool, type ScreenStatus } from "../vnc/pool";
import { CursorOverlay } from "./CursorOverlay";
import { RecordingFrame } from "./TeachBanner";
import { ScreenAbsenceNote } from "./ScreenAbsenceNote";
import { TeachPill } from "./TeachPill";

/** S14 / CMP-06 (2): view-only live thumbnail; pointer events off; click opens the computer view. */
export function ScreenPreview({ botId, name }: { botId: string; name: string }) {
  const slot = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<ScreenStatus>("connecting");
  const openComputer = useComputer((s) => s.openComputer);
  const hasScreen = useComputer((s) => Boolean(s.displays[botId]));
  // Bug 36: WHY this Bot has no screen — a failed getDisplays, a host that has none for it, or a
  // seat it is queued for (MAX_SCREENS). The pool's own "unavailable" could only ever say "blank".
  const absence = useScreenAbsence(botId);
  useEffect(() => {
    const { el, status: st } = screenPool.acquire(botId);
    setStatus(st);
    slot.current?.appendChild(el);
    const off = screenPool.subscribe(botId, setStatus);
    return () => {
      off();
      el.remove();
      screenPool.release(botId);
    }; // stays warm in the pool (CMP-07) for LIMITSC.previewWarmIdleMs, then closes (headless)
  }, [botId, hasScreen]); // a screen the host just gave this Bot: acquire() connects the unavailable preview
  // acquire() re-dials a screen that is "failed" or "unavailable"; the effect above only re-runs when the Bot or
  // its screen changes, so a preview that timed out (15 s) or crashed out had nothing left that would retry.
  const retry = () => {
    const { el, status: st } = screenPool.acquire(botId);
    screenPool.release(botId); // the mount still holds its own claim; this one only redials
    if (slot.current && el.parentElement !== slot.current) slot.current.appendChild(el);
    setStatus(st);
  };
  // Every non-connected state used to render the same decorative page, which reads as a real document
  // thumbnail — a Bot with no screen, and one whose connection failed, both looked live.
  //
  // The skeleton is the LOADING state and nothing else: while the host has not answered yet, and
  // while a dial is in flight. An absence we can name gets the note instead (bug 36).
  const dialing = status === "connecting" && (!absence || absence.kind === "loading");
  // A dial that failed against a screen the host says exists is a fourth, different thing from the
  // three absences: the host gave this Bot a screen and the connection did not come up.
  const dialFailed = status === "failed" && !absence;
  const canRetryFetch = absence?.kind === "unreachable";
  return (
    <>
      <button type="button" aria-label={STRC.openComputer} className="screen-thumb" onClick={() => openComputer(botId)}>
        <span ref={slot} className={`screen-slot${status === "connected" ? " live" : ""}`} />
        {status !== "connected" && (
          <>
            {dialing && (
              <>
                <span className="screen-page">
                  <span style={{ width: "60%" }} />
                  <span style={{ width: "85%" }} />
                  <span style={{ width: "75%" }} />
                  <span style={{ width: "80%" }} />
                </span>
                <span className="screen-bar" />
              </>
            )}
            {absence && <ScreenAbsenceNote absence={absence} botName={name} variant="thumb" />}
            {dialFailed && <span role="status" className="screen-absence thumb error"><span className="screen-absence-title">{STRC.previewFailed}</span></span>}
          </>
        )}
        {status === "connected" && <CursorOverlay botId={botId} label={name} scale={256 / 1280} />}
        <RecordingFrame botId={botId} />
      </button>
      {/* TCH-01 "screen hover" entry point; a sibling of the thumb because a button can't hold a button.
          `shown` pins the row open when it holds a Retry the user needs: a failure the user has to
          hover to discover is barely better than one that says nothing at all (bug 36). */}
      <span className={`screen-hover-actions${dialFailed || canRetryFetch ? " shown" : ""}`}>
        {dialFailed && <button type="button" className="link-btn" onClick={retry}>{STR.retry}</button>}
        {canRetryFetch && <button type="button" className="link-btn" onClick={() => void loadDisplays()}>{STR.retry}</button>}
        <TeachPill botId={botId} />
      </span>
      <span className="screen-caption">{STR.screenCaption(name)}</span>
    </>
  );
}
