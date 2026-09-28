import { STR, STRC } from "@synapse/shared";
import { useEffect, useState } from "react";
import { loadDisplays } from "../computer-state";
import { EmptyView } from "./EmptyView";
import { DisplayIcon } from "./Icons";
import type { ScreenAbsence } from "../screen-absence";

/**
 * Bug 36 — the one place that says WHY a Bot's screen area is blank, used by BOTH surfaces that can
 * be blank: the sidebar thumbnail and the full computer view. One component, so the two can never
 * drift into telling the user two different stories about the same fact.
 *
 * The spec (CMP-04 / CMP-06) only covers what the BOT is told when every seat is taken, and the
 * design only drew the connected thumbnail and stage. What a USER sees when a screen isn't there is
 * the three states below, a design decision of ours — see docs/bug-log.md row 36.
 *
 * The rules it follows:
 *   - Three distinct headlines, because the headline is what a user quotes in a bug report.
 *   - Only `unreachable` is an error: it is the only one where something is wrong, and the only one
 *     with an action. `waiting` and `none` are the healthy, common states and read as ordinary.
 *   - `loading` renders nothing — the thumbnail's skeleton page is already the loading state, and
 *     claiming a reason before the host has answered is this very defect in miniature.
 *   - Colour comes from tokens only, so both themes work and theme-literals.test.ts stays green.
 *
 * The thumb variant carries no button: `.screen-thumb` is itself a <button> and cannot hold one.
 * ScreenPreview renders the Retry in its `.screen-hover-actions` sibling, next to the pool's own.
 */
function noteCopy(absence: ScreenAbsence, botName: string): { title: string; help: string; error: boolean } {
  switch (absence.kind) {
    case "loading":
      return { title: "", help: "", error: false };
    case "unreachable":
      return { title: STRC.screenUnreachable, help: STRC.screenUnreachableHelp, error: true };
    case "waiting":
      return { title: STRC.waitingForScreen, help: STRC.waitingForScreenHelp, error: false };
    case "none":
      return { title: STRC.noScreen, help: STRC.noScreenHelp(botName), error: false };
    case "connecting":
      return { title: STRC.connecting, help: "", error: false };
    case "dial-failed":
      return { title: STRC.cantReach, help: STRC.dialFailedHelp, error: true };
    default: {
      const _never: never = absence;
      return _never;
    }
  }
}

/** Seconds since this state began, ticking once a second — for a wait whose end we cannot know. */
function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) { setSecs(0); return; }
    const start = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  return secs;
}

/** UI polish pass: after this long, a wait shows how long it has been (critique brief: > 10 s). */
export const SHOW_ELAPSED_AFTER_S = 10;

/**
 * The Computer stage's own states (UI polish pass): EmptyView's shape — icon, title, at most one line,
 * at most one action. A connection that is still coming up shows how long it has been trying once it
 * passes ten seconds, because a spinner with no end in sight reads as a hang.
 */
function StageNote({ absence, botName, onRetry }: { absence: Exclude<ScreenAbsence, { kind: "loading" }>; botName: string; onRetry?: () => void }) {
  const { title, help, error } = noteCopy(absence, botName);
  const secs = useElapsed(absence.kind === "connecting");
  // A Retry only where retrying is what helps. `waiting` and `none` are answers, not failures; a
  // Retry on them would invite the user to re-ask a question already answered.
  const action = error ? { label: STR.retry, onClick: () => { if (onRetry) onRetry(); else void loadDisplays(); } } : null;
  return (
    <span className={`screen-absence stage${error ? " error" : ""}`}>
      <EmptyView icon={<DisplayIcon size={18} />} title={title} line={help || null} action={action} tone={error ? "error" : "quiet"}>
        {absence.kind === "connecting" && secs > SHOW_ELAPSED_AFTER_S
          ? <span className="empty-view-line elapsed" aria-live="off">{STRC.stillConnecting(secs)}</span>
          : null}
      </EmptyView>
    </span>
  );
}

export function ScreenAbsenceNote({ absence, botName, variant, onRetry }: { absence: ScreenAbsence; botName: string; variant: "thumb" | "stage"; onRetry?: () => void }) {
  if (absence.kind === "loading") return null;
  if (variant === "stage") return <StageNote absence={absence} botName={botName} onRetry={onRetry} />;
  const { title, error } = noteCopy(absence, botName);
  return (
    <span role="status" className={`screen-absence ${variant}${error ? " error" : ""}`}>
      <span className="screen-absence-title">{title}</span>
    </span>
  );
}
