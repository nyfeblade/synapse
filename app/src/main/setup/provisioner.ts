/**
 * Portable install: "Set up the Bots' computer" — create the OrbStack machine, start it, provision it,
 * deploy the host, connect. Every step first asks whether it is already done, so running this again
 * after a failure, a cancel or a relaunch resumes where it stopped and never recreates what exists.
 * The progress bar is real: each step owns a weight, and a step reports its own fraction as it goes
 * (provision.sh prints `::step n/N` markers). One run at a time; a second Start joins the first.
 */
export type BoxStepId = "create" | "start" | "provision" | "deploy" | "connect";

export interface StepContext {
  line(s: string): void;
  /** This step's own progress, 0..1. */
  progress(f: number): void;
  signal: AbortSignal;
}

export interface BoxStep {
  id: BoxStepId;
  label: string;
  /** Share of the bar (relative; the steps' weights are normalised). */
  weight: number;
  done(): Promise<boolean>;
  run(ctx: StepContext): Promise<void>;
}

export interface ProvisionState {
  phase: "idle" | "running" | "failed" | "ready" | "cancelled";
  step: BoxStepId | null;
  progress: number;
  error: string | null;
  log: string[];
  startedAt: number | null;
  finishedAt: number | null;
  /** Per step, how long it took this run (ms), for the report. */
  timings: Partial<Record<BoxStepId, number>>;
}

const LOG_LINES = 400;

const STEP_NAMES: Record<BoxStepId, string> = {
  create: "creating the Bots' computer",
  start: "starting the Bots' computer",
  provision: "installing the system software",
  deploy: "installing the Bots' software",
  connect: "connecting to the Bots' computer",
};

/** One plain sentence for what went wrong, never a wall of apt output. The raw text stays in the log drawer. */
export function plainError(raw: string, step: BoxStepId): string {
  // Already written for the user (a step's own refusal): pass it through as it is.
  if (/^A machine called /.test(raw)) return raw.split("\n")[0]!;
  const t = raw.toLowerCase();
  if (/could not resolve|temporary failure resolving|network is unreachable|failed to connect to|connection timed out|name or service not known|no route to host|failed to fetch/.test(t)) {
    return "No internet connection reached the Bots' computer. Check your connection and retry.";
  }
  if (/no space left|disk quota|enospc/.test(t)) return "Your Mac is out of disk space. Free up some space and retry.";
  if (/spawn .*orb.* enoent|orb: command not found|orbstack is not running|not running.*orbstack|connect to orbstack/.test(t)) return "OrbStack isn't running. Start OrbStack and retry.";
  if (/could not get lock|dpkg was interrupted|is held by process|unable to acquire the dpkg/.test(t)) return "The Bots' computer was busy finishing an earlier install. Retry in a minute.";
  if (/gateway|\/health|gateway\.json|host did not start/.test(t)) return "The Bots' software didn't start. Retry; if it happens again, open the log.";
  if (/timed out|etimedout|sigterm/.test(t)) return `Setup took too long while ${STEP_NAMES[step]}. Retry.`;
  const last = raw.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return `Setup stopped while ${STEP_NAMES[step]}.${last ? ` ${last.slice(0, 240)}` : ""}`;
}

export class BoxProvisioner {
  private s: ProvisionState = { phase: "idle", step: null, progress: 0, error: null, log: [], startedAt: null, finishedAt: null, timings: {} };
  private running: Promise<ProvisionState> | null = null;
  private abort: AbortController | null = null;

  constructor(private o: { steps: BoxStep[]; publish(s: ProvisionState): void; now?: () => number }) {}

  state(): ProvisionState { return this.s; }

  private now(): number { return (this.o.now ?? Date.now)(); }

  private set(p: Partial<ProvisionState>): void {
    this.s = { ...this.s, ...p };
    this.o.publish(this.s);
  }

  private line(l: string): void {
    const log = this.s.log.length >= LOG_LINES ? this.s.log.slice(-(LOG_LINES - 1)) : this.s.log.slice();
    log.push(l);
    this.s = { ...this.s, log };
  }

  /** Start (or join) a run. Resolves with the final state; never rejects. */
  start(): Promise<ProvisionState> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): void { this.abort?.abort(); }

  private async run(): Promise<ProvisionState> {
    const ac = new AbortController();
    this.abort = ac;
    const total = this.o.steps.reduce((n, s) => n + s.weight, 0) || 1;
    let base = 0;
    let bar = 0;
    const setBar = (f: number) => { bar = Math.max(bar, Math.min(1, f)); };
    this.set({ phase: "running", error: null, startedAt: this.now(), finishedAt: null, timings: {}, progress: this.s.progress && this.s.phase !== "ready" ? this.s.progress : 0 });
    bar = this.s.progress;
    for (const step of this.o.steps) {
      if (ac.signal.aborted) break;
      this.set({ step: step.id });
      let already = false;
      try { already = await step.done(); } catch { already = false; }
      if (!already) {
        const t0 = this.now();
        this.line(`— ${STEP_NAMES[step.id]}`);
        try {
          await step.run({
            signal: ac.signal,
            line: (l) => { this.line(l); this.o.publish(this.s); },
            progress: (f) => { setBar((base + step.weight * Math.max(0, Math.min(1, f))) / total); this.set({ progress: bar }); },
          });
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          if (ac.signal.aborted) break;
          this.line(raw);
          this.set({ phase: "failed", error: plainError(`${raw}\n${this.s.log.slice(-20).join("\n")}`, step.id), progress: bar, finishedAt: this.now() });
          this.abort = null;
          return this.s;
        }
        this.set({ timings: { ...this.s.timings, [step.id]: this.now() - t0 } });
      }
      base += step.weight;
      setBar(base / total);
      this.set({ progress: bar });
    }
    this.abort = null;
    if (ac.signal.aborted) {
      this.set({ phase: "cancelled", error: "Setup was stopped.", finishedAt: this.now() });
      return this.s;
    }
    this.set({ phase: "ready", step: null, progress: 1, error: null, finishedAt: this.now() });
    return this.s;
  }
}
