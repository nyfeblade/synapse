// Bug #100: the avatar's attribute writer. It reads what each element shows now and skips a write
// that would change nothing visible — the same string, geometry that moved less than
// SUBPIXEL_PX, an opacity step below OPACITY_EPS — so a calm avatar's ambient frame touches (and
// invalidates style, layout and paint for) almost nothing. Motion is not lost: the comparison is
// against the last WRITTEN value, so slow drift accumulates until it crosses the threshold.

/** Geometry closer than this to what is already drawn is not rewritten. CSS px. */
export const SUBPIXEL_PX = 0.05;
/** Opacity steps smaller than this are not rewritten (the ends, 0 and 1, always are). */
export const OPACITY_EPS = 0.004;
/** viewBox units a unit change of a transform's non-translate number moves a point: scale acts at the
 *  body's radius (~32 units of the 72-unit frame, face-forms.ts); rotate is in degrees at that radius. */
const SCALE_ARM = 32, DEG_ARM = (32 * Math.PI) / 180;

/** The numbers of an attribute value, each with its arm, and its skeleton (every non-number token). */
function weighted(v: string): { nums: number[]; arms: number[]; skel: string } {
  const nums: number[] = [], arms: number[] = [];
  let skel = "";
  const re = /-?\d*\.?\d+(?:e-?\d+)?|(scale|rotate|translate|[A-Za-z])\(?|\)/g;
  let arm = 1;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const t = m[0];
    if (m[1] !== undefined || t === ")") {
      skel += t;
      arm = m[1] === "scale" ? SCALE_ARM : m[1] === "rotate" ? DEG_ARM : 1;
    } else { nums.push(Number(t)); arms.push(arm); }
  }
  return { nums, arms, skel };
}

/** True when `next` differs from `prev` by more than `eps` viewBox units anywhere, or in structure. */
export function movedBeyond(prev: string, next: string, eps: number): boolean {
  if (prev === next) return false;
  const a = weighted(prev), b = weighted(next);
  if (a.nums.length !== b.nums.length || a.skel !== b.skel) return true;
  for (let i = 0; i < a.nums.length; i++) if (Math.abs(a.nums[i]! - b.nums[i]!) * a.arms[i]! > eps) return true;
  return false;
}

export type Kind = "geo" | "op";
export interface AttrWriter {
  /** Start a frame: `epsUnits` is SUBPIXEL_PX in viewBox units at the avatar's current size. */
  begin(epsUnits: number): void;
  set(el: Element, name: string, value: string, kind?: Kind): void;
}

/** Compares against the DOM itself (not a cache), so a React re-render of the same element can never
 *  leave the writer believing a stale value is on screen. */
export function attrWriter(): AttrWriter {
  let eps = 0;
  return {
    begin(e) { eps = e; },
    set(el, name, value, kind) {
      const prev = el.getAttribute(name);
      if (prev === value) return;
      if (prev !== null && kind === "geo" && !movedBeyond(prev, value, eps)) return;
      if (prev !== null && kind === "op") {
        const a = Number(prev), b = Number(value);
        if (b !== 0 && b !== 1 && Math.abs(a - b) < OPACITY_EPS) return;
      }
      el.setAttribute(name, value);
    },
  };
}
