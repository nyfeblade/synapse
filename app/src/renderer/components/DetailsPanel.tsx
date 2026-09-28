import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { STRC, STRL } from "@synapse/shared";
import { sanitizeExitClone, scheduleExitRemoval } from "../exit-clone";
import { useUi } from "../store";
import { FilesPanel } from "./FilesPanel";
import { PanelTabs } from "./PanelTabs";
import { PlanCard } from "./PlanCard";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { GroupPanel } from "./GroupPanel";
import { MemoryPanel } from "./MemoryPanel";
import { RoutineDetail } from "./RoutineDetail";
import { RoutinesSection } from "./RoutinesSection";
import { ScreenPreview } from "./ScreenPreview";

/**
 * Fix round 1 (docs/sdd, 2026-09-23; controller ruling — "nothing snaps" reaches the panel's exit
 * too). ChatView unmounts `<DetailsPanel>` outright the instant `panel` flips to "closed" (its own
 * gate, `{panel !== "closed" && <DetailsPanel .../>}`, is untouched — the box already snapped there,
 * on purpose, motion-spec §6.4), so there is no component left, by the next tick, to hold a fade. The
 * same clone-on-unmount shape Menus.tsx uses solves it without touching ChatView, or any of the five
 * components (BotSettingsPanel, MemoryPanel, FilesPanel, GroupPanel, RoutineDetail) that actually own
 * the `.panel` root in most of this component's branches: an unmount-only effect clones whatever
 * `.panel` element was showing, the instant before React removes it, and fades the clone instead.
 *
 * The clone is pinned to its last on-screen rect with `position: fixed` — the real flex layout has
 * already reflowed by the time it appears (the box snap), so without this it would render in normal
 * document flow at the bottom of `<body>` instead of fading exactly where the panel used to be.
 *
 * Fix round 2: this branch's content is the one most likely to carry real ids — BotSettingsPanel's
 * `#model-label`/`#effort-label`, RoutineDetail's `#routine-when` — and a clone kept them verbatim.
 * Switching Bots with Settings open remounts a FRESH `BotSettingsPanel` (same ids) right behind the
 * old one's still-fading clone, briefly giving the document two elements sharing an id. `sanitizeExitClone`
 * (shared with Menus.tsx's clone) strips every id and any `for`/`aria-labelledby`/`aria-describedby`/
 * `aria-controls` reference, and sets `inert` as a second, independent guard.
 */
function beginPanelExit(node: HTMLElement | null): void {
  if (!node || !node.isConnected) return;
  const rect = node.getBoundingClientRect();
  const clone = node.cloneNode(true) as HTMLElement;
  clone.classList.add("leaving");
  clone.removeAttribute("aria-label");
  sanitizeExitClone(clone);
  for (const el of clone.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")) {
    el.setAttribute("tabindex", "-1");
    if ("disabled" in el) (el as HTMLButtonElement).disabled = true;
  }
  Object.assign(clone.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: "0" });
  document.body.appendChild(clone);
  scheduleExitRemoval(clone, 160);
}

export function DetailsPanel({ botId }: { botId: string }) {
  const bot = useUi((s) => s.bots[botId]);
  const { panel, routineId, closeRoutine } = useUi();
  // `routineId` belongs to the Bot it was opened from; switching Bots left the panel pointing at a routine the
  // new Bot doesn't have, and RoutineDetail rendered nothing at all — an empty right side with no Back, gear or
  // close. A routine this Bot doesn't have is dropped, and the Bot's own details are shown instead.
  const hasRoutine = useUi((s) => (routineId ? Boolean(s.routines[botId]?.some((r) => r.id === routineId)) : false));
  const staleRoutine = panel === "routine" && Boolean(routineId) && !hasRoutine;
  useEffect(() => { if (staleRoutine) closeRoutine(); }, [staleRoutine, closeRoutine]);

  const rootRef = useRef<HTMLDivElement>(null);
  // Unmount-only (empty deps): the cleanup runs once, synchronously, in the same commit that removes
  // this component for real — before the DOM is actually detached, so there is still a `.panel` node
  // connected to clone. `display: contents` on the wrapper (app.css) means it never sits in the flex
  // row itself; the real `.panel` element inside it does, exactly as if this ref did not exist.
  useLayoutEffect(() => () => beginPanelExit(rootRef.current?.querySelector<HTMLElement>(".panel") ?? null), []);

  if (!bot) return null;
  let content: ReactNode;
  if (panel === "routine" && routineId && hasRoutine) content = <RoutineDetail botId={botId} routineId={routineId} onBack={closeRoutine} />;
  else if (bot.group) content = <GroupPanel groupId={botId} />;
  else if (panel === "settings") content = <BotSettingsPanel botId={botId} />;
  else if (panel === "memory") content = <MemoryPanel botId={botId} />;
  else if (panel === "files") content = <FilesPanel botId={botId} />;
  else {
    // Now: what this Bot is doing and what is coming — its computer, the open run, its scheduled work.
    // What it remembers is NOT here: memory has its own tab, one click away, and the user does not want
    // the ledger sitting in the column beside every conversation.
    content = (
      <aside aria-label="Conversation details" className="panel now">
        <PanelTabs current="details" />
        <section className="pcard" aria-label={STRC.computer}>
          <h3 className="pcard-head">{STRL.computer}<span className="pcard-meta">{STRL.computerMeta}</span></h3>
          <div className="pcard-body">
            <ScreenPreview botId={botId} name={bot.profile.name} />
          </div>
        </section>
        <PlanCard botId={botId} />
        <section className="pcard" aria-label={STRL.scheduled}>
          <h3 className="pcard-head">{STRL.scheduled}</h3>
          <div className="pcard-body">
            <RoutinesSection botId={botId} />
          </div>
        </section>
      </aside>
    );
  }
  return <div ref={rootRef} className="panel-mount">{content}</div>;
}
