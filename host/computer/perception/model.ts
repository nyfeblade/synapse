import { createHash } from "node:crypto";

/**
 * Live perception (decisions.md 2026-09-21, "Computer perception: Live (beta)"): the host keeps a text model of
 * the screen instead of sending the model a picture after every action. Ported from the lab's bake-off DESCRIPTION
 * (its code was not available): CDP accessibility tree for Chromium, AT-SPI for desktop apps, stable element ids,
 * and a short diff after each act. Everything below is pure so it is tested offline.
 */

export interface Box { x: number; y: number; w: number; h: number }
export type Src = "web" | "desk";

/** One element as a source reports it (before ids are assigned). `key` is stable for the same element across reads. */
export interface RawEl {
  key: string; role: string; name: string; value?: string; states: string[]; b: Box; win: string;
  /** Source-specific handle the actor uses (web: backendDOMNodeId). */
  ref?: number;
}
export interface Win { key: string; title: string; role: string; app: string; active: boolean; b: Box; src: Src; popup?: boolean }
export interface RawScreen {
  at: number; windows: Win[]; els: RawEl[];
  page?: { url: string; title: string; loading: boolean };
  /** The active window exposes no accessibility information (a native dialog, a canvas app). */
  noA11y?: Win;
}
export interface El extends RawEl { id: string; src: Src }
export interface Screen extends Omit<RawScreen, "els"> { els: El[]; focus: string | null }

export const SCREEN_W = 1280;
export const SCREEN_H = 800;
/** Elements smaller than this in either dimension are flagged `tiny` (the lab's tiny-target failures). */
export const TINY_PX = 10;

/** Stable ids: the same element key always maps to the same short id for the life of the display's service. */
export class IdRegistry {
  private ids = new Map<string, string>();
  private n = 0;
  idFor(key: string): string {
    let id = this.ids.get(key);
    if (!id) {
      this.n += 1;
      id = `e${this.n}`;
      this.ids.set(key, id);
    }
    return id;
  }
}

export function withIds(raw: RawScreen, reg: IdRegistry): Screen {
  const srcOf = new Map(raw.windows.map((w) => [w.key, w.src]));
  const els: El[] = raw.els.map((e) => ({ ...e, id: reg.idFor(e.key), src: srcOf.get(e.win) ?? "desk" }));
  const focused = els.find((e) => e.states.includes("focused"));
  return { ...raw, els, focus: focused?.id ?? null };
}

const q = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 79)}…` : s);
export const center = (b: Box) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });
export const onScreen = (b: Box) => b.w > 0 && b.h > 0 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < SCREEN_W && b.y < SCREEN_H;
const SHOWN_STATES = ["focused", "disabled", "checked", "selected", "expanded", "collapsed", "required", "invalid", "readonly", "modal"];

/** One line: `e12 button "Save" focused`. Tiny and off-screen targets are marked; coordinates are not shown (act by id). */
export function elLine(e: El): string {
  const st = SHOWN_STATES.filter((s) => e.states.includes(s));
  if (e.b.w > 0 && e.b.h > 0 && (e.b.w < TINY_PX || e.b.h < TINY_PX)) st.push("tiny");
  if (!onScreen(e.b)) st.push("offscreen");
  const val = e.value !== undefined && e.value !== "" && e.value !== e.name ? ` =${q(e.value)}` : "";
  return `${e.id} ${e.role}${e.name ? ` ${q(e.name)}` : ""}${val}${st.length ? ` ${st.join(",")}` : ""}`;
}

function winLine(w: Win, s: Screen): string {
  const tags = [w.role !== "frame" && w.role !== "window" ? w.role : "", w.active ? "active" : "", w.popup ? "popup" : ""].filter(Boolean);
  const page = w.src === "web" && s.page ? ` ${s.page.url}${s.page.loading ? " (loading)" : ""}` : "";
  return `# ${w.src === "web" ? "page" : "window"} ${q(w.title || w.app || "untitled")}${page}${tags.length ? ` [${tags.join(",")}]` : ""}`;
}

/** The compact view Look returns: windows as headers, one line per element under its window, capped. */
export function renderScreen(s: Screen, o: { maxLines: number }): string {
  const lines: string[] = [];
  const order = [...s.windows].sort((a, b) => Number(!!b.popup) - Number(!!a.popup) || Number(b.active) - Number(a.active));
  let total = 0;
  for (const w of order) {
    const mine = s.els.filter((e) => e.win === w.key);
    lines.push(winLine(w, s));
    if (!w.active && !w.popup) continue; // background windows: the header only
    if (s.noA11y && s.noA11y.key === w.key) lines.push("(this window exposes no accessibility info: Look with a query, or Screenshot)");
    for (const e of mine) {
      if (total >= o.maxLines) break;
      lines.push(elLine(e));
      total += 1;
    }
  }
  const shown = s.els.filter((e) => order.some((w) => w.key === e.win && (w.active || w.popup))).length;
  if (shown > total) lines.push(`… ${shown - total} more; Look with a query to narrow it`);
  if (!s.windows.length) lines.push("(no windows)");
  return lines.join("\n");
}

/** What changed between two reads. `important` lines are the ones worth waking the model for. */
export interface Diff { lines: string[]; important: string[]; changed: boolean }
const ERROR_RE = /\b(error|invalid|incorrect|failed|failure|required|wrong|not found|denied|try again)\b/i;
const DIALOG_ROLES = new Set(["dialog", "alertdialog", "alert", "file chooser", "filechooser"]);

export function diffScreens(a: Screen | null, b: Screen, o: { maxAdded: number; maxRemoved: number }): Diff {
  const lines: string[] = [];
  const important: string[] = [];
  if (!a) return { lines: [], important: [], changed: true };
  const aw = new Map(a.windows.map((w) => [w.key, w]));
  const bw = new Map(b.windows.map((w) => [w.key, w]));
  for (const w of b.windows) {
    if (aw.has(w.key)) continue;
    const kind = DIALOG_ROLES.has(w.role) ? "dialog" : w.popup ? "menu" : w.src === "web" ? "page" : "window";
    const l = `+ ${kind} ${q(w.title || w.app || "untitled")} opened`;
    lines.push(l);
    if (kind === "dialog" || kind === "window") important.push(l);
  }
  for (const w of a.windows) if (!bw.has(w.key)) lines.push(`- ${w.popup ? "menu" : "window"} ${q(w.title || w.app || "untitled")} closed`);
  const active = b.windows.find((w) => w.active);
  const wasActive = a.windows.find((w) => w.active);
  if (active && wasActive && active.key !== wasActive.key && aw.has(active.key)) lines.push(`active window → ${q(active.title || active.app)}`);

  if (b.page && (!a.page || a.page.url !== b.page.url || (a.page.loading && !b.page.loading))) {
    const l = b.page.loading ? `page loading: ${b.page.url}` : `page loaded: ${q(b.page.title)} ${b.page.url}`;
    lines.push(l);
    if (!b.page.loading) important.push(l);
  }

  const ae = new Map(a.els.map((e) => [e.id, e]));
  const be = new Map(b.els.map((e) => [e.id, e]));
  const added = b.els.filter((e) => !ae.has(e.id));
  const removed = a.els.filter((e) => !be.has(e.id));
  for (const e of added) {
    if (DIALOG_ROLES.has(e.role)) { const l = `+ dialog ${q(e.name)} appeared (${e.id})`; lines.push(l); important.push(l); }
    else if (e.role === "alert" || ((e.role === "text" || e.role === "label" || e.role === "status") && ERROR_RE.test(e.name))) {
      const l = `! error text: ${q(e.name)}`;
      lines.push(l);
      important.push(l);
    }
  }
  const plain = added.filter((e) => !DIALOG_ROLES.has(e.role) && e.role !== "alert");
  for (const e of plain.slice(0, o.maxAdded)) lines.push(`+ ${elLine(e)}`);
  if (plain.length > o.maxAdded) lines.push(`+ … ${plain.length - o.maxAdded} more new elements; Look to see them`);
  for (const e of removed.slice(0, o.maxRemoved)) lines.push(`- ${e.id} ${e.role}${e.name ? ` ${q(e.name)}` : ""}`);
  if (removed.length > o.maxRemoved) lines.push(`- … ${removed.length - o.maxRemoved} more gone`);
  for (const e of b.els) {
    const p = ae.get(e.id);
    if (!p) continue;
    const bits: string[] = [];
    if ((p.value ?? "") !== (e.value ?? "")) bits.push(`value ${q(p.value ?? "")} → ${q(e.value ?? "")}`);
    if (p.name !== e.name) bits.push(`name ${q(p.name)} → ${q(e.name)}`);
    const gained = e.states.filter((s) => s !== "focused" && SHOWN_STATES.includes(s) && !p.states.includes(s));
    const lost = p.states.filter((s) => s !== "focused" && SHOWN_STATES.includes(s) && !e.states.includes(s));
    if (gained.length) bits.push(`now ${gained.join(",")}`);
    if (lost.length) bits.push(`no longer ${lost.join(",")}`);
    if (bits.length) lines.push(`~ ${e.id} ${e.role}${e.name ? ` ${q(e.name)}` : ""}: ${bits.join("; ")}`);
  }
  if (a.focus !== b.focus && b.focus) {
    const f = be.get(b.focus)!;
    lines.push(`focus → ${f.id} ${f.role}${f.name ? ` ${q(f.name)}` : ""}`);
  }
  return { lines, important, changed: lines.length > 0 };
}

/** A cheap fingerprint of everything the diff looks at, for the settle loop. */
export function signature(s: RawScreen): string {
  const h = createHash("sha1");
  h.update(`${s.page?.url ?? ""}|${s.page?.loading ?? ""}|${s.noA11y?.key ?? ""}\n`);
  for (const w of s.windows) h.update(`${w.key}|${w.active}|${w.title}\n`);
  for (const e of s.els) h.update(`${e.key}|${e.name}|${e.value ?? ""}|${e.states.join(",")}|${Math.round(e.b.x / 4)},${Math.round(e.b.y / 4)},${Math.round(e.b.w / 4)},${Math.round(e.b.h / 4)}\n`);
  return h.digest("hex");
}

/** Parses an Act/Screenshot target: an element id ("e12") or a point ("640,400"). */
export function parseTarget(t: string | undefined): { id: string } | { x: number; y: number } | null {
  if (t === undefined) return null;
  const s = t.trim();
  if (/^e\d+$/.test(s)) return { id: s };
  const m = /^(\d{1,4})\s*,\s*(\d{1,4})$/.exec(s);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  return null;
}

/** "x,y,w,h" → a box clamped to the screen, or null. */
export function parseRegion(t: string): Box | null {
  const m = /^(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})$/.exec(t.trim());
  if (!m) return null;
  return clampBox({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
}

export function clampBox(b: Box): Box | null {
  const x = Math.max(0, Math.min(SCREEN_W - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(SCREEN_H - 1, Math.round(b.y)));
  const w = Math.min(SCREEN_W - x, Math.round(b.w - (x - b.x)));
  const h = Math.min(SCREEN_H - y, Math.round(b.h - (y - b.y)));
  return w >= 2 && h >= 2 ? { x, y, w, h } : null;
}
