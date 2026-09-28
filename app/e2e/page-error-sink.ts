/**
 * The verdict logic behind the e2e page-error guard, with no Playwright import, so it can be driven
 * directly by `app/test/renderer/e2e-page-error-guard.test.ts` instead of only by an Electron run.
 *
 * `page-errors.ts` is the wiring: it attaches these sinks to real windows and returns the verdict in
 * fixture teardown. Read the long WHY there.
 */

export interface Expectation {
  pattern: RegExp;
  why: string;
  required: boolean;
  hits: number;
}

export interface Captured {
  kind: "pageerror" | "console.error";
  message: string;
  /** The `step()`-declared action in flight when it arrived. */
  step: string;
  /** ms since the window was attached — orders errors within a journey. */
  atMs: number;
  /** What the app was showing the instant the error arrived, read from the page itself. */
  surface: Promise<string>;
}

export const NO_STEP = "(no step declared)";

/** A pattern so wide it would excuse anything. An exemption has to name ONE error. */
const BLANKET = new Set(["", ".", ".*", ".+", "[\\s\\S]*", "[\\s\\S]+", "^", "(?:)"]);

export class PageErrors {
  readonly captured: Captured[] = [];
  readonly expectations: Expectation[] = [];
  /**
   * Set when the journey asks the app to quit, or when the window goes away on its own. Recording
   * stops, and the sink retires once it has given its verdict for the test it belonged to.
   *
   * WHY RECORDING STOPS AT SHUTDOWN. Moving the verdict into teardown moved it past `app.close()`,
   * and the renderer's gateway client logs `Failed when connecting: Connection closed (code: 1006)`
   * as its socket dies during a normal quit. That is noise ABOUT the close, not about the journey —
   * it turned `p3-disk` red on the first run of this guard and would have turned others red on
   * whichever run happened to be slow enough. Every assertion this guard replaces ran BEFORE
   * `app.close()`, so this boundary is parity with what the specs already claimed, plus everything
   * that happens before the quit. Widening past the quit is a separate decision with its own triage.
   */
  closed = false;

  constructor(
    readonly label: string,
    private readonly readSurface: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly t0: number = now(),
  ) {}

  /**
   * Declare that this journey provokes this error ON PURPOSE.
   *
   * Scope it to the narrowest pattern that matches the one error and say why — an empty reason, or a
   * pattern wide enough to excuse anything, throws here and is also refused statically by the class
   * guard. By default the expectation is REQUIRED: if the error never arrives, this journey has
   * stopped exercising the thing it was excused for, and that is a finding too. `{ required: false }`
   * is for an error that is genuinely conditional, and `why` has to say what the condition is.
   */
  expect(pattern: RegExp, why: string, opts: { required?: boolean } = {}): this {
    if (!why.trim()) throw new Error(`${this.label}: expect(pattern, why) — \`why\` must say why this error is correct`);
    if (BLANKET.has(pattern.source)) throw new Error(`${this.label}: ${pattern} excuses every error; name the one error this journey provokes`);
    this.expectations.push({ pattern, why, required: opts.required !== false, hits: 0 });
    return this;
  }

  record(kind: Captured["kind"], message: string, step: string): void {
    if (this.closed) return;
    this.captured.push({ kind, message, step, atMs: this.now() - this.t0, surface: this.readSurface() });
  }

  /** Errors seen so far. For a spec that wants to look mid-journey; no verdict depends on anyone calling it. */
  get messages(): string[] {
    return this.captured.map((c) => c.message);
  }

  async verdict(): Promise<string[]> {
    const problems: string[] = [];
    for (const c of this.captured) {
      const match = this.expectations.find((e) => e.pattern.test(c.message));
      if (match) {
        match.hits += 1;
        continue;
      }
      problems.push(
        `${this.label}: unexpected ${c.kind} at +${c.atMs}ms during ${c.step}\n` +
          `    ${c.message.replace(/\s+/g, " ").slice(0, 400)}\n` +
          `    app was showing: ${await c.surface}`,
      );
    }
    for (const e of this.expectations) {
      if (e.required && e.hits === 0) {
        problems.push(
          `${this.label}: the expected error ${e.pattern} never occurred — ${e.why}\n` +
            `    This journey is excused for an error it no longer provokes: either it stopped exercising\n` +
            `    that path (fix the journey) or the error is gone (delete the expectation).`,
        );
      }
    }
    return problems;
  }

  reset(): void {
    this.captured.length = 0;
    this.expectations.length = 0;
  }
}

/** Every sink attached in this worker that has not yet been given a verdict and retired. */
const sinks: PageErrors[] = [];

export function register(sink: PageErrors): void {
  sinks.push(sink);
}

/**
 * The verdict for every live sink, then a clean slate for the next test.
 *
 * Closed windows are done with. An open one — a serial suite sharing a single app across its tests,
 * like the packaged smoke suite — keeps its listeners but starts the next test empty, so an error is
 * reported once, against the test it happened in, and a failure early in a serial file can no longer
 * throw away the error check for everything after it.
 */
export async function settleAll(): Promise<string[]> {
  const problems: string[] = [];
  for (const sink of sinks) problems.push(...(await sink.verdict()));
  for (let i = sinks.length - 1; i >= 0; i--) {
    if (sinks[i]!.closed) sinks.splice(i, 1);
    else sinks[i]!.reset();
  }
  return problems;
}

/** Test-only: the number of sinks still attached. */
export const attachedSinkCount = (): number => sinks.length;
