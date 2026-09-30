import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SNIPPET_CLOSE, SNIPPET_OPEN, STR, STR5, type SearchResult } from "@synapse/shared";
import { call } from "../bridge";
import { useOverlays } from "../overlays";
import { LogoTile } from "../marketplace/LogoTile";
import { marketplacePaletteRows } from "../marketplace/palette-rows";
import { defaultRows, marketRows, typedRows, withShortcuts, type PaletteCtx, type PaletteIcon, type PaletteRow } from "../palette-rows";
import "../styles/palette.css";
import { useComputer } from "../computer-state";
import { useUi } from "../store";
import { cycleTheme } from "../theme";
import { useTemplates } from "../templates/store";
import { useVoice } from "../voice/VoiceOverlay";
import { Dialog } from "./Dialog";
import { SearchIcon } from "./Icons";
import { ShapeAvatar } from "./ShapeAvatar";

const ICON_PATHS: Record<Exclude<PaletteIcon, "bot">, ReactNode> = {
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M9 20h6M12 16v4" /></>,
  chart: <path d="M6 20V10M12 20V4M18 20v-7" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  store: <><path d="M4 9h16l-1-4H5Z" /><path d="M5 9v10h14V9M10 19v-5h4v5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  message: <path d="M4 5h16v11H8l-4 4Z" />,
  file: <><path d="M14 3H6v18h12V7Z" /><path d="M14 3v4h4" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  call: <><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></>,
};

function Snippet({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${SNIPPET_OPEN}[^${SNIPPET_CLOSE}]*${SNIPPET_CLOSE})`));
  return <>{parts.map((p, i) => (p.startsWith(SNIPPET_OPEN) ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

export function CommandPalette() {
  const close = useOverlays((s) => s.close);
  const bots = useUi((s) => s.bots);
  const pinned = useUi((s) => s.pinned);
  const view = useUi((s) => s.view);
  const theme = useUi((s) => s.settings?.themePreference ?? "system");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [market, setMarket] = useState<PaletteRow[]>([]);
  const [sel, setSel] = useState(0);
  const ctx: PaletteCtx = useMemo(() => ({
    bots, pinned, theme, currentBotId: view.kind === "chat" ? view.botId : null,
    actions: {
      openBot: (id) => { useComputer.getState().closeComputer(); void useUi.getState().openBot(id); },
      openChatSettings: () => useUi.getState().setPanel("settings"),
      openSettings: (s) => useUi.getState().openSettings(s),
      cycleTheme: async () => { await cycleTheme(); },
      newBot: () => useUi.getState().openNewChat(),
      showHidden: () => useOverlays.getState().openOverlay("hidden-bots"),
      exportBot: (id) => void useTemplates.getState().openExport(id),
      importBot: () => void useTemplates.getState().importFromFile(),
      jumpTo: (b, e) => { useComputer.getState().closeComputer(); void useUi.getState().jumpTo(b, e); },
      // Phase 2 (bug 213): the call opens with the first Bot; the others join as soon as it connects.
      startCall: (ids) => {
        const [first, ...rest] = ids;
        if (!first) return;
        useComputer.getState().closeComputer();
        const open = useVoice.getState().openFor;
        // A call is already open: they join it ("bring in") — never nothing.
        if (open) { useVoice.getState().bringIn(ids); void useUi.getState().openBot(open); return; }
        useVoice.getState().open(first, rest);
        void useUi.getState().openBot(first);
      },
    },
  }), [bots, pinned, theme, view]);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(() => void call("search", { query: q }).then((r) => setResults(r.results)).catch(() => setResults([])), 120);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    // PAL-04: Marketplace rows come from the catalog; typed queries are debounced like search.
    let live = true;
    const load = () => void marketplacePaletteRows(q).then((m) => { if (live) setMarket(marketRows(m)); }).catch(() => { if (live) setMarket([]); });
    const t = setTimeout(load, q.trim() ? 120 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const rows = useMemo(() => withShortcuts(q.trim() ? typedRows(ctx, q, results, market) : defaultRows(ctx, market)), [ctx, q, results, market]);
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);
  const choose = (i: number) => {
    const r = rows[i];
    if (!r || r.disabled) return;
    if (!r.keepOpen) close(); // close first: some rows open another overlay (Show Hidden Bots)
    // A row whose action rejects used to become an unhandled promise rejection — to the user the
    // row simply did nothing. Route it to the same role="alert" banner the rest of the app uses.
    void Promise.resolve(r.run()).catch((e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) }));
  };
  // Escape is gone from here: the overlay stack owns it, so this no longer needs a capture-phase
  // listener or an ad-hoc "am I on top?" predicate. ⌘1–9 still has to be claimed, because the screen
  // underneath (New Chat) keeps its own window handler for it — that screen is guarded by
  // `overlaysOpen()` now too, and this stops the event as well so the order of the two listeners
  // cannot matter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); choose(Number(e.key) - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <Dialog label={STR.search} onClose={close} className="palette">
      <>
        <label className="palette-input">
          <SearchIcon />
          <input type="text" placeholder={STR.search} aria-label={STR.search} autoFocus value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
            }} />
        </label>
        <ul role="listbox" aria-label="Results" className="palette-list">
          {!rows.length && <li className="muted palette-empty">{STR.searchNoResults}</li>}
          {rows.map((r, i) => {
            const b = r.botId ? bots[r.botId] : undefined;
            return (
              <li key={r.key} role="option" aria-selected={i === sel} aria-disabled={r.disabled || undefined} title={r.disabled ? STR5.notAvailableYet : undefined}
                className={`palette-row${i === sel ? " selected" : ""}${r.disabled ? " disabled" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                <span className="palette-icon">
                  {r.logo ? <LogoTile name={r.logo.name} logo={r.logo.logo} size={24} />
                    : b && (r.icon === "bot" || r.icon === "message") ? <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={24} />
                    : <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON_PATHS[r.icon as Exclude<PaletteIcon, "bot">]}</svg>}
                </span>
                <span className="palette-text">
                  <span className="palette-title">{r.title}{b?.profile.title && r.icon === "bot" ? <span className="chip">{b.profile.title}</span> : null}</span>
                  {r.subtitle && <span className="palette-sub"><Snippet text={r.subtitle} /></span>}
                </span>
                {/* New-user walk, nit 28: one style of shortcut hint on every row (it switched to boxed keys on the selected one). */}
                {r.shortcut && <span className="palette-key">{r.shortcut}</span>}
              </li>
            );
          })}
        </ul>
      </>
    </Dialog>
  );
}
