import { STRC, STR_SETUP } from "@synapse/shared";
import { useComputer } from "../computer-state";
import { Announce } from "./Announce";

/** CMP-11 banners: one line per lifecycle step; errors stay until the next operation. */
export function BoxBanner() {
  const lc = useComputer((s) => s.lifecycle);
  // Portable install, fix round 1: while the Mac re-provisions the box, new turns are held (messages queue and
  // are answered after). A quiet line says so, not an alarm.
  const maintenance = useComputer((s) => s.box?.maintenance === true);
  if ((!lc || (lc.phase === "ready" && !lc.error)) && maintenance) {
    return (
      <Announce>
        <div role="status" aria-live="polite" data-announcement="box-maintenance" className="box-banner quiet">{STR_SETUP.boxUpdating}</div>
      </Announce>
    );
  }
  if (!lc || (lc.phase === "ready" && !lc.error)) return null;
  // Bug 46's sibling, same class and same fix: this banner is app-level but `z-index: 50` — the same
  // height as `.scrim` and earlier in the DOM, so an open modal painted over it, and the modal's
  // `aria-modal` hid it from the screen reader its `aria-live` was written for. It goes onto the top
  // surface through the same outlet as the error alert, and stays where it has always been otherwise.
  return (
    <Announce>
      <div role="status" aria-live="polite" data-announcement="box-lifecycle" className={`box-banner${lc.error ? " error" : ""}`}>
        {lc.error ?? (lc.step ? STRC.step[lc.step] : lc.phase === "updating" ? STRC.updatingComputer : "")}
      </div>
    </Announce>
  );
}
