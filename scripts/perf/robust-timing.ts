/**
 * Load-robust timing for budgets (battle plan 5.9). The Mac these run on is often busy with other agents, so a
 * wall-clock p95 flakes: a burst of someone else's CPU lands inside a 1 ms measurement and doubles it. Two tools
 * keep a budget honest without that noise:
 *
 *   - THREAD CPU TIME (`process.threadCpuUsage`): the CPU this thread actually spent. Another process taking the
 *     core pauses the clock rather than inflating it, so a budget on CPU time catches a real regression (more work)
 *     and ignores load. It cannot see time spent blocked (sync I/O, a lock), so the wall clock stays as a check too.
 *   - CALIBRATION: a fixed reference workload timed now, on this machine, under this load. Its wall/CPU ratio is how
 *     much the machine is stretching wall time right now (`load`), so a wall budget scales with the machine instead
 *     of assuming an idle one.
 *
 * Used by `npm run journeys` (scripts/journeys) and by the timing tests (host/test/perf/tool-loop-budget,
 * shared/test/feedback-content), so every budget in the repo is judged the same way.
 */

/** CPU time (user + system) this thread has used, in ms. */
export function threadCpuMs(): number {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
}

/** The value at quantile q (0..1) of an unsorted list; NaN when empty. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] as number;
}
export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

export interface Timed { wallMs: number; cpuMs: number }

/** Wall and thread-CPU time of one call (sync or async). */
export async function timed(fn: () => unknown): Promise<Timed> {
  const c0 = threadCpuMs();
  const t0 = performance.now();
  await fn();
  return { wallMs: performance.now() - t0, cpuMs: threadCpuMs() - c0 };
}
/** The same, synchronous: no microtask boundary inside the measurement. */
export function timedSync(fn: () => unknown): Timed {
  const c0 = threadCpuMs();
  const t0 = performance.now();
  fn();
  return { wallMs: performance.now() - t0, cpuMs: threadCpuMs() - c0 };
}

/** The reference workload: string building, JSON and a sort, ~10 ms of CPU on an M-series core. Deterministic. */
function reference(): number {
  let acc = 0;
  const rows: { id: number; name: string; v: number }[] = [];
  for (let i = 0; i < 6000; i++) rows.push({ id: i, name: `row-${(i * 7919) % 6000}`, v: (i * 2654435761) % 1000 });
  for (let k = 0; k < 4; k++) {
    const back = JSON.parse(JSON.stringify(rows)) as typeof rows;
    back.sort((a, b) => a.name.localeCompare(b.name));
    acc += back[k]!.v;
  }
  return acc;
}

export interface Calibration {
  /** Median wall time of the reference workload, ms. */
  wallMs: number;
  /** Median thread CPU time of the same, ms: the machine's speed with load taken out. */
  cpuMs: number;
  /** wallMs / cpuMs, at least 1: how much wall time is stretched right now by other processes. */
  load: number;
}

/** Time the reference workload `runs` times (after one warm-up) and take medians. ~0.2 s at the default. */
export function calibrate(runs = 15): Calibration {
  reference();
  const walls: number[] = [];
  const cpus: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = timedSync(reference);
    walls.push(t.wallMs);
    cpus.push(t.cpuMs);
  }
  const wallMs = median(walls);
  const cpuMs = median(cpus);
  return { wallMs, cpuMs, load: Math.max(1, cpuMs > 0 ? wallMs / cpuMs : 1) };
}

/**
 * A wall-clock budget stretched by the current load, capped so a regression can't hide behind a pathological
 * machine: at `maxStretch` load the budget stops growing and the check fails honestly.
 */
export function loadScaledBudget(budgetMs: number, cal: Calibration, maxStretch = 4): number {
  return budgetMs * Math.min(maxStretch, cal.load);
}
