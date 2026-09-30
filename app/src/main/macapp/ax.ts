/**
 * mac-apps: the GENERIC FALLBACK. Any app with no script interface is read through the Accessibility API by the
 * `bots-mac` helper and rendered with the SAME outline renderer the Browser tool uses (../browser/outline.ts):
 * `[e12] button "Send"`, aggressive pruning, a hard cap with paging, and a diff after every action.
 *
 * The helper hands back a flat list of nodes with window-relative geometry; that maps one-to-one onto the
 * renderer's PageNode, so an app's outline reads exactly like a page's and one set of pruning rules is tested once.
 */
import { diffPaged, renderOutline, type PageNode, type PageState } from "../browser/outline";

/** ~3k tokens at the ~3.5 chars/token these outlines measure — tighter than the browser's page budget. */
export const AX_MAX_CHARS = 10_500;

/** One node exactly as MacApps.swift emits it. */
export interface AxNode {
  ref: string;
  role: string;
  name: string;
  depth: number;
  y: number;
  h: number;
  interactive: boolean;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  sensitive?: "password";
}

/** One `ax` reply. */
export interface AxRead {
  app: string;
  window: string;
  vh: number;
  nodes: AxNode[];
  truncated?: boolean;
  /** google-setup re-review 2: the window holds an AXWebArea (a browser, or an app's embedded web view). */
  web?: boolean;
}

/** Trust nothing off the wire: a node is shaped here or it is dropped. */
export function toRead(r: Record<string, unknown>): AxRead | null {
  const app = typeof r.app === "string" ? r.app : null;
  if (!app || !Array.isArray(r.nodes)) return null;
  const nodes: AxNode[] = [];
  for (const raw of r.nodes as Record<string, unknown>[]) {
    if (typeof raw?.ref !== "string" || typeof raw.role !== "string") continue;
    const n: AxNode = {
      ref: raw.ref,
      role: raw.role,
      name: typeof raw.name === "string" ? raw.name : "",
      depth: num(raw.depth, 0),
      y: num(raw.y, 0),
      h: num(raw.h, 0),
      interactive: raw.interactive === true,
    };
    if (typeof raw.value === "string") n.value = raw.value;
    if (typeof raw.checked === "boolean") n.checked = raw.checked;
    if (typeof raw.expanded === "boolean") n.expanded = raw.expanded;
    if (raw.disabled === true) n.disabled = true;
    if (raw.focused === true) n.focused = true;
    if (raw.sensitive === "password") n.sensitive = "password";
    nodes.push(n);
  }
  return {
    app,
    window: typeof r.window === "string" ? r.window : "",
    vh: Math.max(1, num(r.vh, 800)),
    nodes,
    ...(r.truncated === true ? { truncated: true } : {}),
    ...(r.web === true || nodes.some((n) => n.role === "webarea") ? { web: true } : {}),
  };
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * The renderer's PageState for one read. `doc` is the app + window, so a new window reads as a new document
 * and returns a whole outline instead of a meaningless diff; `url` carries the window title for the header.
 */
export function toState(r: AxRead): PageState {
  return { url: r.window, title: r.app, doc: `${r.app}\u0000${r.window}`, vh: r.vh, nodes: r.nodes as PageNode[] };
}

export const axHeader = (r: AxRead): string => `App: ${r.app}${r.window ? ` — ${r.window}` : ""}`;

/** The first read of an app: a whole outline, capped, with the rest paged behind `ui.more`. */
export function axOutline(r: AxRead, o: { maxChars?: number } = {}): { text: string; rest: string[] } {
  const out = renderOutline(toState(r), { maxChars: o.maxChars ?? AX_MAX_CHARS, header: axHeader(r), ...(r.truncated ? { prefix: "(a big window: the outline stops at the cap — act on what is here, or use the app's menus)" } : {}) });
  return out;
}

/** After an action: only what changed, keyed by ref, exactly as a page action reports it. */
export function axDiff(prev: AxRead | null, next: AxRead, o: { maxChars?: number } = {}): { text: string; rest: string[] } {
  if (!prev) return axOutline(next, o);
  return diffPaged(toState(prev), toState(next), { maxChars: o.maxChars ?? AX_MAX_CHARS, header: axHeader(next), newDocPrefix: "(a different window)" });
}

/** The line a stale ref gets: the Bot is told exactly how to recover, never just "failed". */
export const staleRef = (ref: string): string => `${ref} is no longer on screen. Read the app again with action "ui.outline".`;
