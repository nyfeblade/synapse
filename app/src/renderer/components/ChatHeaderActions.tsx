import { useState, type MouseEvent } from "react";
import { STR, STR5 } from "@synapse/shared";
import { useVoice } from "../voice/VoiceOverlay";
import { callQuiet } from "../bridge";
import { useTemplateActions } from "../templates/TemplateMenu";
import { useTemplates } from "../templates/store";
import { useShareItems } from "../templates/share-items";
import { openUsageFor } from "../usage/dashboard-store";
import { useUi } from "../store";
import { Menu } from "./Menus";
import { GearIcon, HeadsetIcon, MoreIcon } from "./Icons";

/**
 * The chat header's actions.
 *
 * WHAT THIS REPLACED: four unlabelled icon buttons in a row — a monitor, a bar chart, a share arrow
 * and a headset — each one a different glyph weight, none of them saying what it did, and three of
 * them things you reach for once a week. A Mail or Messages window puts ONE named action in its
 * title bar and folds the rest behind a single "…", and that is what this is: a labelled Call, and
 * an overflow that holds Usage and the template actions. The computer glyph stays out here beside
 * them, because it is not an action — it is a live indicator that turns violet while the Bot is
 * working on the computer, and an indicator behind a menu indicates nothing.
 *
 * WHY THE CALL BUTTON IS WRITTEN HERE rather than reusing voice/VoiceOverlay's CallButton: that
 * component renders a fixed 32px glyph and takes no label, and voice/ is off limits to this pass. It
 * keeps its `aria-label` verbatim so the accessible name — and everything anchored on it — is
 * unchanged, and "Call" is contained in "Start a voice call", so the visible label is part of the
 * accessible name (WCAG 2.5.3) rather than a second, competing name for the same control.
 *
 * THE GEAR: the smooth pass left the right panel closed by default, which buried Bot settings
 * behind PanelTabs' own gear or a composer pill — both reachable only once the panel is already
 * open (bug 192). This one is always in the header, open panel or closed. For a group, DetailsPanel
 * already routes any non-"closed" panel value to GroupPanel for a `bot.group` (its own routing, not
 * duplicated here), so "open" just means the column isn't closed, whatever value `panel` holds; for
 * a solo Bot it means specifically the "settings" value.
 */
const CALL = "Call";
const MORE_ACTIONS = "More actions";
const USAGE = "Usage & budget";
const BOT_SETTINGS = "Bot settings";

export function ChatHeaderActions({ botId }: { botId: string }) {
  const openCall = useVoice((s) => s.open);
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  const isGroup = useUi((s) => Boolean(s.bots[botId]?.group));
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const templates = useTemplateActions(botId);
  const shareItems = useShareItems(isGroup ? null : botId, at !== null);
  // New-user walk, finding 10: the saved-template actions (details, update, delete) are listed only when this Bot has
  // one; Export and Import are always right here.
  const [hasTemplate, setHasTemplate] = useState(false);
  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: r.right - 200, y: r.bottom + 6 });
    void callQuiet("getTemplate", { id: botId }).then((t) => setHasTemplate(!!t?.template)).catch(() => setHasTemplate(false));
  };
  const settingsLabel = isGroup ? STR.groupSettings : BOT_SETTINGS;
  const settingsOpen = isGroup ? panel !== "closed" : panel === "settings";
  return (
    <>
      <button type="button" className="icon-btn" aria-label={settingsLabel} title={settingsLabel} aria-expanded={settingsOpen} onClick={() => setPanel(settingsOpen ? "closed" : "settings")}>
        <GearIcon />
      </button>
      <button type="button" className="icon-btn call-btn" aria-label={STR5.startVoiceChat} title={STR5.startVoiceChat} onClick={() => openCall(botId)}>
        <HeadsetIcon />{CALL}
      </button>
      <button type="button" className="icon-btn" aria-label={MORE_ACTIONS} title={MORE_ACTIONS} aria-haspopup="menu" aria-expanded={at !== null} aria-busy={templates.busy || undefined} onClick={openMenu}>
        <MoreIcon />
      </button>
      {at && (
        <Menu label={MORE_ACTIONS} x={at.x} y={at.y} onClose={() => setAt(null)} items={[
          { label: USAGE, onSelect: () => openUsageFor(botId) },
          ...shareItems,
          { label: STR5.exportBot, onSelect: () => void useTemplates.getState().openExport(botId) },
          { label: STR5.importBot, onSelect: () => void useTemplates.getState().importFromFile() },
          // The saved template's own actions open as a second menu at the same point.
          ...(hasTemplate ? [{ label: STR5.templateActions, onSelect: () => void templates.openAt(at.x, at.y) }] : []),
        ]} />
      )}
      {templates.node}
    </>
  );
}
