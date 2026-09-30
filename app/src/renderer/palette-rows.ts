import { STR, STR5, STRF, type BotSummary, type SearchResult, type ThemePreference } from "@synapse/shared";
import type { MarketplacePaletteRow } from "./marketplace/palette-rows";
import { parseGroupCall } from "./voice/call-commands";
import { openFeedback } from "./feedback/store";
import { openThreads } from "./feedback/FeedbackThreads";

export type PaletteIcon = "bot" | "gear" | "monitor" | "chart" | "sun" | "store" | "plus" | "eye" | "message" | "file" | "link" | "call";
/** `keywords` are matched by a typed query alongside the title and subtitle: a row whose title is
 * its *current* value ("Theme: Follow System") is otherwise unreachable by typing what you want
 * ("light", "dark", "appearance"). */
export interface PaletteRow { key: string; title: string; subtitle: string; icon: PaletteIcon; keywords?: string[]; logo?: { name: string; logo: string | null }; botId?: string; disabled?: boolean; keepOpen?: boolean; run(): void | Promise<void> }
export interface PaletteActions {
  openBot(id: string): void; openChatSettings(): void; openSettings(section: string): void; cycleTheme(): Promise<void>;
  newBot(): void; showHidden(): void; jumpTo(botId: string, entryId: string): void;
  /** Phase 2 (bug 213): one call with these Bots (the first is the call's anchor). */
  startCall(botIds: string[]): void;
  /** New-user walk, finding 10: the .botpack round trip, from ⌘K. */
  exportBot(botId: string): void; importBot(): void;
}
export interface PaletteCtx { bots: Record<string, BotSummary>; pinned: string[]; currentBotId: string | null; theme: ThemePreference; actions: PaletteActions }

const later = { disabled: true, run: () => {} };
// UI polish pass: ⌘K rows are titles only ("General settings", not "Settings: General" over a
// "Settings" subtitle), and Computer and Usage deep-link to their Settings sections.

function botRows(ctx: PaletteCtx, includeHidden: boolean): PaletteRow[] {
  const all = Object.values(ctx.bots).filter((b) => includeHidden || !b.settings.hiddenFromSidebar);
  const pinned = ctx.pinned.map((id) => ctx.bots[id]).filter((b): b is BotSummary => Boolean(b) && all.includes(b!));
  const rest = all.filter((b) => !ctx.pinned.includes(b.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  // New-user walk, nit 28: no subtitle (it previewed the Bot's raw instructions); they still match a typed query.
  return [...pinned, ...rest].map((b) => ({ key: `bot:${b.id}`, title: b.profile.name, subtitle: "", keywords: [b.profile.description.replace(/\s+/g, " ")], icon: "bot", botId: b.id, run: () => ctx.actions.openBot(b.id) }));
}

function fixedRows(ctx: PaletteCtx): PaletteRow[] {
  return [
    ...(ctx.currentBotId ? [{ key: "chat-settings", title: STR.botSettingsRow, subtitle: "", icon: "gear" as const, keywords: [STR.currentChat, STR.settings], run: () => ctx.actions.openChatSettings() }] : []),
    { key: "settings-general", title: STR.settingsGeneral, subtitle: "", icon: "gear", keywords: [STR.settingsSubtitle], run: () => ctx.actions.openSettings("general") },
    { key: "settings-computer", title: STR.settingsComputer, subtitle: "", icon: "monitor", keywords: [STR.settingsSubtitle], run: () => ctx.actions.openSettings("computer") },
    { key: "settings-usage", title: STR.settingsUsage, subtitle: "", icon: "chart", keywords: [STR.settingsSubtitle, "Account", "billing"], run: () => ctx.actions.openSettings("usage") },
    { key: "theme", title: STR.themeRow(STR.themeLabels[ctx.theme]!), subtitle: "", icon: "sun", keywords: [STR.theme, STR.appearance, STR.themeSubtitle, ...Object.values(STR.themeLabels)], keepOpen: true, run: () => ctx.actions.cycleTheme() },
  ];
}

/** PAL-04: the Marketplace provider's rows (open Marketplace, recent entries, catalog results) as palette rows. */
export function marketRows(rows: MarketplacePaletteRow[]): PaletteRow[] {
  return rows.map((r) => ({
    key: r.id, title: r.title, subtitle: r.subtitle, icon: "store" as const,
    ...(r.icon.kind === "logo" ? { logo: { name: r.icon.name, logo: r.icon.logo } } : {}),
    run: () => r.onSelect(),
  }));
}

/** `market` is appended after the Settings rows (PAL-04). */
export function defaultRows(ctx: PaletteCtx, market: PaletteRow[] = []): PaletteRow[] {
  return [...botRows(ctx, false), ...fixedRows(ctx), ...market];
}

const hl = (s: string) => s; // snippets keep their markers; the component renders them as <mark>

export function typedRows(ctx: PaletteCtx, query: string, results: SearchResult[], market: PaletteRow[] = []): PaletteRow[] {
  const q = query.trim().toLowerCase();
  const match = (r: PaletteRow) =>
    r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q) || (r.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  const actions: PaletteRow[] = [
    { key: "new-bot", title: STR.newBot, subtitle: "", icon: "plus", run: () => ctx.actions.newBot() },
    { key: "new-group", title: STR.newGroupChat, subtitle: "", icon: "plus", ...later },
    { key: "teach", title: STR.teachATask, subtitle: "", icon: "eye", ...later },
    { key: "show-hidden", title: STR.showHiddenBots, subtitle: "", icon: "eye", run: () => ctx.actions.showHidden() },
    ...(ctx.currentBotId ? [{ key: "export-bot", title: STR5.exportBot, subtitle: "", icon: "file" as const, keywords: ["export", "share", "template", "botpack", "save"], run: () => ctx.actions.exportBot(ctx.currentBotId!) }] : []),
    { key: "import-bot", title: STR5.importBot, subtitle: "", icon: "file", keywords: ["import", "botpack", "template", "open"], run: () => ctx.actions.importBot() },
    { key: "feedback", title: STRF.sendFeedback, subtitle: "", icon: "message", keywords: ["feedback", "bug", "report", "idea", "help"], run: () => void openFeedback() },
    { key: "feedback-threads", title: STRF.yourFeedback, subtitle: "", icon: "message", keywords: ["feedback", "replies", "reply"], run: () => openThreads() },
  ];
  const name = (id: string) => ctx.bots[id]?.profile.name ?? "Bot";
  // Phase 2 (bug 213): "call nova and scout" / "call nova scout" is a row of its own, first, so Enter
  // starts the group call — one action.
  const callable = Object.values(ctx.bots).filter((b) => !b.group && !b.archived).map((b) => ({ id: b.id, name: b.profile.name }));
  const group = parseGroupCall(query, callable);
  const callRow: PaletteRow[] = group ? [{ key: `call:${group.join(",")}`, title: STR5.paletteCallBots(group.map(name)), subtitle: "", icon: "call", run: () => ctx.actions.startCall(group) }] : [];
  const found: PaletteRow[] = results.filter((r) => r.kind !== "bot").map((r) => {
    if (r.kind === "file") return { key: `file:${r.botId}:${r.entryId}`, title: r.name, subtitle: `${name(r.botId)} · ${hl(r.snippet)}`, icon: "file", botId: r.botId, run: () => ctx.actions.jumpTo(r.botId, r.entryId) };
    if (r.kind === "link") return { key: `link:${r.botId}:${r.entryId}:${r.url}`, title: r.url, subtitle: `${name(r.botId)} · ${hl(r.snippet)}`, icon: "link", botId: r.botId, run: () => ctx.actions.jumpTo(r.botId, r.entryId) };
    const m = r as Extract<SearchResult, { kind: "message" }>;
    return { key: `msg:${m.botId}:${m.entryId}`, title: name(m.botId), subtitle: hl(m.snippet), icon: "message", botId: m.botId, run: () => ctx.actions.jumpTo(m.botId, m.entryId) };
  });
  return [...callRow, ...botRows(ctx, true).filter(match), ...[...actions, ...fixedRows(ctx)].filter(match), ...market, ...found];
}

export function withShortcuts(rows: PaletteRow[]): (PaletteRow & { shortcut: string | null })[] {
  return rows.map((r, i) => ({ ...r, shortcut: i < 9 ? `⌘${i + 1}` : null }));
}
