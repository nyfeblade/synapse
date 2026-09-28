/**
 * mac-browser: the page as a Bot reads it. The page agent (page-agent.ts) collects a flat, document-order list of
 * meaningful nodes with stable refs; this module prunes it, renders it as a short outline, caps it (~4k tokens, the
 * rest paged by action "more") and diffs two states so an action returns only what changed.
 */

export interface PageNode {
  ref: string;
  role: string;
  name: string;
  /** Nesting under landmarks / forms / dialogs only (keeps the outline flat and cheap). */
  depth: number;
  /** Viewport-relative top and height, CSS px. */
  y: number;
  h: number;
  interactive: boolean;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  sensitive?: "password" | "card";
  /** A select's first options, so the Bot can pick one without opening it. */
  options?: string[];
}
export interface PageState { url: string; title: string; /** A per-document id: a new one means a navigation. */ doc: string; vh: number; nodes: PageNode[] }

/** ~4k tokens at the ~3.5 chars/token these outlines measure (quotes, brackets and short words tokenize densely). */
export const OUTLINE_MAX_CHARS = 14_000;
export const estTokens = (s: string): number => Math.ceil(s.length / 3.5);

const q = (s: string) => JSON.stringify(s.length > 160 ? `${s.slice(0, 159)}…` : s);

export function lineOf(n: PageNode): string {
  const pad = "  ".repeat(n.depth);
  const head = n.role === "text" ? q(n.name)
    : n.role === "heading" ? `h${n.level ?? 2} ${q(n.name)}`
    : `${n.interactive ? `[${n.ref}] ` : ""}${n.role}${n.name ? ` ${q(n.name)}` : ""}`;
  const bits: string[] = [];
  if (n.sensitive) { if (n.value) bits.push('value="•••"'); }
  else if (n.value !== undefined && n.value !== "") bits.push(`value=${q(n.value)}`);
  if (n.checked !== undefined) bits.push(n.checked ? "checked" : "unchecked");
  if (n.expanded !== undefined) bits.push(n.expanded ? "expanded" : "collapsed");
  if (n.disabled) bits.push("disabled");
  if (n.focused) bits.push("focused");
  if (n.sensitive) bits.push(`(${n.sensitive})`);
  if (n.options?.length) bits.push(`options=${JSON.stringify(n.options)}`);
  return `${pad}${head}${bits.length ? ` ${bits.join(" ")}` : ""}`;
}

/** mac-apps reuses this renderer for an app's Accessibility outline, which needs its own first line. */
const header = (s: Pick<PageState, "url" | "title">, custom?: string) => custom ?? `Page: ${s.title || "(untitled)"} — ${s.url}`;

/** Decorative, duplicate and far-off-screen nodes out; `below` counts what lies further down the page. */
export function pruneNodes(s: PageState): { nodes: PageNode[]; below: number; above: number } {
  const out: PageNode[] = [];
  let below = 0;
  let above = 0;
  const list = s.nodes;
  for (let i = 0; i < list.length; i++) {
    const x = list[i]!;
    const name = x.name.trim();
    if (x.y > 3 * s.vh) { below++; continue; }
    if (x.y + x.h < -s.vh) { above++; continue; }
    if (!x.interactive && !name && !["dialog", "alert", "form", "navigation", "main"].includes(x.role)) continue; // decorative
    if (x.role === "heading" && list[i + 1]?.interactive && list[i + 1]!.name.trim() === name) continue; // a heading that is just its link
    if (x.role === "text") {
      const prev = out[out.length - 1];
      if (prev?.role === "text" && prev.name.trim() === name) continue; // repeated text
      const next = list[i + 1];
      if (next && next.interactive && next.name.trim() === name) continue; // text that only echoes the next control
    }
    out.push(x);
  }
  return { nodes: out, below, above };
}

/**
 * One outline, capped; `rest` holds the next pages for action "more". `seenNavs` (per window) collapses a navigation
 * block this Bot already saw on an earlier page into one line (the same links, in the same order, under new refs).
 */
export function renderOutline(s: PageState, o: { maxChars?: number; prefix?: string; seenNavs?: Set<string>; header?: string } = {}): { text: string; rest: string[] } {
  const max = o.maxChars ?? OUTLINE_MAX_CHARS;
  const { nodes, below, above } = pruneNodes(s);
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const x = nodes[i]!;
    if (x.role === "navigation" && o.seenNavs) {
      let j = i + 1;
      while (j < nodes.length && nodes[j]!.depth > x.depth) j++;
      const kids = nodes.slice(i + 1, j);
      const nums = kids.map((k) => Number(k.ref.slice(1)));
      const plain = kids.length >= 3 && kids.every((k, n) => k.role === "link" && k.depth === x.depth + 1 && (n === 0 || nums[n] === nums[n - 1]! + 1));
      if (plain) {
        const sig = `${x.name}\0${kids.map((k) => k.name).join("\0")}`;
        if (o.seenNavs.has(sig)) {
          lines.push(`${"  ".repeat(x.depth)}navigation ${JSON.stringify(x.name)}: the same ${kids.length} links as before, now ${kids[0]!.ref}–${kids[kids.length - 1]!.ref} in the same order`);
          i = j - 1;
          continue;
        }
        o.seenNavs.add(sig);
      }
    }
    lines.push(lineOf(x));
  }
  if (above) lines.unshift(`… ${above} more above (scroll up to see them)`);
  if (below) lines.push(`… ${below} more below (scroll down to see them)`);
  return page([header(s, o.header), ...(o.prefix ? [o.prefix] : [])], lines, max);
}

/** Split lines into chunks of at most `max` chars; the first carries `head`. */
export function page(head: string[], lines: string[], max = OUTLINE_MAX_CHARS): { text: string; rest: string[] } {
  const chunks: string[][] = [[...head]];
  let size = head.join("\n").length;
  for (const l of lines) {
    const cur = chunks[chunks.length - 1]!;
    if (size + l.length + 1 > max && cur.length > (chunks.length === 1 ? head.length : 0)) { chunks.push([l]); size = l.length; continue; }
    cur.push(l);
    size += l.length + 1;
  }
  const total = chunks.length;
  const text = chunks.map((c, i) => (i < total - 1 ? [...c, `… page ${i + 1} of ${total}: action "more" for the rest`] : c).join("\n"));
  return { text: text[0]!, rest: text.slice(1) };
}

/**
 * What an action changed. A new document returns its outline ("(new page)"); otherwise added (+), changed (~) and
 * removed (-) lines keyed by ref, never longer than the full outline (which it then returns instead).
 */
export function diffOutline(prev: PageState, next: PageState, o: { maxChars?: number } = {}): string {
  return diffPaged(prev, next, o).text;
}

export function diffPaged(prev: PageState, next: PageState, o: { maxChars?: number; seenNavs?: Set<string>; header?: string; newDocPrefix?: string } = {}): { text: string; rest: string[] } {
  const full = () => renderOutline(next, { maxChars: o.maxChars, prefix: prev.doc !== next.doc ? (o.newDocPrefix ?? "(new page)") : undefined, seenNavs: o.seenNavs, ...(o.header ? { header: o.header } : {}) });
  if (prev.doc !== next.doc) return full();
  const before = new Map(pruneNodes(prev).nodes.map((x) => [x.ref, lineOf({ ...x, depth: 0 })]));
  const now = pruneNodes(next).nodes;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const x of now) {
    seen.add(x.ref);
    const l = lineOf({ ...x, depth: 0 });
    const was = before.get(x.ref);
    if (was === undefined) lines.push(`+ ${l}`);
    else if (was !== l) lines.push(`~ ${l}`);
  }
  // Scrolled out of view is not removed: only a node gone from the page is.
  const alive = new Set(next.nodes.map((x) => x.ref));
  for (const [ref, l] of before) if (!seen.has(ref) && !alive.has(ref)) lines.push(`- ${l}`);
  const head = [header(next, o.header)];
  if (prev.title !== next.title || prev.url !== next.url) head.push(o.header ? "(same window, the title changed)" : "(same page, URL or title changed)");
  if (!lines.length) return { text: [...head, "No visible change."].join("\n"), rest: [] };
  const d = page(head, lines, o.maxChars);
  const f = full();
  // The diff says what changed, so it wins a near tie (its +/~/- markers cost a few chars on a tiny page).
  return d.text.length + d.rest.join("").length > f.text.length + f.rest.join("").length + 40 ? f : d;
}
