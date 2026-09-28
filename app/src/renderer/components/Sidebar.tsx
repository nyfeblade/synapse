import { useRef, useState } from "react";
import { useFlip, useSelectionGlide } from "../flip";
import { loopInView } from "../ambient-pause";
import { STR, STR5, STRL, STRV } from "@synapse/shared";
import { copyConversationId, duplicateBot, hideBot, setUnread } from "../bot-actions";
import { useTemplates } from "../templates/store";
import { useOverlays } from "../overlays";
import { useUi } from "../store";
import { sortedBotIds } from "../reducer";
import { accountMenuItems } from "./account-menu";
import { askConfirm } from "./ConfirmDialog";
import { Announce } from "./Announce";
import { BotAvatar } from "../avatar/BotAvatar";
import { CloseIcon, HeadsetIcon, PlusIcon, SearchIcon } from "./Icons";
import { useUsage } from "../usage/store";
import { useCallPresence } from "../voice/call-presence";
import { botPresence } from "../voice/presence-label";
import { useVoice } from "../voice/VoiceOverlay";

/**
 * Bug 134 (item 9): a call button beside each Bot (shown on hover or focus). A sibling of the row's
 * link (a button can't live inside a link).
 */
function SidebarCallButton({ botId, name }: { botId: string; name: string }) {
  const start = () => { void useUi.getState().openBot(botId).then(() => useVoice.getState().open(botId)); };
  return (
    <button type="button" className="icon-btn row-call" aria-label={STRV.callBot(name)} title={STRV.callBot(name)} onClick={start}>
      <HeadsetIcon />
    </button>
  );
}
import { Menu } from "./Menus";

/** Exported so the bug-43 guard can drive EVERY marker state there is rather than a list of its own. */
export const MARKER_LABEL = { blocked: "Needs attention", unread: "Unread activity", working: "Working" } as const;

/** The account monogram: the first letters of the first and last words ("Alex Rivera" -> "AR"), or the
 *  first two letters of a one-word name. It used to be `slice(0, 2)`, which gave "LU". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = [...words[0]!];
  if (words.length === 1) return first.slice(0, 2).join("").toUpperCase();
  return (first[0]! + [...words[words.length - 1]!][0]!).toUpperCase();
}

/** The week's usage as a ring (Settings → Usage). Drawn only once the host has reported a figure. */
function UsageRing({ pct }: { pct: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, pct));
  return (
    <svg className={`usage-ring${p >= 80 ? " high" : ""}`} width="20" height="20" viewBox="0 0 20 20" role="img" aria-label={STRL.usageRing(p)}>
      <circle className="track" cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" />
      <circle className="fill" cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 10 10)" />
    </svg>
  );
}

export function Sidebar() {
  const { bots, pinned, view, userName, connection, botsLoaded, openBot, openNewChat, setPinned, deleteBot, setPanel, actionError, clearActionError } = useUi();
  const usage = useUsage((s) => s.view);
  const weekLine = usage ? STRL.weekLine(usage.budgetPct) : "";
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [account, setAccount] = useState<{ x: number; y: number } | null>(null);
  const activeId = view.kind === "chat" ? view.botId : null;
  // Bug 134 (item 12): presence from state the app already has — on the live call, working, idle.
  const callChat = useCallPresence((s) => s.chatId);
  const callMembers = useCallPresence((s) => s.members);
  const onCall = (id: string) => callChat === id || callMembers.includes(id);
  // sortedBotIds() derives each id from its own summary's `.id` field, not from the map's keys, so a
  // summary ever stored under a mismatched key (a store bug — see store.ts's openBot/setGroupMembers,
  // fixed in PR #24) would hand back an id `bots[id]` can't resolve. Tolerate that here too, the same
  // way NewChat does: drop ids that don't resolve rather than assert and crash the whole sidebar.
  const isShown = (id: string): boolean => { const b = bots[id]; return b !== undefined && !b.settings.hiddenFromSidebar; };
  const visible = sortedBotIds(bots).filter(isShown);
  // A pinned Bot that was hidden from the sidebar must lose its tile too, or "Hide from sidebar" looks
  // like it did nothing (the tile stays put while the Bot also appears in the Hidden Bots dialog).
  const tiles = pinned.filter(isShown);
  const unpinned = visible.filter((id) => !pinned.includes(id));
  // The look study's two sections: Bots, then Groups. A group chat is a Bot with `group` set.
  const rows = unpinned.filter((id) => !bots[id]?.group);
  const groupRows = unpinned.filter((id) => Boolean(bots[id]?.group));
  // Liquid motion: the selection's fill travels to the Bot just opened, and rows that re-sort (a Bot
  // with news moves to the top) slide to their new places instead of teleporting (renderer/flip.ts).
  const nav = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  useSelectionGlide(nav, '[aria-current="page"]', activeId);
  useFlip(() => rowsRef.current?.children ?? [], rows.join("\n"), { stagger: true }); // a soft, capped cascade
  // `bots` is {} until the first loadAll resolves, so "Create your first Bot" used to greet every
  // launch — over a sidebar whose buttons could not reach the host yet.
  const connected = connection.kind === "connected";
  const hasNoBots = Object.keys(bots).length === 0;
  const showEmptyState = hasNoBots && connected && botsLoaded;
  // One sidebar row: a Bot or a group chat. Its status line is live (on a call / working on … / its
  // last status), and its marker (working, needs attention, unread) is the row's last child.
  const renderRow = (id: string) => {
    const b = bots[id];
    if (!b) return [];
    const pres = botPresence(b, onCall(id));
    return [(
      <div key={id} className="row-wrap">
        <a data-bot={id} href="#" className={id === activeId ? "row active" : "row"} aria-current={id === activeId ? "page" : undefined} data-presence={pres.kind} data-group={b.group ? "" : undefined} title={pres.label}
          onClick={(e) => { e.preventDefault(); void openBot(id); }}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); }}>
          <span className="avatar-wrap">
            <BotAvatar bot={b} size={b.group ? 20 : 28} />
          </span>
          <div className="row-text">
            <span>{b.profile.name}</span>
            <span className="row-status" data-presence={pres.kind}>{pres.kind === "idle" ? b.statusLine || pres.label : pres.label}</span>
          </div>
          {/* Bug 43: LAST, so the row's accessible name begins with its Bot's name in every state — it
              used to read "Needs attention Scout …" and every anchored locator on the name broke the
              moment the row needed attention. `.row > .marker` (app.css) positions it: on the avatar's
              corner for working / needs attention, at the row's right edge for unread. */}
          {b.marker && <span ref={b.marker === "working" ? loopInView : undefined} className={`marker ${b.marker}`} role="img" aria-label={MARKER_LABEL[b.marker]} />}
        </a>
        <SidebarCallButton botId={id} name={b.profile.name} />
      </div>
    )];
  };
  const confirmDelete = (id: string) => {
    const b = bots[id];
    if (!b) return;
    void askConfirm({ title: STR.deleteTitle(b.profile.name), line: STR.deleteLine, verb: STR.deleteVerb }).then((ok) => { if (ok) void deleteBot(id); });
  };

  return (
    <nav ref={nav} className="sidebar" aria-label="Bots">
      <div className="sidebar-top">
        <span className="traffic-space" />
        <span style={{ flexGrow: 1 }} />
      </div>
      <div className="search-row">
        <button type="button" className="search" aria-label={STR.search} aria-keyshortcuts="Meta+K" disabled={!connected} onClick={() => useOverlays.getState().openOverlay("palette")}>
          <SearchIcon />
          <span className="search-placeholder">{STR.search}</span>
          <kbd aria-hidden="true">{STRL.searchKey}</kbd>
        </button>
        <button type="button" className="icon-btn" aria-label="New chat" disabled={!connected} onClick={openNewChat}><PlusIcon /></button>
      </div>
      <div className="side-scroll">
      {hasNoBots ? (
        showEmptyState && (
          <div className="sidebar-empty">
            <button type="button" className="btn-primary" onClick={openNewChat}>{STR5.createFirstBot}</button>
          </div>
        )
      ) : (
        <>
          {tiles.length > 0 && (
            <div role="group" aria-label="Pinned Bots" className="tiles">
              {tiles.flatMap((id) => {
                const b = bots[id];
                if (!b) return [];
                return [(
                  <div key={id} className="tile-wrap">
                  <a data-bot={id} href="#" className={id === activeId ? "tile active" : "tile"} aria-current={id === activeId ? "page" : undefined} data-presence={botPresence(b, onCall(id)).kind} title={botPresence(b, onCall(id)).label}
                    onClick={(e) => { e.preventDefault(); void openBot(id); }}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); }}>
                    <span className="avatar-wrap">
                      <BotAvatar bot={b} size={36} />
                    </span>
                    <span className="tile-name">{b.profile.name}</span>
                    {b.profile.title && <span className="chip">{b.profile.title}</span>}
                    {/* Bug 43: LAST, so the tile's accessible name begins with its Bot's name in every
                        state. `.tile > .marker` puts it back on the avatar's corner (app.css). */}
                    {b.marker && <span ref={b.marker === "working" ? loopInView : undefined} className={`marker ${b.marker}`} role="img" aria-label={MARKER_LABEL[b.marker]} />}
                  </a>
                  <SidebarCallButton botId={id} name={b.profile.name} />
                  </div>
                )];
              })}
            </div>
          )}
          {rows.length > 0 && (
            <div className="side-label"><span>{STRL.bots}</span></div>
          )}
          <div ref={rowsRef} className="rows">
            {rows.flatMap(renderRow)}
          </div>
          {groupRows.length > 0 && (
            <>
              <div className="side-label"><span>{STRL.groups}</span></div>
              <div className="rows">{groupRows.flatMap(renderRow)}</div>
            </>
          )}
        </>
      )}
      {Object.values(bots).some((b) => b.settings.hiddenFromSidebar) && (
        <button type="button" className="row hidden-row" aria-label={STR.hiddenBots} onClick={() => useOverlays.getState().openOverlay("hidden-bots")}>
          <span className="row-text"><span>{STR.hiddenBots}</span></span>
        </button>
      )}
      </div>
      {/* C5 (pre-flight ruling): Marketplace and Private skills ("Your skills") open from the account
          menu now (the smooth pass, Task 2), the Cmd-K palette and Settings. */}
      <button type="button" className="sidebar-foot sidebar-account" aria-label={STR.openAccountMenu} onClick={(e) => setAccount({ x: e.currentTarget.getBoundingClientRect().left + 8, y: e.currentTarget.getBoundingClientRect().top - 8 })}>
        <span className="monogram">{initials(userName)}</span>
        <span className="account-text"><span>{userName}</span>{weekLine && <span className="account-sub">{weekLine}</span>}</span>
        {usage?.budgetPct != null && <UsageRing pct={usage.budgetPct} />}
      </button>
      {menu && (() => {
        // The Bot behind an open context menu can disappear out from under it (a real-time delete
        // from another window, or a host event) while the menu is still up. Close quietly rather than
        // assert past a lookup that's gone stale.
        const b = bots[menu.id];
        if (!b) return null;
        const unread = b.marker === "unread";
        return (
          <Menu label="Bot actions" x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
            { label: pinned.includes(menu.id) ? STR.unpin : STR.pin, onSelect: () => void setPinned(menu.id, !pinned.includes(menu.id)) },
            { label: unread ? STR.markRead : STR.markUnread, onSelect: () => void setUnread(menu.id, !unread) },
            { label: STR.editProfile, onSelect: () => { void openBot(menu.id).then(() => setPanel("settings")); } },
            { label: STR.duplicate, onSelect: () => void duplicateBot(menu.id) },
            { label: STR.copyConversationId, onSelect: () => void copyConversationId(menu.id) },
            { label: STR.shareAsTemplate, onSelect: () => void useTemplates.getState().openExport(menu.id) },
            { label: STR.hideFromSidebar, onSelect: () => void hideBot(menu.id) },
            { label: STR.deleteBot, danger: true, onSelect: () => confirmDelete(menu.id) },
          ]} />
        );
      })()}
      {account && <Menu label="Account" x={account.x} y={account.y} anchor="bottom" onClose={() => setAccount(null)} items={accountMenuItems()} />}
      {/* Bug 46: the app's ONE reader of `actionError` — ten writers plus `call()`'s default failure
          sink all arrive here. It stays in the sidebar's foot while nothing covers the app, and
          <Announce> moves it onto the surface that is on top the moment something does. `.sidebar`
          itself is deliberately left with no z-index: a nav bar over a modal scrim is its own defect. */}
      {actionError && (
        <Announce>
          {/* `data-announcement` marks this as the APP-WIDE announcement rather than one a surface
              owns. Once it can be portalled onto any surface, `surface.getByRole("alert")` would
              otherwise resolve two different claims at once — the surface's own error and this. */}
          <div role="alert" data-announcement="action-error" className="sidebar-error">
            <span>{actionError}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={clearActionError}><CloseIcon /></button>
          </div>
        </Announce>
      )}
    </nav>
  );
}
