import type { Exec, XEnv } from "../x-exec";
import type { Box } from "./model";

/**
 * Local "visual asks" for Live perception: colour blobs and OCR on a CROPPED region, answered as text. Nothing here is
 * resident: ffmpeg grabs the crop and tesseract is spawned per ask and exits (the lab measured ~60 MB extra RSS while
 * it runs, 0 at rest). The pixel maths is pure and tested offline.
 */

export const COLOURS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "white", "black", "gray"] as const;
export type Colour = (typeof COLOURS)[number];
const SYNONYMS: Record<string, Colour> = { grey: "gray", violet: "purple", magenta: "pink", teal: "cyan", turquoise: "cyan" };

export function colourName(r: number, g: number, b: number): Colour {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  if (max - min < 32) return l > 0.85 ? "white" : l < 0.18 ? "black" : "gray";
  if (l > 0.95) return "white";
  if (l < 0.08) return "black";
  const d = max - min;
  let h = max === r ? ((g - b) / d) * 60 : max === g ? 120 + ((b - r) / d) * 60 : 240 + ((r - g) / d) * 60;
  if (h < 0) h += 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 200) return "cyan";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

export function colourWords(query: string): Colour[] {
  const out: Colour[] = [];
  for (const w of query.toLowerCase().match(/[a-z]+/g) ?? []) {
    const c = (COLOURS as readonly string[]).includes(w) ? (w as Colour) : SYNONYMS[w];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export interface Blob { colour: Colour; b: Box; area: number }

/** Connected regions of one colour in an rgb24 crop, sampled every `step` px, in SCREEN coordinates, biggest first. */
export function colourBlobs(rgb: Buffer, region: Box, colour: Colour, o: { minArea: number; step?: number; max?: number }): Blob[] {
  const step = o.step ?? 2;
  const gw = Math.ceil(region.w / step);
  const gh = Math.ceil(region.h / step);
  const hit = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = (gy * step * region.w + gx * step) * 3;
      if (i + 2 < rgb.length && colourName(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) === colour) hit[gy * gw + gx] = 1;
    }
  }
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < hit.length; start++) {
    if (hit[start] !== 1) continue;
    let minX = gw, minY = gh, maxX = 0, maxY = 0, n = 0;
    hit[start] = 2;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % gw, y = (p - x) / gw;
      n += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, y > 0 ? p - gw : -1, y < gh - 1 ? p + gw : -1]) {
        if (q >= 0 && hit[q] === 1) { hit[q] = 2; stack.push(q); }
      }
    }
    const area = n * step * step;
    if (area < o.minArea) continue;
    blobs.push({ colour, area, b: { x: region.x + minX * step, y: region.y + minY * step, w: (maxX - minX + 1) * step, h: (maxY - minY + 1) * step } });
  }
  return blobs.sort((a, b) => b.area - a.area).slice(0, o.max ?? 5);
}

export function ocrLines(text: string): string[] {
  return text.split(/\r?\n|\f/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0);
}

const STOP = new Set(["the", "what", "does", "say", "says", "is", "are", "and", "for", "with", "this", "that", "there", "which", "where", "show", "shows", "read", "text"]);
/** Lines that share words with the query first (stable), so the answer leads with what was asked. */
export function rankLines(lines: string[], query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z0-9.]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
  const score = (l: string) => words.filter((w) => l.toLowerCase().includes(w)).length;
  return lines.map((l, i) => ({ l, i, s: score(l) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.l);
}

const grabArgs = (x: XEnv, b: Box) => ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${b.w}x${b.h}`, "-i", `${x.display}+${b.x},${b.y}`, "-frames:v", "1"];
const xe = (x: XEnv) => ({ DISPLAY: x.display, XAUTHORITY: x.xauthority });

export async function grabRgb(exec: Exec, x: XEnv, b: Box): Promise<Buffer> {
  const r = await exec("ffmpeg", [...grabArgs(x, b), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { env: xe(x), timeoutMs: 10_000 });
  if (r.code !== 0 || r.stdout.length < b.w * b.h * 3) throw new Error(`screen crop failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

export async function grabWebp(exec: Exec, x: XEnv, b: Box): Promise<Buffer> {
  const r = await exec("ffmpeg", [...grabArgs(x, b), "-c:v", "libwebp", "-quality", "80", "-f", "webp", "-"], { env: xe(x), timeoutMs: 15_000 });
  if (r.code !== 0 || r.stdout.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error(`screen crop failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

/** OCR of a crop: upscaled 2× grayscale PNG piped to a spawned tesseract (never resident). */
export async function ocrRegion(exec: Exec, x: XEnv, b: Box): Promise<string[]> {
  const png = await exec("ffmpeg", [...grabArgs(x, b), "-vf", "scale=iw*2:ih*2:flags=lanczos,format=gray", "-f", "image2pipe", "-c:v", "png", "-"], { env: xe(x), timeoutMs: 10_000 });
  if (png.code !== 0 || !png.stdout.length) throw new Error(`screen crop failed: ${png.stderr.trim().slice(0, 200)}`);
  const r = await exec("tesseract", ["stdin", "stdout", "--psm", "6", "-l", "eng"], { env: { OMP_THREAD_LIMIT: "1" }, timeoutMs: 20_000, input: png.stdout });
  if (r.code !== 0) throw new Error(r.stderr.trim() ? `OCR failed: ${r.stderr.trim().slice(0, 200)}` : "OCR isn't available on the box (tesseract is not installed).");
  return ocrLines(r.stdout.toString("utf8"));
}
