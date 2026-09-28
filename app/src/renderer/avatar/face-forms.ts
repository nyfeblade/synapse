import { normalizeAvatarShape, type AvatarShape } from "@synapse/shared";

// The Synapse avatar's bodies ("Nodes"): one formula, not a set of
// drawings. Every form is a superellipse |x/a|^n + |y/b|^n = 1 generated here, so nothing is traced
// from anyone. All forms share the face's frame: the same base line (y 86, where squash is anchored),
// the same eye row (y 52) and mouth row (y 67.5), so a face drawn on one fits every other.

export type FaceForm = "pebble" | "orb" | "tile" | "capsule" | "dome" | "gem";
export const FACE_FORMS: readonly FaceForm[] = ["pebble", "orb", "tile", "capsule", "dome", "gem"];

/** The frame every avatar is drawn in (viewBox units): the body (64 x 60) fills ~89% of it, as the
 *  previous avatar's head did, so a 36 px avatar reads the same size. Hops and turns overflow it (the
 *  svg is overflow: visible). */
export const FACE_VIEW_SIZE = 72;
export const FACE_VIEWBOX = `14 20 ${FACE_VIEW_SIZE} ${FACE_VIEW_SIZE}`;
/** The base line: squash and breathing are anchored here, so the body sits on the ground. */
export const BASE_Y = 86;
/** The centre the body turns and tilts about. */
export const PIVOT = [50, 56] as const;

interface FormSpec { a: number; b: number; n: number; cy: number; /** dome: a flatter lower half */ nLow?: number; bLow?: number }
/** The pebble is the chosen default: a 32, b 30, n 2.4, centred (50, 56) — the studies' body. */
export const FORM_SPECS: Record<FaceForm, FormSpec> = {
  pebble: { a: 32, b: 30, n: 2.4, cy: 56 },
  orb: { a: 30, b: 30, n: 2, cy: 56 },
  tile: { a: 30, b: 29, n: 4.2, cy: 57 },
  capsule: { a: 26, b: 31.7, n: 2.6, cy: 54.3 },
  dome: { a: 31, b: 32, n: 2, cy: 58, nLow: 3.6, bLow: 28 },
  gem: { a: 34, b: 32, n: 1.55, cy: 54 },
};

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** The superellipse outline as a closed polyline path (96 points, 2 decimals). */
export function superellipsePath(cx: number, cy: number, a: number, b: number, n: number, N = 96, lower?: { n: number; b: number }): string {
  let d = "";
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), s = Math.sin(t);
    const low = lower && s > 0;
    const nn = low ? lower!.n : n, bb = low ? lower!.b : b;
    const x = cx + a * Math.sign(c) * Math.abs(c) ** (2 / nn);
    const y = cy + bb * Math.sign(s) * Math.abs(s) ** (2 / nn);
    d += (i ? "L" : "M") + n2(x) + " " + n2(y);
  }
  return d + "Z";
}

const paths = new Map<FaceForm, string>();
/** A form's body path (memoised: it never changes). */
export function formPath(form: FaceForm): string {
  let d = paths.get(form);
  if (!d) {
    const f = FORM_SPECS[form];
    d = superellipsePath(50, f.cy, f.a, f.b, f.n, 96, f.nLow ? { n: f.nLow, b: f.bLow! } : undefined);
    paths.set(form, d);
  }
  return d;
}

/** Shape id → form. Deterministic, so every Bot keeps a stable identity. The six editor ids draw the six forms one
 *  each; the others draw the nearest. `pebble` (the default and the fallback everywhere) is the pebble. Bug 292: an id
 *  saved before the rename (normalizeAvatarShape) draws what it drew before. */
export const FORM_OF: Record<AvatarShape, FaceForm> = {
  pebble: "pebble", orb: "orb", tile: "tile", pill: "capsule", dome: "dome", gem: "gem",
  puff: "pebble", bead: "dome", hex: "gem", diamond: "gem", shield: "tile", crescent: "orb",
  petal: "dome", stadium: "capsule", notch: "tile", wave: "pebble",
};
export const formOf = (shape: string): FaceForm => FORM_OF[normalizeAvatarShape(shape) ?? "pebble"];
