import type { CdpBrowser, CdpPage } from "../browser/connector";
import type { Exec, XEnv } from "../x-exec";
import type { Box, RawEl, RawScreen, Win } from "./model";
import type { PerceptionIO } from "./service";
import { grabRgb, grabWebp, ocrRegion } from "./vision";

/**
 * The box side of Live perception. Two sources, chosen by the active X window:
 *  - Chromium page: the CDP accessibility tree (roles, names, states) + one DOMSnapshot (bounds, clickability,
 *    input types), converted to screen coordinates. Password values never leave the host.
 *  - Anything else: AT-SPI through the root-owned helper /usr/local/libexec/bot-atspi (runs the dump as box, who
 *    owns the display's accessibility bus). A window AT-SPI does not know, or knows empty, is `noA11y`: the
 *    service then attaches a cropped screenshot of just that window and says so.
 * The converters are pure and tested offline; the thin BoxIO around them is exercised on the box.
 */

export interface AxProp { name: string; value: { value?: unknown } }
export interface AxNode {
  nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown };
  childIds?: string[]; parentId?: string; backendDOMNodeId?: number; properties?: AxProp[];
}
export interface DomSnapshot {
  strings: string[];
  documents: {
    scrollOffsetX?: number; scrollOffsetY?: number;
    nodes: { parentIndex?: number[]; nodeType?: number[]; nodeName?: number[]; nodeValue?: number[]; backendNodeId?: number[]; attributes?: number[][]; isClickable?: { index: number[] } };
    layout: { nodeIndex: number[]; bounds: number[][] };
  }[];
}
export interface PageInfo { ox: number; oy: number; url: string; title: string; ready: string }
export interface ActiveX { wid: string; title: string; cls: string; b: Box }

const WEB_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "listbox", "treeitem", "cell", "gridcell", "columnheader", "rowheader", "heading",
  "dialog", "alertdialog", "alert", "status", "canvas", "image", "img", "menu", "listitem", "row",
]);
/** Roles whose name already carries their text: their StaticText children are not listed again. */
const NAMED_FROM_CONTENT = new Set(["button", "link", "cell", "gridcell", "columnheader", "rowheader", "heading", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "treeitem", "switch", "listitem", "row"]);
const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "option", "treeitem", "fileinput"]);
const STATE_ORDER = ["focused", "disabled", "checked", "selected", "expanded", "collapsed", "required", "invalid", "readonly", "modal", "multiline"];
const MAX_ELS = 400;

const order = (s: Set<string>) => STATE_ORDER.filter((x) => s.has(x));

function webStates(props: AxProp[] | undefined): string[] {
  const s = new Set<string>();
  for (const p of props ?? []) {
    const v = p.value?.value;
    if (p.name === "focused" && v) s.add("focused");
    else if (p.name === "disabled" && v) s.add("disabled");
    else if (p.name === "checked" && (v === true || v === "true" || v === "mixed")) s.add("checked");
    else if (p.name === "pressed" && (v === true || v === "true")) s.add("checked");
    else if (p.name === "selected" && v) s.add("selected");
    else if (p.name === "expanded") s.add(v ? "expanded" : "collapsed");
    else if (p.name === "required" && v) s.add("required");
    else if (p.name === "invalid" && v && v !== "false") s.add("invalid");
    else if (p.name === "readonly" && v) s.add("readonly");
    else if (p.name === "modal" && v) s.add("modal");
    else if (p.name === "multiline" && v) s.add("multiline");
  }
  return order(s);
}

/** One Chromium page → its window, elements (screen coordinates) and load state. */
export function webFromCdp(o: { targetId: string; ax: AxNode[]; snap: DomSnapshot; info: PageInfo; win: Box }): { win: Win; els: RawEl[]; page: NonNullable<RawScreen["page"]> } {
  const key = `web:${o.targetId}`;
  const doc = o.snap.documents[0];
  const str = (i: number | undefined) => (i === undefined || i < 0 ? "" : o.snap.strings[i] ?? "");
  const boxOf = new Map<number, Box>();
  const attrsOf = new Map<number, Record<string, string>>();
  const idxOf = new Map<number, number>();
  const nodes = doc?.nodes;
  if (doc && nodes) {
    const sx = doc.scrollOffsetX ?? 0;
    const sy = doc.scrollOffsetY ?? 0;
    const bid = nodes.backendNodeId ?? [];
    bid.forEach((b, i) => idxOf.set(b, i));
    doc.layout.nodeIndex.forEach((ni, j) => {
      const r = doc.layout.bounds[j];
      const b = bid[ni];
      if (!r || b === undefined) return;
      boxOf.set(b, { x: Math.round(r[0]! - sx + o.info.ox), y: Math.round(r[1]! - sy + o.info.oy), w: Math.round(r[2]!), h: Math.round(r[3]!) });
    });
    (nodes.attributes ?? []).forEach((a, i) => {
      if (!a.length) return;
      const rec: Record<string, string> = {};
      for (let k = 0; k + 1 < a.length; k += 2) rec[str(a[k]).toLowerCase()] = str(a[k + 1]);
      if (bid[i] !== undefined) attrsOf.set(bid[i]!, rec);
    });
  }
  const els: RawEl[] = [];
  const included = new Set<number>();
  const byId = new Map(o.ax.map((n) => [n.nodeId, n]));
  const roleOf = (n: AxNode) => (n.role?.value ?? "").toLowerCase();
  const ancestorNamed = (n: AxNode): boolean => {
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (!p.ignored && NAMED_FROM_CONTENT.has(roleOf(p))) return true;
    }
    return false;
  };
  for (const n of o.ax) {
    if (els.length >= MAX_ELS) break;
    if (n.ignored || n.backendDOMNodeId === undefined) continue;
    let role = roleOf(n);
    const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
    if (role === "statictext") {
      if (name.length < 2 || ancestorNamed(n)) continue;
      role = "text";
    } else if (!WEB_ROLES.has(role)) continue;
    if ((role === "image" || role === "img") && !name) continue;
    const b = boxOf.get(n.backendDOMNodeId);
    if (!b || b.w <= 0 || b.h <= 0) continue;
    const attrs = attrsOf.get(n.backendDOMNodeId) ?? {};
    if (attrs.type === "file") role = "fileinput";
    const raw = n.value?.value;
    let value = raw === undefined || raw === null || raw === "" ? undefined : String(raw);
    if (value !== undefined && attrs.type === "password") value = "[redacted]";
    els.push({ key: `${key}:${n.backendDOMNodeId}`, role, name: name.length > 120 ? `${name.slice(0, 119)}…` : name, ...(value !== undefined ? { value } : {}), states: webStates(n.properties), b, win: key, ref: n.backendDOMNodeId });
    included.add(n.backendDOMNodeId);
  }
  // Unlabeled sites: DOM nodes with click handlers the accessibility tree does not name (the lab's "no labels" case).
  if (nodes?.isClickable && nodes.parentIndex && nodes.backendNodeId) {
    const interactiveBids = new Set(els.filter((e) => INTERACTIVE.has(e.role)).map((e) => e.ref!));
    const kids = new Map<number, number[]>();
    nodes.parentIndex.forEach((p, i) => { if (p >= 0) (kids.get(p) ?? kids.set(p, []).get(p)!).push(i); });
    const textOf = (i: number, acc: string[] = []): string[] => {
      if (acc.join(" ").length > 60) return acc;
      if (nodes.nodeType?.[i] === 3) { const t = str(nodes.nodeValue?.[i]).trim(); if (t) acc.push(t); }
      for (const k of kids.get(i) ?? []) textOf(k, acc);
      return acc;
    };
    for (const i of nodes.isClickable.index) {
      if (els.length >= MAX_ELS) break;
      const bid = nodes.backendNodeId[i]!;
      if (included.has(bid)) continue;
      let covered = false;
      for (let p = nodes.parentIndex[i]!; p >= 0; p = nodes.parentIndex[p]!) if (interactiveBids.has(nodes.backendNodeId[p]!)) { covered = true; break; }
      if (covered) continue;
      const b = boxOf.get(bid);
      if (!b || b.w <= 0 || b.h <= 0 || b.w * b.h > 0.5 * o.win.w * o.win.h) continue;
      const attrs = attrsOf.get(bid) ?? {};
      const name = (textOf(i).join(" ").replace(/\s+/g, " ").trim() || attrs.title || attrs.alt || "").slice(0, 60);
      els.push({ key: `${key}:${bid}`, role: "clickable", name, states: [], b, win: key, ref: bid });
      included.add(bid);
    }
  }
  const win: Win = { key, title: o.info.title, role: "frame", app: "chromium", active: true, b: o.win, src: "web" };
  return { win, els, page: { url: o.info.url, title: o.info.title, loading: o.info.ready !== "complete" } };
}

// ---- desktop (AT-SPI helper) ----

export interface HelperEl { k: string; role: string; name?: string; value?: string; states?: string[]; b: number[] }
export interface HelperWin { app: string; pid: number; i: number; title: string; role: string; active: boolean; popup?: boolean; b: number[]; els: HelperEl[] }
export interface HelperOut { windows: HelperWin[] }

const DESK_ROLE: Record<string, string> = {
  "push button": "button", "toggle button": "button", "menu item": "menuitem", "check menu item": "menuitem", "radio menu item": "menuitem",
  "check box": "checkbox", "radio button": "radio", "combo box": "combobox", "list item": "listitem", "table cell": "cell",
  "column header": "columnheader", "row header": "rowheader", "page tab": "tab", "spin button": "spinbutton", label: "text",
  "password text": "textbox", entry: "textbox", icon: "image", "tree item": "treeitem", "tree table": "table", "scroll bar": "scrollbar",
};
const DESK_INTERACTIVE = new Set(["button", "menuitem", "checkbox", "radio", "combobox", "listitem", "cell", "tab", "spinbutton", "textbox", "treeitem", "slider", "link"]);

function deskEl(w: HelperWin, e: HelperEl, winKey: string): RawEl {
  const st = new Set(e.states ?? []);
  let role = DESK_ROLE[e.role] ?? e.role;
  if (e.role === "text") role = st.has("editable") || st.has("single line") || st.has("multi line") ? "textbox" : "text";
  const out = new Set<string>();
  if (st.has("focused")) out.add("focused");
  if (DESK_INTERACTIVE.has(role) && !st.has("sensitive") && !st.has("enabled")) out.add("disabled");
  if (st.has("checked") || st.has("pressed")) out.add("checked");
  if (st.has("selected") && role !== "textbox") out.add("selected");
  if (st.has("expanded")) out.add("expanded");
  else if (st.has("expandable")) out.add("collapsed");
  if (st.has("required")) out.add("required");
  if (st.has("invalid entry") || st.has("invalid")) out.add("invalid");
  if (st.has("read only")) out.add("readonly");
  if (st.has("modal")) out.add("modal");
  if (st.has("multi line")) out.add("multiline");
  const value = e.role === "password text" && e.value ? "[redacted]" : e.value;
  return {
    key: `d:${w.app}:${w.pid}:${e.k}`, role, name: (e.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120), ...(value ? { value: value.slice(0, 200) } : {}),
    states: order(out), b: { x: e.b[0] ?? 0, y: e.b[1] ?? 0, w: e.b[2] ?? 0, h: e.b[3] ?? 0 }, win: winKey,
  };
}

export function deskFromHelper(h: HelperOut | null, active: ActiveX | null): { windows: Win[]; els: RawEl[]; noA11y?: Win } {
  const windows: Win[] = [];
  const els: RawEl[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  let matched: Win | null = null;
  for (const w of h?.windows ?? []) {
    const key = `d:${w.app}:${w.pid}:${w.i}`;
    const isActive = active ? norm(w.title) === norm(active.title) : w.active;
    const win: Win = { key, title: w.title, role: w.role, app: w.app, active: isActive, b: { x: w.b[0] ?? 0, y: w.b[1] ?? 0, w: w.b[2] ?? 0, h: w.b[3] ?? 0 }, src: "desk", ...(w.popup ? { popup: true } : {}) };
    windows.push(win);
    if (isActive && !matched) matched = win;
    for (const e of w.els) if (els.length < MAX_ELS) els.push(deskEl(w, e, key));
  }
  if (active && (!matched || !els.some((e) => e.win === matched!.key))) {
    const noA11y: Win = { key: `x:${active.wid}`, title: active.title, role: "window", app: active.cls, active: true, b: active.b, src: "desk" };
    const rest = windows.filter((w) => w !== matched).map((w) => ({ ...w, active: false }));
    return { windows: [...rest, noA11y], els: els.filter((e) => !matched || e.win !== matched.key), noA11y };
  }
  return { windows, els };
}

export function parseActiveWindow(xdo: string, xprop: string): ActiveX | null {
  const lines = xdo.split("\n");
  const num = (k: string) => Number(new RegExp(`^${k}=(-?\\d+)`, "m").exec(xdo)?.[1] ?? NaN);
  const wid = /^WINDOW=(\d+)/m.exec(xdo)?.[1];
  if (!wid) return null;
  const cls = [...xprop.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  return { wid, title: (lines[0] ?? "").trim(), cls: cls[1] ?? cls[0] ?? "", b: { x: num("X"), y: num("Y"), w: num("WIDTH"), h: num("HEIGHT") } };
}

// ---- the real IO on the box ----

export interface BoxIoDeps {
  exec: Exec; xenv: XEnv; index: number; browser(): Promise<CdpBrowser>;
  sleep(ms: number): Promise<void>; now(): number;
  /** Runs the AT-SPI dump for this display; null when AT-SPI is not available (the caller falls back). */
  atspi(): Promise<HelperOut | null>;
}

const PAGE_INFO_JS = "({ ox: window.screenX, oy: window.screenY + (window.outerHeight - window.innerHeight), url: location.href, title: document.title, ready: document.readyState, vis: document.visibilityState })";
const COVER_FN = `function (x, y) {
  const h = document.elementFromPoint(x, y);
  if (!h || h === this || this.contains(h) || h.contains(this)) return null;
  if (this.labels && [...this.labels].some((l) => l.contains(h))) return null;
  const lab = h.closest("label"); if (lab && lab.control === this) return null;
  let blocker = null;
  for (let n = h; n && n !== document.body; n = n.parentElement) {
    const role = n.getAttribute && n.getAttribute("role");
    if (n.tagName === "DIALOG" || role === "dialog" || role === "alertdialog" || n.getAttribute("aria-modal") === "true") { blocker = n; break; }
    const pos = getComputedStyle(n).position;
    if (pos === "fixed" || pos === "sticky") { blocker = n; break; }
  }
  if (!blocker) return null;
  const name = blocker.getAttribute("aria-label") || (blocker.querySelector("h1,h2,h3,[role=heading]") || {}).textContent || "";
  const what = (h.innerText || h.getAttribute("aria-label") || h.tagName).trim().replace(/\\s+/g, " ").slice(0, 40);
  return (name ? "dialog " + JSON.stringify(name.trim().slice(0, 40)) + ": " : "an overlay: ") + what;
}`;
const FILE_FN = `function () {
  if (this.type === "file") return this;
  if (this.control && this.control.type === "file") return this.control;
  const inner = this.querySelector && this.querySelector("input[type=file]"); if (inner) return inner;
  const lab = this.closest && this.closest("label"); if (lab && lab.control && lab.control.type === "file") return lab.control;
  const all = document.querySelectorAll("input[type=file]"); return all.length === 1 ? all[0] : null;
}`;

export class BoxIO implements PerceptionIO {
  private page: CdpPage | null = null;
  private primed = new WeakSet<CdpPage>();
  constructor(private d: BoxIoDeps) {}

  sleep(ms: number) { return this.d.sleep(ms); }
  now() { return this.d.now(); }

  async xdotool(args: string[]): Promise<void> {
    const r = await this.d.exec("xdotool", args, { env: { DISPLAY: this.d.xenv.display, XAUTHORITY: this.d.xenv.xauthority }, timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`xdotool ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 200)}`);
  }

  private async activeX(): Promise<ActiveX | null> {
    const env = { DISPLAY: this.d.xenv.display, XAUTHORITY: this.d.xenv.xauthority };
    const a = await this.d.exec("xdotool", ["getactivewindow", "getwindowname", "getwindowgeometry", "--shell"], { env, timeoutMs: 5_000 });
    if (a.code !== 0) return null;
    const out = a.stdout.toString("utf8");
    const wid = /^WINDOW=(\d+)/m.exec(out)?.[1];
    const p = wid ? await this.d.exec("xprop", ["-id", wid, "WM_CLASS"], { env, timeoutMs: 5_000 }) : null;
    return parseActiveWindow(out, p?.stdout.toString("utf8") ?? "");
  }

  private async visiblePage(title: string): Promise<CdpPage | null> {
    const pages = (await (await this.d.browser()).pages()).filter((p) => !p.closed());
    const infos = await Promise.all(pages.map(async (p) => ({ p, i: await p.evaluate<{ vis: string; title: string }>("({ vis: document.visibilityState, title: document.title })").catch(() => null) })));
    const vis = infos.filter((x) => x.i?.vis === "visible");
    return (vis.find((x) => title.startsWith(`${x.i!.title} - `)) ?? vis[0])?.p ?? null;
  }

  async read(): Promise<RawScreen> {
    const at = this.d.now();
    const active = await this.activeX();
    const isChromePage = !!active && /chrom/i.test(active.cls) && / - Chromium$/.test(active.title);
    if (isChromePage) {
      const page = await this.visiblePage(active!.title);
      if (page) {
        this.page = page;
        if (!this.primed.has(page)) {
          // The lab's upload failure: a native file chooser the tree can't see. Intercept it; Act upload attaches files.
          await page.send("Page.enable").catch(() => {});
          await page.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
          this.primed.add(page);
        }
        const [info, ax, snap] = await Promise.all([
          page.evaluate<PageInfo>(PAGE_INFO_JS),
          page.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree"),
          page.send<DomSnapshot>("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
        ]);
        const w = webFromCdp({ targetId: page.targetId, ax: ax.nodes, snap, info, win: active!.b });
        return { at, windows: [w.win], els: w.els, page: w.page };
      }
    }
    this.page = null;
    const d = deskFromHelper(await this.d.atspi().catch(() => null), active);
    return { at, windows: d.windows, els: d.els, ...(d.noA11y ? { noA11y: d.noA11y } : {}) };
  }

  crop = {
    rgb: (b: Box) => grabRgb(this.d.exec, this.d.xenv, b),
    webp: (b: Box) => grabWebp(this.d.exec, this.d.xenv, b),
    ocr: (b: Box) => ocrRegion(this.d.exec, this.d.xenv, b),
  };

  private async onNode<T>(ref: number, fn: string, args: unknown[], byValue = true): Promise<{ value?: T; objectId?: string }> {
    const p = this.page;
    if (!p) throw new Error("No page is on screen.");
    const { object } = await p.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: ref });
    const r = await p.send<{ result: { value?: T; objectId?: string; subtype?: string } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: byValue });
    return r.result.subtype === "null" ? {} : r.result;
  }

  get web(): PerceptionIO["web"] {
    if (!this.page) return null;
    return {
      scrollIntoView: async (ref) => { await this.page!.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }); },
      coveredBy: async (ref, pt) => {
        const o = await this.page!.evaluate<{ ox: number; oy: number }>(PAGE_INFO_JS);
        return ((await this.onNode<string | null>(ref, COVER_FN, [pt.x - o.ox, pt.y - o.oy])).value ?? null);
      },
      fileInput: async (ref) => !!(await this.onNode(ref, FILE_FN, [], false)).objectId,
      setFiles: async (ref, files) => {
        const r = await this.onNode(ref, FILE_FN, [], false);
        if (!r.objectId) return false;
        await this.page!.send("DOM.setFileInputFiles", { objectId: r.objectId, files });
        return true;
      },
    };
  }
}
