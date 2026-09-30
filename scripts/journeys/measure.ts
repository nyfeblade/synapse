/**
 * In-app measurement for one journey step (battle plan 5.9).
 *
 * The clock starts at the INPUT: the renderer's own timestamp of the first trusted pointerdown/keydown/input that
 * Playwright delivers (so Playwright's own round trips and actionability checks are not counted). It stops when the
 * awaited state is true at an animation frame, after that frame is painted: what the user sees. Between the two,
 * main-thread long tasks (>= 50 ms) are collected, and the renderer main thread's CPU time is read over CDP
 * (Performance.getMetrics ThreadTime), which, unlike the wall clock, other processes on a busy Mac do not inflate.
 */
import type { CDPSession, Page } from "@playwright/test";
import type { Sample } from "./budgets.ts";

export type { Sample };

/** A DOM state, checked at each animation frame. Every field given must hold. */
export interface Until {
  /** CSS selector that must match a visible (rendered) element. */
  visible?: string;
  /** CSS selector that must match nothing. */
  gone?: string;
  /** The text of `sel` must contain `text` at least `min` times. */
  count?: { sel: string; text: string; min: number };
  /** At least `min` elements match `sel`. */
  atLeast?: { sel: string; min: number };
  /** In the children of `sel`, after the last one whose text contains `anchor`, one contains `text` or matches
   *  (or holds) `match`. Independent of how much history is rendered above. */
  follows?: { sel: string; anchor: string; text?: string; match?: string };
}


/** Runs in the page: arms the clock and the watcher; `window.__journey.done` resolves with the timings. */
function arm(until: Until): void {
  type St = { t0: number | null; long: { s: number; d: number }[]; done?: Promise<unknown> };
  const st: St = { t0: null, long: [] };
  const w = window as unknown as { __journey?: St };
  const onInput = (e: Event) => { if (st.t0 === null && e.isTrusted) st.t0 = e.timeStamp; };
  const evs = ["pointerdown", "mousedown", "keydown", "input"];
  for (const ev of evs) window.addEventListener(ev, onInput, { capture: true });
  let po: PerformanceObserver | null = null;
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push({ s: e.startTime, d: e.duration }); });
    po.observe({ type: "longtask" });
  } catch { /* longtask unsupported: counts stay 0 */ }
  const shown = (el: Element) => (el as HTMLElement).checkVisibility ? (el as HTMLElement).checkVisibility() : (el as HTMLElement).getClientRects().length > 0;
  const holds = (): boolean => {
    if (until.visible && ![...document.querySelectorAll(until.visible)].some(shown)) return false;
    if (until.gone && document.querySelector(until.gone)) return false;
    if (until.count) {
      const text = [...document.querySelectorAll(until.count.sel)].map((e) => e.textContent ?? "").join("\n");
      if (text.split(until.count.text).length - 1 < until.count.min) return false;
    }
    if (until.atLeast && document.querySelectorAll(until.atLeast.sel).length < until.atLeast.min) return false;
    if (until.follows) {
      const f = until.follows;
      const kids = [...(document.querySelector(f.sel)?.children ?? [])];
      let at = -1;
      for (let i = kids.length - 1; i >= 0; i--) if ((kids[i]!.textContent ?? "").includes(f.anchor)) { at = i; break; }
      if (at < 0) return false;
      const hit = kids.slice(at + 1).some((k) => (f.text === undefined || (k.textContent ?? "").includes(f.text)) && (f.match === undefined || k.matches(f.match) || !!k.querySelector(f.match)));
      if (!hit) return false;
    }
    return true;
  };
  // A state that already holds before the input would time nothing: the journey is wrong, say so.
  const already = holds();
  st.done = new Promise((resolve, reject) => {
    if (already) { reject(new Error(`journey: ${JSON.stringify(until)} already holds before the input; pick a state the input creates`)); return; }
    const stop = () => { for (const ev of evs) window.removeEventListener(ev, onInput, { capture: true }); };
    const timer = setTimeout(() => { stop(); po?.disconnect(); reject(new Error(`journey: state never reached ${JSON.stringify(until)} (input seen: ${st.t0 !== null})`)); }, 30_000);
    const tick = () => {
      if (st.t0 !== null && holds()) {
        // This frame paints the state; the message-channel task runs after that paint.
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          const t1 = performance.now();
          clearTimeout(timer); stop();
          // Long tasks are reported a little after they end: take what is queued, then stop observing.
          for (const e of po?.takeRecords() ?? []) st.long.push({ s: e.startTime, d: e.duration });
          po?.disconnect();
          const t0 = st.t0!;
          const long = st.long.filter((x) => x.s + x.d >= t0 && x.s <= t1);
          resolve({ wallMs: t1 - t0, longTasks: long.length, longTaskMs: long.reduce((a, x) => a + x.d, 0) });
        };
        ch.port2.postMessage(0);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  w.__journey = st;
}

export async function threadTimeMs(cdp: CDPSession): Promise<number> {
  const r = await cdp.send("Performance.getMetrics");
  return (r.metrics.find((m) => m.name === "ThreadTime")?.value ?? 0) * 1000;
}

/** Measure one step: `act` performs the real input (click, key press, fill); `until` is the state that ends it. */
export async function step(page: Page, cdp: CDPSession, act: () => Promise<void>, until: Until): Promise<Sample> {
  await page.evaluate(arm, until);
  const c0 = await threadTimeMs(cdp);
  await act();
  const r = (await page.evaluate(() => (window as unknown as { __journey: { done: Promise<unknown> } }).__journey.done)) as Omit<Sample, "cpuMs">;
  const c1 = await threadTimeMs(cdp);
  return { ...r, cpuMs: c1 - c0 };
}

/** For a cold launch: long tasks from navigation start to now (buffered entries). */
export async function longTasksSinceLoad(page: Page): Promise<{ longTasks: number; longTaskMs: number; sinceNavMs: number }> {
  return page.evaluate(() => new Promise<{ longTasks: number; longTaskMs: number; sinceNavMs: number }>((resolve) => {
    const now = performance.now();
    try {
      const po = new PerformanceObserver(() => {});
      po.observe({ type: "longtask", buffered: true });
      // Buffered entries are delivered asynchronously; give them a task to arrive.
      setTimeout(() => {
        const es = po.takeRecords();
        po.disconnect();
        resolve({ longTasks: es.length, longTaskMs: es.reduce((a, e) => a + e.duration, 0), sinceNavMs: now });
      }, 0);
    } catch { resolve({ longTasks: 0, longTaskMs: 0, sinceNavMs: now }); }
  }));
}
