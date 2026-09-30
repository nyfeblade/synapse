import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_BOT_MODEL, STR, STR5, STRL, STRV, modelLabel, type BotSummary, type PermMode } from "@synapse/shared";
import { useUi } from "../store";
import type { UiState } from "../reducer";
import { BotAvatar } from "../avatar/BotAvatar";
import { useCallPresence, useCallSlot } from "../voice/call-presence";
import { AttentionBanner } from "./AttentionBanner";
import { ChatHeaderActions } from "./ChatHeaderActions";
import { ComputerGlyph } from "./ComputerGlyph";
import { SpendMeter } from "./SpendMeter";
import { Composer } from "./Composer";
import { DetailsPanel } from "./DetailsPanel";
import { DiskBanner } from "./DiskBanner";
import { TeachSurface } from "./TeachBanner";
import { Transcript } from "./Transcript";
import { Trays } from "./Trays";

const PERM_LABEL: Record<PermMode, string> = { ask: STR5.permModeAsk, "accept-edits": STR5.permModeAcceptEdits, "full-auto": STR5.permModeFullAuto };
const short = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };

/** The header's live chip: what the Bot is doing right now, from its current activity. Idle: none. */
export function liveStatus(bot: BotSummary, onCall: boolean): { label: string; kind: "on-call" | "waiting" | "working" } | null {
  if (onCall) return { label: STRL.onCall, kind: "on-call" };
  // New-user walk, finding 6: nothing runs while an approval card waits; it waits on the user.
  if (bot.awaiting) return { label: STRV.presenceWaiting, kind: "waiting" };
  if (!bot.running && (!bot.presence || bot.presence === "idle")) return null;
  const task = bot.activity?.detail ?? bot.activity?.tool ?? "";
  const verb = bot.activity?.thinking && !task ? STRL.thinking : STR.working;
  return { label: task ? `${verb} · ${short(task, 40)}` : verb, kind: "working" };
}

/** The header's second line: the model and the permission mode, or a group's members. Data only. */
export function headerSubline(bot: BotSummary, bots: Record<string, BotSummary>): string {
  if (bot.group) return bot.group.memberIds.map((id) => bots[id]?.profile.name).filter(Boolean).join(", ");
  // Bug 258: a Bot in No limits shows it here, where it is always in sight.
  const perm = bot.settings.permMode === "full-auto" && bot.settings.noLimits === true ? STR5.permModeNoLimits : PERM_LABEL[bot.settings.permMode ?? "ask"];
  return [modelLabel(bot.profile.model ?? DEFAULT_BOT_MODEL), perm].join(" · ");
}

/**
 * The three columns collapse from the outside in (app.css): under ~1180px the right column closes on
 * its own, and comes back when there is room again — unless the user closed it themselves. Opened
 * again while narrow, it takes its place in the row and the chat column gives way (new-user walk, finding 24).
 *
 * The panel now starts closed by default (smooth pass, Task 5), so "comes back" has to mean whatever
 * the user last had open, not a hardcoded tab — a Bot with Files open before the window narrowed gets
 * Files back, not Now, and a Bot the user had closed on purpose stays closed.
 */
function useNarrowPanel() {
  const restore = useRef<UiState["panel"] | null>(null);
  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1180px)") : null;
    if (!mq) return;
    const apply = () => {
      const { panel, setPanel } = useUi.getState();
      if (mq.matches && panel !== "closed") { restore.current = panel; setPanel("closed"); }
      else if (!mq.matches && restore.current) {
        const p = restore.current;
        restore.current = null;
        if (useUi.getState().panel === "closed") setPanel(p);
      }
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
}

export function ChatView({ botId }: { botId: string }) {
  const bot = useUi((s) => s.bots[botId]);
  const bots = useUi((s) => s.bots);
  const { panel, setPanel } = useUi();
  const onCall = useCallPresence((s) => s.chatId === botId || s.members.includes(botId));
  useNarrowPanel();
  // Bug 134: the live call's screen shows in its own chat's pane (the call itself lives at the app
  // level and keeps running in other chats, as a pill).
  const mainRef = useRef<HTMLElement>(null);
  const hasBot = Boolean(bot);
  // The header's bottom rule (smooth pass, Task 4): it earns its keep only once the transcript has
  // scrolled, from the same scroll handling Transcript already does for auto-scroll and "New messages".
  const [scrolled, setScrolled] = useState(false);
  useLayoutEffect(() => {
    useCallSlot.getState().set(mainRef.current, botId);
    return () => { if (useCallSlot.getState().botId === botId) useCallSlot.getState().set(null, null); };
  }, [botId, hasBot]);
  if (!bot) return <main className="main" />;
  const live = liveStatus(bot, onCall);
  return (
    <>
      <main className="main" ref={mainRef}>
        <header className="chat-header" data-scrolled={scrolled ? "" : undefined}>
          <h1 className="chat-title">
            <button type="button" aria-label="View conversation details" aria-expanded={panel !== "closed"} className="title-btn" onClick={() => setPanel(panel === "closed" ? "details" : "closed")}>
              {/* Plain wrappers: the open-a-Bot morph that targeted them is off (view-transition.ts). */}
              <span className="morph-avatar"><BotAvatar bot={bot} size={30} /></span>
              <span className="title-stack">
                <span className="title-line">
                  <span className="morph-name">{bot.profile.name}</span>
                  {live && <span className={`live-chip ${live.kind}`} title={bot.activity?.detail ?? undefined}>{live.label}</span>}
                </span>
                <span className="chat-subline">{headerSubline(bot, bots)}</span>
              </span>
            </button>
          </h1>
          {bot.settings.engineeringMode && <span className="chip mode-chip" title={STR5.engineeringModeHint}>{STR5.engineeringChip}</span>}
          <SpendMeter botId={botId} />
          <ComputerGlyph botId={botId} />
          <ChatHeaderActions botId={botId} />
        </header>
        <DiskBanner botId={botId} />
        <Transcript botId={botId} onScrolledChange={setScrolled} />
        <Trays botId={botId} />
        <AttentionBanner botId={botId} />
        <TeachSurface surface="chat" botId={botId} />
        <Composer key={botId} botId={botId} name={bot.profile.name} running={bot.running} />
      </main>
      {panel !== "closed" && <DetailsPanel botId={botId} />}
    </>
  );
}
