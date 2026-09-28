import { describe, expect, it } from "vitest";
import { setupView, type SetupInput } from "../../src/main/setup/state";

// Portable install, first-run setup: each step shows done / doing / needs you, and the screen walks
// OrbStack missing → installed → running → the Bots' computer ready → signed in to Claude.
const base: SetupInput = {
  orb: { app: false, cli: false, status: "unknown" },
  box: { phase: "idle", progress: 0, error: null },
  connected: false,
  signedIn: null,
};

describe("the setup state machine", () => {
  it("OrbStack missing: Get OrbStack is the one thing to do; nothing else starts", () => {
    const v = setupView(base);
    expect(v.steps.orbstack).toBe("needs-you");
    expect(v.orbAction).toBe("get");
    expect(v.steps.computer).toBe("waiting");
    expect(v.steps.claude).toBe("waiting");
    expect(v.current).toBe("orbstack");
    expect(v.startBox).toBe(false);
    expect(v.complete).toBe(false);
  });

  it("installed but not running: Start OrbStack", () => {
    const v = setupView({ ...base, orb: { app: true, cli: true, status: "stopped" } });
    expect(v.steps.orbstack).toBe("needs-you");
    expect(v.orbAction).toBe("start");
    expect(v.startBox).toBe(false);
  });

  it("a CLI without the app still counts as installed", () => {
    expect(setupView({ ...base, orb: { app: false, cli: true, status: "stopped" } }).orbAction).toBe("start");
  });

  it("starting: OrbStack is doing, nothing for the user", () => {
    const v = setupView({ ...base, orb: { app: true, cli: true, status: "starting" } });
    expect(v.steps.orbstack).toBe("doing");
    expect(v.orbAction).toBe(null);
  });

  it("running: the Bots' computer is set up automatically", () => {
    const v = setupView({ ...base, orb: { app: true, cli: true, status: "running" } });
    expect(v.steps.orbstack).toBe("done");
    expect(v.steps.computer).toBe("doing");
    expect(v.startBox).toBe(true);
    expect(v.current).toBe("computer");
    // Once it runs, it is not started twice.
    const running = setupView({ ...base, orb: { app: true, cli: true, status: "running" }, box: { phase: "running", progress: 0.4, error: null } });
    expect(running.steps.computer).toBe("doing");
    expect(running.startBox).toBe(false);
  });

  it("a failed setup needs the user (Retry), and never restarts on its own", () => {
    const v = setupView({ ...base, orb: { app: true, cli: true, status: "running" }, box: { phase: "failed", progress: 0.6, error: "No internet connection." } });
    expect(v.steps.computer).toBe("needs-you");
    expect(v.startBox).toBe(false);
  });

  it("box ready and connected: sign in to Claude", () => {
    const ready = { ...base, orb: { app: true, cli: true, status: "running" as const }, box: { phase: "ready" as const, progress: 1, error: null } };
    expect(setupView({ ...ready, connected: false }).steps.claude).toBe("waiting");
    expect(setupView({ ...ready, connected: true, signedIn: null }).steps.claude).toBe("doing");
    const v = setupView({ ...ready, connected: true, signedIn: false });
    expect(v.steps.computer).toBe("done");
    expect(v.steps.claude).toBe("needs-you");
    expect(v.current).toBe("claude");
    expect(v.complete).toBe(false);
  });

  it("signed in: the required steps are done and the optional ones stay optional", () => {
    const v = setupView({ orb: { app: true, cli: true, status: "running" }, box: { phase: "ready", progress: 1, error: null }, connected: true, signedIn: true });
    expect(v.steps).toMatchObject({ orbstack: "done", computer: "done", claude: "done", voices: "optional", phone: "optional", updates: "optional" });
    expect(v.current).toBe("finished");
    expect(v.complete).toBe(true);
  });

  it("walks the whole way in order", () => {
    const seq: SetupInput[] = [
      base,
      { ...base, orb: { app: true, cli: true, status: "stopped" } },
      { ...base, orb: { app: true, cli: true, status: "running" } },
      { ...base, orb: { app: true, cli: true, status: "running" }, box: { phase: "ready", progress: 1, error: null }, connected: true, signedIn: false },
      { ...base, orb: { app: true, cli: true, status: "running" }, box: { phase: "ready", progress: 1, error: null }, connected: true, signedIn: true },
    ];
    expect(seq.map((i) => setupView(i).current)).toEqual(["orbstack", "orbstack", "computer", "claude", "finished"]);
  });
});
