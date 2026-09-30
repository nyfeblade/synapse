import type { ScreenView } from "@synapse/shared";
import { z } from "zod";
import type { BotToolDef } from "../brain/types";
import type { Box, RawEl, RawScreen, Win } from "./perception/model";
import { onScreen } from "./perception/model";
import { toView } from "./screen-view";
import type { Exec, XEnv } from "./x-exec";

/**
 * Text reads of the screen, for computer subagents whose model can't read images (provider-neutral computer tools).
 * Two sources the box already has: the accessibility tree (AT-SPI for desktop apps, CDP for Chromium pages, through
 * the Live perception reader) and OCR (a spawned tesseract, never resident). Every element and every OCR line comes
 * with a centre point in the model's own coordinate space, so a text-only model can click with the Computer tool.
 */

export interface OcrLine { text: string; b: Box }
export interface ScreenReader {
  /** One read of the windows and elements (the Live perception reader, BoxIO.read). */
  read(): Promise<RawScreen>;
  /** OCR of the whole screen. */
  ocr(): Promise<OcrLine[]>;
}

export const SCREEN_TEXT = { maxElements: 150, maxOcrLines: 80, ocrWhenFewerThan: 6, lineMax: 120 } as const;

const q = (s: string) => JSON.stringify(s.length > SCREEN_TEXT.lineMax ? `${s.slice(0, SCREEN_TEXT.lineMax - 1)}…` : s);
/** A box's centre, in whole pixels (the Computer tool takes integers). */
const mid = (b: Box) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });
const SHOWN = ["focused", "disabled", "checked", "selected", "expanded", "collapsed", "required", "invalid", "readonly"];

/** Tesseract's TSV (level 5 = a word) → one line per text line, box in display pixels (the OCR input was `upscale`×). */
export function parseTesseractTsv(tsv: string, upscale = 1): OcrLine[] {
  const lines = new Map<string, { words: string[]; x1: number; y1: number; x2: number; y2: number }>();
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = (c[11] ?? "").trim();
    const conf = Number(c[10]);
    if (!text || !(conf >= 30)) continue;
    const [l, t, w, h] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    if (![l, t, w, h].every(Number.isFinite)) continue;
    const key = `${c[1]}:${c[2]}:${c[3]}:${c[4]}`;
    const cur = lines.get(key);
    if (!cur) lines.set(key, { words: [text], x1: l, y1: t, x2: l + w, y2: t + h });
    else { cur.words.push(text); cur.x1 = Math.min(cur.x1, l); cur.y1 = Math.min(cur.y1, t); cur.x2 = Math.max(cur.x2, l + w); cur.y2 = Math.max(cur.y2, t + h); }
  }
  return [...lines.values()]
    .map((v) => ({ text: v.words.join(" "), b: { x: Math.round(v.x1 / upscale), y: Math.round(v.y1 / upscale), w: Math.round((v.x2 - v.x1) / upscale), h: Math.round((v.y2 - v.y1) / upscale) } }))
    .filter((l) => /[A-Za-z0-9]/.test(l.text))
    .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
}

/** OCR of the whole display: a 2× grayscale capture piped to a spawned tesseract (as Live perception's crops). */
export async function ocrScreen(exec: Exec, x: XEnv): Promise<OcrLine[]> {
  const env = { DISPLAY: x.display, XAUTHORITY: x.xauthority };
  const png = await exec("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", "1280x800", "-i", x.display, "-frames:v", "1", "-vf", "scale=iw*2:ih*2:flags=lanczos,format=gray", "-f", "image2pipe", "-c:v", "png", "-"], { env, timeoutMs: 10_000 });
  if (png.code !== 0 || !png.stdout.length) throw new Error(`screen capture failed: ${png.stderr.trim().slice(0, 200)}`);
  const r = await exec("tesseract", ["stdin", "stdout", "--psm", "11", "-l", "eng", "tsv"], { env: { OMP_THREAD_LIMIT: "1" }, timeoutMs: 30_000, input: png.stdout });
  if (r.code !== 0) throw new Error(r.stderr.trim() ? `OCR failed: ${r.stderr.trim().slice(0, 200)}` : "OCR isn't available on the computer (tesseract is not installed).");
  return parseTesseractTsv(r.stdout.toString("utf8"), 2);
}

function elLine(e: RawEl, v: ScreenView): string {
  const c = mid(e.b);
  const p = toView(v, c.x, c.y);
  const st = SHOWN.filter((s) => e.states.includes(s));
  const val = e.value !== undefined && e.value !== "" && e.value !== e.name ? ` =${q(e.value)}` : "";
  return `${e.role}${e.name ? ` ${q(e.name)}` : ""}${val}${st.length ? ` ${st.join(",")}` : ""} at (${p.x}, ${p.y})`;
}

function winLine(w: Win, s: RawScreen): string {
  const tags = [w.active ? "active" : "", w.popup ? "popup" : ""].filter(Boolean);
  const page = w.src === "web" && s.page ? ` ${s.page.url}${s.page.loading ? " (loading)" : ""}` : "";
  return `# ${w.src === "web" ? "page" : "window"} ${q(w.title || w.app || "untitled")}${page}${tags.length ? ` [${tags.join(",")}]` : ""}`;
}

/** The text the model gets: windows as headers, the active window's (and popups') elements, then OCR lines. */
export function renderScreenText(s: RawScreen | null, ocr: OcrLine[] | null, v: ScreenView): string {
  const lines: string[] = [];
  let shown = 0;
  if (s) {
    const order = [...s.windows].sort((a, b) => Number(!!b.popup) - Number(!!a.popup) || Number(b.active) - Number(a.active));
    for (const w of order) {
      lines.push(winLine(w, s));
      if (!w.active && !w.popup) continue;
      for (const e of s.els.filter((x) => x.win === w.key && onScreen(x.b))) {
        if (shown >= SCREEN_TEXT.maxElements) break;
        lines.push(elLine(e, v));
        shown += 1;
      }
    }
    if (!s.windows.length) lines.push("(no windows)");
    if (s.noA11y) lines.push(`(the window ${q(s.noA11y.title || s.noA11y.app || "untitled")} exposes no accessibility info)`);
  } else {
    lines.push("(the accessibility tree couldn't be read)");
  }
  if (ocr) {
    lines.push(ocr.length ? "# text on screen (OCR)" : "# text on screen (OCR): none found");
    for (const l of ocr.slice(0, SCREEN_TEXT.maxOcrLines)) {
      const c = mid(l.b);
      const p = toView(v, c.x, c.y);
      lines.push(`${q(l.text)} at (${p.x}, ${p.y})`);
    }
    if (ocr.length > SCREEN_TEXT.maxOcrLines) lines.push(`… ${ocr.length - SCREEN_TEXT.maxOcrLines} more lines`);
  }
  return lines.join("\n");
}

/** Reads the screen as text. OCR runs when asked, or when accessibility shows too little to act on. */
export async function readScreenText(r: ScreenReader, v: ScreenView, o: { ocr?: boolean } = {}): Promise<string> {
  const s = await r.read().catch(() => null);
  const active = s?.windows.find((w) => w.active);
  const few = !s || !!s.noA11y || s.els.filter((e) => (!active || e.win === active.key) && onScreen(e.b)).length < SCREEN_TEXT.ocrWhenFewerThan;
  const wantOcr = o.ocr ?? few;
  let ocr: OcrLine[] | null = null;
  let ocrError: string | null = null;
  if (wantOcr) {
    try { ocr = await r.ocr(); } catch (e) { ocrError = (e as Error).message; }
  }
  const text = renderScreenText(s, ocr, v);
  return ocrError ? `${text}\n(OCR: ${ocrError})` : text;
}

/** ReadScreen: the screen as text, for a computerUse subagent whose model can't read images. */
export function createReadScreenTool(d: { reader(): Promise<ScreenReader>; view: ScreenView }): BotToolDef {
  return {
    name: "ReadScreen",
    description: `Read your screen as text: the active window's elements (role, name, state) and, when asked or when there is little else, the text found by OCR. Each line ends with its centre point "at (x, y)" in the ${d.view.w}×${d.view.h} coordinates the Computer tool uses. Changes nothing.`,
    readOnly: true,
    schema: { ocr: z.boolean().optional() },
    handler: async (a) => {
      try {
        return { text: await readScreenText(await d.reader(), d.view, typeof a.ocr === "boolean" ? { ocr: a.ocr } : {}) };
      } catch (e) {
        return { text: `ReadScreen failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
