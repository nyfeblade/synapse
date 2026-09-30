import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, STR, STR5, type CatalogEntry, type StarterView } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { useTemplates } from "../templates/store";
import { ShapeAvatar } from "./ShapeAvatar";
import { useUi } from "../store";
import { sortedBotIds } from "../reducer";
import { AttachFileButton, VoiceInputButton } from "./ComposerActionButtons";
import { CheckIcon, CloseIcon, PlusIcon } from "./Icons";
import { BotAvatar } from "./GroupAvatarStack";
import { overlaysOpen } from "../overlay-stack";
import { HomeStandup } from "../standup/HomeStandup";

interface Option { key: string; label: string; disabled?: boolean; run(): void; botId?: string; starter?: StarterView; head?: string }

export function NewChat() {
  const { bots, createBot, createGroup, openBot, activeBotId } = useUi();
  const [to, setTo] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const name = to.trim();
  // Non-grouping mode keeps BOT-03's behavior: the recent-Bots list is not filtered by the
  // typed text (only the "Create ... Bot" label reacts to it). Grouping mode is a real
  // recipient search, filtered by the typed name and excluding groups (GRP-01).
  // sortedBotIds() derives each id from its own summary's `.id` field, not from the map's keys, so a
  // summary ever stored under a mismatched key (a store bug — see store.ts's openBot/setGroupMembers)
  // would hand back an id `bots[id]` can't resolve. Tolerate that here too: skip what can't be
  // resolved rather than crash the whole pane over one late or inconsistent summary.
  // New-user walk, finding 16: a typed name filters the Bots too (it used to change only the Create label).
  const recent = useMemo(() => sortedBotIds(bots).filter((id) => bots[id] && !bots[id].settings.hiddenFromSidebar && bots[id].profile.name.toLowerCase().includes(name.toLowerCase())), [bots, name]);
  // …and a few starter templates are offered under Create new Bot (each opens its preview).
  const [starters, setStarters] = useState<StarterView[]>([]);
  useEffect(() => { void callQuiet("listStarterTemplates", {}).then((r) => setStarters(r.starters ?? [])).catch(() => {}); }, []);
  const templates = starters.filter((t) => t.name.toLowerCase().includes(name.toLowerCase())).slice(0, 4);
  const matches = useMemo(
    () => sortedBotIds(bots).filter((id) => bots[id] && !bots[id].group && !bots[id].settings.hiddenFromSidebar && bots[id].profile.name.toLowerCase().includes(name.toLowerCase())),
    [bots, name],
  );
  // Creating a Bot or a group is a round trip, and the view only swaps once it lands: a second click before
  // then used to create a second Bot/group. The ref guards clicks inside the same tick; the state disables the
  // control. A rejection goes to the shared error channel instead of vanishing.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const once = (run: () => Promise<unknown>) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    void run()
      .catch((e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) }))
      .finally(() => { creatingRef.current = false; setCreating(false); });
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= LIMITS.groupMaxMembers ? p : [...p, id]));
  const canCreate = picked.length >= LIMITS.groupMinMembers && picked.length <= LIMITS.groupMaxMembers;
  // flatMap (not map) so an id that still can't be resolved — recent/matches were already filtered
  // to resolvable ids above, but this stays honest even if that ever changes — drops out of the list
  // instead of forcing a lookup that could be undefined.
  const options: Option[] = grouping
    ? matches.flatMap((id) => { const b = bots[id]; return b ? [{ key: id, label: b.profile.name, run: () => toggle(id), botId: id }] : []; })
    : [
        { key: "create", label: name ? STR.createNamedBot(name) : STR.createNewBot, disabled: creating, run: () => once(() => createBot(name || undefined)) },
        ...(!name || STR.createGroupChat.toLowerCase().includes(name.toLowerCase()) ? [{ key: "group", label: STR.createGroupChat, run: () => { setGrouping(true); setSel(0); setTo(""); } }] : []),
        ...templates.map((t, i) => ({ key: t.id, label: t.name, starter: t, ...(i === 0 ? { head: STR5.templatesHead } : {}), run: () => void useTemplates.getState().importEntry({ id: t.id, source: "starter", name: t.name, kind: "bot-template" } as CatalogEntry) })),
        ...recent.slice(0, 7).flatMap((id) => { const b = bots[id]; return b ? [{ key: id, label: b.profile.name, run: () => void openBot(id), botId: id }] : []; }),
      ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // This screen sits UNDERNEATH every overlay, so none of its chords may fire while one is open:
      // ⌘1–9 used to run a palette row and this screen's first option at once, and Escape both closed
      // the palette and navigated away behind it.
      if (overlaysOpen()) return;
      if (e.metaKey && /^[1-9]$/.test(e.key) && !grouping) {
        const o = options[Number(e.key) - 1];
        if (o && !o.disabled) { e.preventDefault(); o.run(); }
      } else if (e.key === "Escape") {
        if (grouping) { setGrouping(false); setPicked([]); } else if (activeBotId) void openBot(activeBotId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main className="main">
      <header className="chat-header">
        {/* UI polish pass (critique 3.4): the field's focus shows as a soft fill on the whole To: row,
            the composer's own exception, instead of a 3px ring boxing the header. */}
        <div className="to-row">
        <label htmlFor="to" className="to-label">{STR.toLabel}</label>
        {grouping && picked.map((id) => <span key={id} className="to-chip">{bots[id]?.profile.name}</span>)}
        <input id="to" className="to-input" type="text" value={to} placeholder={STR.toPlaceholder} autoFocus
          onChange={(e) => { setTo(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, options.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); const o = options[sel]; if (o && !o.disabled) o.run(); }
            if (e.key === "Backspace" && grouping && !to && picked.length) setPicked((p) => p.slice(0, -1));
          }} />
        </div>
        {grouping && (
          <button type="button" className="btn-primary" aria-label="Create group" disabled={!canCreate || creating} onClick={() => once(() => createGroup(picked))}>Create group</button>
        )}
        {/* With no Bot to go back to (the last one was deleted, or a fresh account) this button had nowhere to go
            and did nothing at all, so it isn't offered. */}
        {activeBotId && <button type="button" className="icon-btn" aria-label="Cancel new chat" onClick={() => void openBot(activeBotId)}><CloseIcon /></button>}
      </header>
      <ul role="listbox" aria-label="Recipients" aria-multiselectable={grouping || undefined} className="picker">
        {options.map((o, i) => {
          const checked = grouping && o.botId ? picked.includes(o.botId) : undefined;
          const bot = o.botId ? bots[o.botId] : undefined;
          return (
            <Fragment key={o.key}>
            {o.head && <li role="presentation" className="pick-head">{o.head}</li>}
            <li role="option" title={o.starter?.blurb} aria-selected={grouping ? Boolean(checked) : i === sel} className={i === sel ? "pick selected" : "pick"}
              onMouseEnter={() => setSel(i)} onClick={() => !o.disabled && o.run()}>
              <span className="pick-icon">{bot ? <BotAvatar bot={bot} size={bot.group ? 36 : 20} /> : o.starter ? <ShapeAvatar shape={o.starter.avatarShape} color={o.starter.avatarColor} size={20} still /> : <PlusIcon />}</span>
              <span className="pick-label">{o.label}</span>
              {grouping ? (checked && <CheckIcon />) : i < 9 && <span className="kbds"><kbd>⌘</kbd><kbd>{i + 1}</kbd></span>}
            </li>
            </Fragment>
          );
        })}
      </ul>
      <HomeStandup />
      <div style={{ flexGrow: 1 }} />
      <div className="composer-wrap">
        <div className="composer">
          <AttachFileButton />
          <input type="text" className="composer-input" placeholder={STR.newChatPlaceholder} aria-label={STR.newChatPlaceholder} disabled title="Choose a recipient first" />
          <VoiceInputButton />
        </div>
      </div>
    </main>
  );
}
