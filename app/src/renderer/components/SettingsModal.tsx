import { useEffect, useRef, useState } from "react";
import { useSelectionGlide } from "../flip";
import { STR, STR5, STR_RULES, STR_AUTH } from "@synapse/shared";
import { useUi } from "../store";
import { Dialog } from "./Dialog";
import { AccountSection } from "./settings/AccountSection";
import { SafetyReviewerBlock } from "./settings/SafetyReviewerBlock";
import { CloseIcon, SearchIcon } from "./Icons";
import { EmptyView } from "./EmptyView";
import { openDeepLink, settingLink } from "../deep-links";
import { rowOf, searchSettings, type SettingEntry } from "./settings/search-index";
import { AutoReviewSection, GeneralSection } from "./settings/GeneralSection";
import { registerGeneralBlock, registerSectionBlock, registerSettingsSection, sectionOf, settingsSections, type SettingsSectionId } from "./settings/sections";
import { SettingLinksLayer } from "./settings/SettingLinksLayer";

registerSettingsSection("general", STR.general, GeneralSection);
registerSettingsSection("auto-review", STR_RULES.rules, AutoReviewSection);
// The Anthropic API key (the only sign-in).
registerSettingsSection("account", STR_AUTH.sectionTitle, AccountSection);
registerSectionBlock("auto-review", "safety-reviewer", 10, SafetyReviewerBlock);

export function SettingsModal() {
  const { closeSettings, settingsFocus } = useUi();
  const [current, setCurrent] = useState<SettingsSectionId>(sectionOf(settingsFocus));
  useEffect(() => setCurrent(sectionOf(settingsFocus)), [settingsFocus]);
  const navRef = useRef<HTMLElement>(null);
  useSelectionGlide(navRef, ".nav-item.current", current);
  const list = settingsSections();
  const Body = list.find((s) => s.id === current)?.Component ?? GeneralSection;
  // Settings search (UI polish pass, brief 2): one field in the Settings chrome that finds any
  // preference by label or keyword, in any section, and jumps to it (the section opens, the row
  // flashes — the same path a copied setting link takes). `jump` remounts the link layer so a jump
  // within the section already open still flashes its row.
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState(0);
  const hits = query.trim() ? searchSettings(query) : null;
  const sectionLabel = (id: string) => list.find((x) => x.id === id)?.label ?? id;
  const go = (x: SettingEntry) => {
    setQuery("");
    openDeepLink(settingLink(x.section, rowOf(x)));
    setCurrent(x.section);
    setJump((j) => j + 1);
  };
  // Hand-testing round: `aria-modal` was the only thing that made this a modal. Cmd+, flipped
  // `settingsOpen` without moving focus, so focus stayed in the chat composer behind the scrim and
  // the next keystrokes were typed into the message box the user could no longer see. <Dialog> now
  // owns focus-in, the Tab trap, Escape and the hand-back — including the account-menu route, where
  // the menu item that opened this has already unmounted by the time the trigger is read.
  return (
    <Dialog label={STR.settings} onClose={closeSettings} className="settings-dialog">
      <>
        <nav ref={navRef} aria-label="Settings sections" className="settings-nav">
          <label className="search settings-search">
            <SearchIcon />
            <input type="search" aria-label={STR.searchSettings} placeholder={STR.searchSettings} value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hits?.[0]) { e.preventDefault(); go(hits[0]); }
                // Escape with a query clears the field, not the whole modal (defect 8's rule).
                if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
              }} />
          </label>
          {list.map((s) => (
            <button key={s.id} type="button" className={s.id === current ? "nav-item current" : "nav-item"} aria-current={s.id === current ? "page" : undefined}
              disabled={!s.Component} title={s.Component ? undefined : STR5.notAvailableYet} onClick={() => setCurrent(s.id)}>{s.label}</button>
          ))}
        </nav>
        <div className="settings-content" data-settings-section={current}>
          <button type="button" className="icon-btn settings-close" aria-label="Close settings" onClick={closeSettings}><CloseIcon /></button>
          {hits ? (
            hits.length ? (
              <div className="settings-card settings-results">
                {hits.map((x) => (
                  <button key={`${x.section}:${x.label}`} type="button" className="settings-row settings-result" onClick={() => go(x)}>
                    <span style={{ flexGrow: 1 }}>{x.label}</span>
                    <span className="muted">{sectionLabel(x.section)}</span>
                  </button>
                ))}
              </div>
            ) : <EmptyView icon={<SearchIcon size={18} />} title={STR.noMatchingSettings} size="inline" />
          ) : <Body />}
          <SettingLinksLayer key={`${current}:${jump}`} />
        </div>
      </>
    </Dialog>
  );
}
