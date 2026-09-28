import { create } from "zustand";
import { nativeCall } from "../native";

/**
 * Portable install: whether the first-run setup screen is showing. "checking" until main answers (the
 * app shows its usual starting state meanwhile, so an existing install never flashes the setup screen),
 * then "setup" or "app". Settings → Setup reopens it over the app.
 */
interface SetupGate {
  gate: "checking" | "setup" | "app";
  reopened: boolean;
  check(): Promise<void>;
  finish(): Promise<void>;
  reopen(): void;
  close(): void;
}

export const useSetupGate = create<SetupGate>((set) => ({
  gate: "checking",
  reopened: false,
  check: async () => {
    try {
      const s = await nativeCall<{ done: boolean }>("setup.done");
      // Only an explicit "not done" shows setup: anything else (an older main, a test double) is the app.
      set({ gate: s?.done === false ? "setup" : "app" });
    } catch {
      // A main process without the setup natives (an older build under test) is simply the app.
      set({ gate: "app" });
    }
  },
  finish: async () => {
    await nativeCall("setup.finish").catch(() => {});
    set({ gate: "app", reopened: false });
  },
  reopen: () => set({ reopened: true }),
  close: () => set({ reopened: false }),
}));
