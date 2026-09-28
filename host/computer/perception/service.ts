import type { BotToolResult } from "../../brain/types";
import { colourBlobs, colourWords, rankLines } from "./vision";
import {
  IdRegistry, SCREEN_H, SCREEN_W, center, diffScreens, onScreen, parseRegion, parseTarget, renderScreen, signature, withIds,
  type Box, type El, type RawScreen, type Screen, type Win,
} from "./model";

/** What the service needs from the box: one read of the whole display, real input, and cropped pixels. */
export interface PerceptionIO {
  read(): Promise<RawScreen>;
  xdotool(args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  crop: { rgb(b: Box): Promise<Buffer>; webp(b: Box): Promise<Buffer>; ocr(b: Box): Promise<string[]> };
  /** Chromium page helpers over CDP (present when a page is on screen). */
  web: {
    scrollIntoView(ref: number): Promise<void>;
    /** null when the element (or its label) is what a click at `pt` would hit; else a short label of what covers it. */
    coveredBy(ref: number, pt: { x: number; y: number }): Promise<string | null>;
    fileInput(ref: number): Promise<boolean>;
    setFiles(ref: number, files: string[]): Promise<boolean>;
  } | null;
}

export const ACT_KINDS = ["click", "double", "right", "hover", "type", "key", "scroll", "drag", "select", "upload"] as const;
export type ActKind = (typeof ACT_KINDS)[number];
export interface ActInput { do: ActKind; on?: string; text?: string; to?: string }

export const PERCEPTION = { settleFirstMs: 150, pollMs: 250, quietMs: 500, settleMaxMs: 5_000, maxLines: 150, maxAdded: 12, maxRemoved: 6, textMax: 2_000 } as const;

const q = (s: string) => JSON.stringify(s);
const POINTER: ReadonlySet<ActKind> = new Set(["click", "double", "right", "hover", "drag", "select"]);
const SINGLE_LINE = new Set(["textbox", "searchbox", "combobox", "text", "entry", "password text", "spinbutton", "spin button"]);
const OPTION_ROLES = new Set(["option", "menuitem", "menu item", "menuitemradio", "menuitemcheckbox", "radio menu item", "check menu item", "listitem", "list item", "table cell", "treeitem", "radio"]);
const VISUAL_ROLES = new Set(["canvas", "image", "img", "graphic", "figure", "icon", "drawing area"]);
const CELL_ROLES = new Set(["cell", "gridcell", "rowheader", "columnheader", "table cell", "column header", "row header"]);
const HEADER_ROLES = new Set(["columnheader", "column header"]);
const VISUAL_WORDS = /\b(chart|graph|plot|canvas|image|picture|photo|diagram|map|drawing|figure|game|board)\b/i;
const STOP = new Set(["the", "what", "does", "say", "says", "for", "and", "with", "this", "that", "there", "where", "which", "show", "find", "click", "button", "value", "read", "text", "about", "from", "into", "have", "has"]);
const CHOOSER_ROLES = new Set(["file chooser", "filechooser"]);

type Result = BotToolResult;
const err = (text: string): Result => ({ text, isError: true });
const img = (webp: Buffer): NonNullable<Result["images"]> => [{ data: webp.toString("base64"), mimeType: "image/webp" }];
const label = (e: El) => `${e.id} ${e.role}${e.name ? ` ${q(e.name)}` : ""}`;
const area = (b: Box) => b.w * b.h;
const inside = (b: Box, p: { x: number; y: number }) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
const noA11yLine = (w: Win) => `Window ${q(w.title || w.app || "untitled")} exposes no accessibility info: attached a cropped screenshot (${w.b.w}×${w.b.h} at ${w.b.x},${w.b.y}).`;

/**
 * One per display (per Bot). Keeps the live model (stable ids, last-reported state), resolves ids to coordinates,
 * acts with REAL xdotool input, waits locally until the UI settles, and returns only what changed.
 */
export class PerceptionService {
  private reg = new IdRegistry();
  private lastReported: Screen | null = null;
  private lastSeen = new Map<string, El>();
  private watchSeen: Screen | null = null;
  private events: { line: string; at: number }[] = [];
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCall = 0;

  constructor(private o: { io: PerceptionIO; watchMs?: number; watchIdleMs?: number }) {}

  private async read(): Promise<Screen> {
    const s = withIds(await this.o.io.read(), this.reg);
    for (const e of s.els) this.lastSeen.set(e.id, e);
    return s;
  }

  /** Important changes since the last tool result: from the watch timer, plus whatever the fresh read shows. */
  private meanwhile(fresh: Screen): string[] {
    const now = this.o.io.now();
    const out = this.events.map((e) => `${e.line} (${Math.max(0, Math.round((now - e.at) / 1000))} s ago)`);
    const base = this.watchSeen ?? this.lastReported;
    if (base) for (const l of diffScreens(base, fresh, { maxAdded: 0, maxRemoved: 0 }).important) out.push(l);
    this.events = [];
    this.watchSeen = null;
    return out;
  }

  private report(s: Screen): void {
    this.lastReported = s;
    this.lastCall = this.o.io.now();
    this.ensureWatch();
  }

  /** The service's own timer: cheap polling while the Bot is using the screen, stopped when idle. */
  private ensureWatch(): void {
    const every = this.o.watchMs ?? 2_000;
    if (!every || this.timer) return;
    this.timer = setInterval(() => void this.watchTick(), every);
    this.timer.unref?.();
  }

  async watchTick(): Promise<void> {
    if (this.busy || !this.lastReported) return;
    if (this.o.io.now() - this.lastCall > (this.o.watchIdleMs ?? 60_000)) { this.stop(); return; }
    this.busy = true;
    try {
      const cur = await this.read();
      const d = diffScreens(this.watchSeen ?? this.lastReported, cur, { maxAdded: 0, maxRemoved: 0 });
      for (const line of d.important) this.events.push({ line, at: this.o.io.now() });
      this.watchSeen = cur;
    } catch { /* the next tool call reads for itself */ } finally {
      this.busy = false;
    }
  }

  /** The last-seen label of an id (for Auto-review cards), or null. */
  describe(id: string): string | null {
    const e = this.lastSeen.get(id);
    return e ? `${e.role}${e.name ? ` ${q(e.name)}` : ""}` : null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // ---- Look ----

  look(query?: string): Promise<Result> {
    return this.withBusy(async () => {
      const s = await this.read();
      const pre = this.meanwhile(s);
      const head = pre.length ? [`since your last call: ${pre.join("; ")}`] : [];
      let body: Result;
      if (query?.trim()) body = await this.answer(s, query.trim());
      else {
        const lines = [renderScreen(s, { maxLines: PERCEPTION.maxLines })];
        let images: Result["images"];
        if (s.noA11y) { lines.push(noA11yLine(s.noA11y)); images = img(await this.o.io.crop.webp(s.noA11y.b)); }
        body = { text: lines.join("\n"), ...(images ? { images } : {}) };
      }
      this.report(s);
      return { ...body, text: [...head, body.text].join("\n") };
    });
  }

  private activeBox(s: Screen): Box {
    const w = s.windows.find((x) => x.active);
    return w ? clampToScreen(w.b) : { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };
  }

  private async answer(s: Screen, query: string): Promise<Result> {
    const byId = /\b(e\d+)\b/.exec(query)?.[1];
    const scoped = byId ? s.els.find((e) => e.id === byId) : undefined;
    if (byId && !scoped) return err(`Unknown element ${byId}. Use an id from Look.`);
    const colours = colourWords(query);
    const visual = !scoped && VISUAL_WORDS.test(query)
      ? s.els.filter((e) => VISUAL_ROLES.has(e.role) && onScreen(e.b)).sort((a, b) => area(b.b) - area(a.b))[0]
      : undefined;
    const regionEl = scoped ?? visual;
    const region = regionEl ? clampToScreen(regionEl.b) : this.activeBox(s);
    const where = regionEl ? label(regionEl) : "the active window";

    if (colours.length) {
      const rgb = await this.o.io.crop.rgb(region);
      const parts: string[] = [];
      for (const c of colours) {
        const blobs = colourBlobs(rgb, region, c, { minArea: 36 }).slice(0, 3);
        if (!blobs.length) { parts.push(`no ${c} found in ${where}`); continue; }
        for (const b of blobs) {
          const mid = center(b.b);
          const host = s.els.filter((e) => inside(e.b, mid)).sort((a, z) => area(a.b) - area(z.b))[0];
          parts.push(`${c}: ${b.b.w}×${b.b.h} at ${b.b.x},${b.b.y} (centre ${mid.x},${mid.y})${host ? ` in ${label(host)}` : ""}`);
        }
      }
      return { text: parts.join("; ") };
    }

    if (!regionEl) {
      const hits = this.nameHits(s, query);
      if (hits) return { text: hits };
    }
    const lines = rankLines(await this.o.io.crop.ocr(region), query).slice(0, 12);
    const joined = lines.map((l) => q(l)).join(" · ");
    return { text: lines.length ? `text in ${where}: ${joined.length > 900 ? `${joined.slice(0, 899)}…` : joined}` : `no readable text in ${where}` };
  }

  /** Elements whose name/value share the most query words; table cells bring the rest of their row. */
  private nameHits(s: Screen, query: string): string | null {
    const words = (query.toLowerCase().match(/[a-z0-9$.,@-]+/g) ?? []).map((w) => w.replace(/[.,]+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w));
    if (!words.length) return null;
    const scored = s.els.map((e) => ({ e, n: words.filter((w) => `${e.name} ${e.value ?? ""}`.toLowerCase().includes(w)).length })).filter((x) => x.n > 0);
    if (!scored.length) return null;
    const best = Math.max(...scored.map((x) => x.n));
    const hits = scored.filter((x) => x.n === best).map((x) => x.e);
    const rows: El[][] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      const row = CELL_ROLES.has(h.role)
        ? s.els.filter((e) => CELL_ROLES.has(e.role) && e.win === h.win && Math.abs(center(e.b).y - center(h.b).y) < Math.max(2, Math.min(e.b.h, h.b.h) / 2)).sort((a, b) => a.b.x - b.b.x)
        : [h];
      for (const e of row) seen.add(e.id);
      rows.push(row);
    }
    const isHeader = (r: El[]) => r.every((e) => HEADER_ROLES.has(e.role));
    const ordered = [...rows.filter((r) => !isHeader(r)), ...rows.filter(isHeader)].slice(0, 12);
    return ordered.map((r) => r.map(label).join(" | ")).join("\n");
  }

  // ---- Screenshot ----

  screenshot(region?: string): Promise<Result> {
    return this.withBusy(async () => {
      let b: Box | null = { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };
      if (region?.trim()) {
        const t = parseTarget(region);
        if (t && "id" in t) {
          const s = await this.read();
          const e = s.els.find((x) => x.id === t.id);
          if (!e) return err(`Unknown element ${t.id}. Use an id from Look.`);
          b = clampToScreen(e.b);
        } else b = parseRegion(region);
        if (!b) return err('region must be "x,y,w,h" inside the 1280×800 screen, or an element id.');
      }
      const webp = await this.o.io.crop.webp(b);
      return { text: `Screenshot ${b.w}×${b.h} at ${b.x},${b.y}.`, images: img(webp) };
    });
  }

  // ---- Act ----

  act(a: ActInput): Promise<Result> {
    const bad = validate(a);
    if (bad) return Promise.resolve(err(bad));
    return this.withBusy(() => this.actInner(a));
  }

  private async point(s: Screen, on: string, kind: ActKind): Promise<{ x: number; y: number; el?: El } | Result> {
    const t = parseTarget(on)!;
    if ("x" in t) return t;
    let e = s.els.find((x) => x.id === t.id);
    if (!e) {
      const was = this.lastSeen.get(t.id);
      return err(was ? `${t.id} (${was.role}${was.name ? ` ${q(was.name)}` : ""}) is no longer on screen. Look again.` : `Unknown element ${t.id}. Use an id from Look.`);
    }
    const web = e.src === "web" && e.ref !== undefined ? this.o.io.web : null;
    if (!onScreen(e.b) || (web && (e.b.y < 0 || e.b.y + e.b.h > SCREEN_H))) {
      if (!web) return err(`${t.id} is off-screen. Scroll to it first.`);
      await web.scrollIntoView(e.ref!);
      const again = await this.read();
      const moved = again.els.find((x) => x.id === t.id);
      if (!moved || !onScreen(moved.b)) return err(`${t.id} could not be scrolled into view.`);
      e = moved;
    }
    const p = center(e.b);
    if (web && POINTER.has(kind)) {
      const cover = await web.coveredBy(e.ref!, p);
      if (cover) return err(`${t.id} is covered by ${cover}. Deal with that first.`);
    }
    return { ...p, el: e };
  }

  private async click(p: { x: number; y: number }, button: 1 | 3 = 1, count = 1): Promise<void> {
    await this.o.io.xdotool(["mousemove", "--sync", String(p.x), String(p.y)]);
    await this.o.io.xdotool(["click", "--repeat", String(count), "--delay", "80", String(button)]);
  }
  private key(k: string): Promise<void> { return this.o.io.xdotool(["key", "--clearmodifiers", "--", ...k.trim().split(/\s+/)]); }
  private type(t: string): Promise<void> { return this.o.io.xdotool(["type", "--delay", "12", "--", t]); }

  private async settle(): Promise<{ s: Screen; settled: boolean }> {
    const io = this.o.io;
    const start = io.now();
    await io.sleep(PERCEPTION.settleFirstMs);
    let raw = await io.read();
    let sig = signature(raw);
    let quiet = 0;
    while (io.now() - start < PERCEPTION.settleMaxMs) {
      await io.sleep(PERCEPTION.pollMs);
      const next = await io.read();
      const ns = signature(next);
      if (ns === sig && !next.page?.loading) quiet += PERCEPTION.pollMs; else quiet = 0;
      raw = next;
      sig = ns;
      if (quiet >= PERCEPTION.quietMs) return { s: this.adopt(raw), settled: true };
    }
    return { s: this.adopt(raw), settled: false };
  }

  private adopt(raw: RawScreen): Screen {
    const s = withIds(raw, this.reg);
    for (const e of s.els) this.lastSeen.set(e.id, e);
    return s;
  }

  private async actInner(a: ActInput): Promise<Result> {
    const io = this.o.io;
    const before = await this.read();
    const pre = this.meanwhile(before);
    const notes: string[] = [];
    let target: { x: number; y: number; el?: El } | null = null;
    if (a.on !== undefined && a.do !== "upload") {
      const r = await this.point(before, a.on, a.do);
      if ("text" in r) { this.report(before); return r; }
      target = r;
    }

    switch (a.do) {
      case "click": case "double": case "right":
        await this.click(target!, a.do === "right" ? 3 : 1, a.do === "double" ? 2 : 1);
        if (target!.el?.src === "web" && target!.el.ref !== undefined && io.web && (await io.web.fileInput(target!.el.ref))) {
          notes.push(`${target!.el.id} opens a file chooser: use do "upload" on ${target!.el.id} with text = the file path.`);
        }
        break;
      case "hover":
        await io.xdotool(["mousemove", "--sync", String(target!.x), String(target!.y)]);
        break;
      case "type": {
        const e = target?.el;
        if (target && !e?.states.includes("focused")) await this.click(target);
        if (e && SINGLE_LINE.has(e.role) && !e.states.includes("multiline") && (e.value ?? "") !== "") await this.key("ctrl+a");
        await this.type(a.text!);
        break;
      }
      case "key":
        await this.key(a.text!);
        break;
      case "scroll": {
        const m = /^(up|down|left|right)?\s*(\d+)?$/i.exec((a.text ?? "down").trim());
        const dir = (m?.[1] ?? "down").toLowerCase() as "up" | "down" | "left" | "right";
        const n = Math.min(Math.max(Number(m?.[2] ?? 3), 1), 25);
        const at = target ?? center(this.activeBox(before));
        await io.xdotool(["mousemove", "--sync", String(at.x), String(at.y)]);
        await io.xdotool(["click", "--repeat", String(n), "--delay", "40", { up: "4", down: "5", left: "6", right: "7" }[dir]]);
        break;
      }
      case "drag": {
        const to = await this.point(before, a.to!, "hover");
        if ("text" in to) { this.report(before); return to; }
        const from = target!;
        await io.xdotool(["mousemove", "--sync", String(from.x), String(from.y)]);
        await io.xdotool(["mousedown", "1"]);
        await io.sleep(80);
        await io.xdotool(["mousemove", "--sync", String(from.x + 6), String(from.y + 6)]); // past the drag threshold
        const steps = 6;
        for (let i = 1; i < steps; i++) {
          await io.xdotool(["mousemove", "--sync", String(Math.round(from.x + ((to.x - from.x) * i) / steps)), String(Math.round(from.y + ((to.y - from.y) * i) / steps))]);
          await io.sleep(30);
        }
        await io.xdotool(["mousemove", "--sync", String(to.x), String(to.y)]);
        await io.sleep(120);
        await io.xdotool(["mouseup", "1"]);
        break;
      }
      case "select": {
        await this.click(target!);
        const open = await this.settle();
        const want = a.text!.trim().toLowerCase();
        const opts = open.s.els.filter((e) => OPTION_ROLES.has(e.role) && onScreen(e.b) && e.id !== target!.el?.id);
        const opt = opts.find((e) => e.name.trim().toLowerCase() === want) ?? opts.find((e) => e.name.toLowerCase().includes(want));
        if (opt) await this.click(center(opt.b));
        else { await this.type(a.text!); await this.key("Return"); }
        break;
      }
      case "upload": {
        const files = a.text!.split("\n").map((f) => f.trim()).filter(Boolean);
        const t = a.on ? parseTarget(a.on) : null;
        const el = t && "id" in t ? before.els.find((e) => e.id === t.id) : undefined;
        if (a.on && t && "id" in t && !el) return err(`Unknown element ${t.id}. Use an id from Look.`);
        if (el?.src === "web" && el.ref !== undefined && io.web && (await io.web.fileInput(el.ref))) {
          if (!(await io.web.setFiles(el.ref, files))) return err(`Could not attach ${files.join(", ")} to ${el.id}.`);
          notes.push(`attached ${files.join(", ")} to ${el.id}`);
          break;
        }
        const active = before.windows.find((w) => w.active);
        if (active && (CHOOSER_ROLES.has(active.role) || (active.src === "desk" && /\b(open|save|upload|choose|select)\b.*\bfile|file\s+upload|save as|open file/i.test(active.title)))) {
          await this.key("ctrl+l");
          await this.type(files[0]!);
          await this.key("Return");
          break;
        }
        this.report(before);
        return err("No file input or file chooser here. Give on = the page's file input (from Look), or open the app's Open/Save dialog first.");
      }
    }

    const done = await this.settle();
    const d = diffScreens(before, done.s, { maxAdded: PERCEPTION.maxAdded, maxRemoved: PERCEPTION.maxRemoved });
    const lines = [...(pre.length ? [`since your last call: ${pre.join("; ")}`] : []), ...(d.changed ? d.lines : ["no visible change"]), ...notes];
    let images: Result["images"];
    if (done.s.noA11y) { lines.push(noA11yLine(done.s.noA11y)); images = img(await io.crop.webp(done.s.noA11y.b)); }
    lines.push(done.settled ? "settled" : `still changing after ${PERCEPTION.settleMaxMs / 1000} s (Look again to see where it ends)`);
    this.report(done.s);
    return { text: lines.join("\n"), ...(images ? { images } : {}) };
  }
}

function clampToScreen(b: Box): Box {
  const x = Math.max(0, Math.min(SCREEN_W - 2, Math.round(b.x)));
  const y = Math.max(0, Math.min(SCREEN_H - 2, Math.round(b.y)));
  return { x, y, w: Math.max(2, Math.min(SCREEN_W - x, Math.round(b.x + b.w) - x)), h: Math.max(2, Math.min(SCREEN_H - y, Math.round(b.y + b.h) - y)) };
}

export function validate(a: ActInput): string | null {
  if (!(ACT_KINDS as readonly string[]).includes(a.do)) return `do must be one of ${ACT_KINDS.join(", ")}.`;
  const needsOn: ReadonlySet<ActKind> = new Set(["click", "double", "right", "hover", "drag", "select"]);
  if (needsOn.has(a.do) && !a.on) return `${a.do} needs on: an element id from Look (e.g. e12) or "x,y".`;
  for (const t of [a.on, a.to]) {
    if (t === undefined) continue;
    const p = parseTarget(t);
    if (!p) return 'on/to must be an element id from Look (e.g. e12) or "x,y".';
    if ("x" in p && (p.x >= SCREEN_W || p.y >= SCREEN_H)) return "Points must be inside the 1280×800 screen.";
  }
  if ((a.do === "type" || a.do === "key" || a.do === "select" || a.do === "upload") && !a.text) return `${a.do} needs text.`;
  if (a.do === "drag" && !a.to) return 'drag needs to: an element id or "x,y".';
  if ((a.text ?? "").length > PERCEPTION.textMax) return "text can be at most 2,000 characters.";
  return null;
}
