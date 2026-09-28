/**
 * Portable install: the first-run setup screen's state, as a pure function of what the Mac reports, so
 * the screen and its tests agree on every step's state. Required steps: OrbStack → the Bots' computer →
 * Claude. Voices, phone access and GitHub updates are optional and never block finishing.
 */
export type SetupStepId = "orbstack" | "computer" | "claude" | "voices" | "phone" | "updates";
/** done · doing (the app is working on it) · needs-you (a button to press) · waiting (an earlier step first) · optional */
export type SetupStepState = "done" | "doing" | "needs-you" | "waiting" | "optional";

export interface OrbReport { app: boolean; cli: boolean; status: "running" | "starting" | "stopped" | "unknown" }
export interface BoxReport { phase: "idle" | "running" | "failed" | "ready" | "cancelled"; progress: number; error: string | null }

export interface SetupInput {
  orb: OrbReport;
  box: BoxReport;
  /** The app has a live connection to the host on the Bots' computer. */
  connected: boolean;
  /** Claude sign-in: null while it is being checked. */
  signedIn: boolean | null;
}

export interface SetupView {
  steps: Record<SetupStepId, SetupStepState>;
  /** The first required step that isn't done, or "finished". */
  current: SetupStepId | "finished";
  /** OrbStack's button: download it, or start the installed copy. */
  orbAction: "get" | "start" | null;
  /** Start setting up the Bots' computer now (OrbStack is running and nothing has run yet). */
  startBox: boolean;
  complete: boolean;
}

export function setupView(i: SetupInput): SetupView {
  const installed = i.orb.app || i.orb.cli;
  const orbstack: SetupStepState = !installed ? "needs-you" : i.orb.status === "running" ? "done" : i.orb.status === "starting" ? "doing" : "needs-you";
  const orbAction = !installed ? "get" : orbstack === "needs-you" ? "start" : null;
  let computer: SetupStepState = "waiting";
  if (orbstack === "done") {
    computer = i.box.phase === "ready" ? "done" : i.box.phase === "failed" || i.box.phase === "cancelled" ? "needs-you" : "doing";
  }
  let claude: SetupStepState = "waiting";
  if (computer === "done" && i.connected) claude = i.signedIn === true ? "done" : i.signedIn === false ? "needs-you" : "doing";
  const steps: Record<SetupStepId, SetupStepState> = { orbstack, computer, claude, voices: "optional", phone: "optional", updates: "optional" };
  const required: SetupStepId[] = ["orbstack", "computer", "claude"];
  const current = required.find((s) => steps[s] !== "done") ?? "finished";
  return { steps, current, orbAction, startBox: orbstack === "done" && i.box.phase === "idle", complete: current === "finished" };
}
