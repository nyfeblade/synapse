/** Plain-SVG chart geometry for the usage dashboard: no chart library, just numbers the component draws. */

/** The next "nice" axis maximum at or above v: 1, 2, 2.5, 4, 5 or 10 times a power of ten. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const step = [1, 2, 2.5, 4, 5, 10].find((s) => m <= s + 1e-9) ?? 10;
  return Math.round(step * p * 1e6) / 1e6;
}

export interface BarRect { x: number; y: number; w: number; h: number }

/** Bars across `width`, bottoms on the baseline at `height`; a quarter of each slot is the gap. */
export function barLayout(values: number[], width: number, height: number): { max: number; bars: BarRect[] } {
  const max = niceCeil(Math.max(0, ...values));
  const slot = values.length ? width / values.length : width;
  const gap = Math.min(6, slot * 0.25);
  return {
    max,
    bars: values.map((v, i) => {
      const h = Math.max(0, (v / max) * height);
      return { x: i * slot + gap / 2, y: height - h, w: Math.max(1, slot - gap), h };
    }),
  };
}

/** Axis and tooltip label of a bucket: an hour on the day view, a date otherwise. */
export function bucketLabel(start: number, hourly: boolean): string {
  const d = new Date(start);
  return hourly ? d.toLocaleTimeString(undefined, { hour: "numeric" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
