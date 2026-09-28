import type { AsyncTaskView, ComputerActionKind, DiskPressureView, DisplayInfo, ForeverBoxStatus, SseEvent } from "@synapse/shared";
import { create } from "zustand";
import { callQuiet } from "./bridge";

export type DisplaysLoad = "loading" | "ready" | "failed";

export interface ComputerState {
  activity: Record<string, number>;
  cursor: Record<string, { x: number; y: number; kind: ComputerActionKind; at: number }>;
  displays: Record<string, DisplayInfo>;
  /**
   * Bug 36: whether `displays` is an ANSWER or the absence of one. Without this, a failed
   * `getDisplays` and a host that genuinely reports no screen for this Bot are the same empty map,
   * and every screen surface renders the same blank rectangle for both. See screen-absence.ts.
   */
  displaysLoad: DisplaysLoad;
  displaysError: string | null;
  /** Controller ruling 1: Bot ids waiting for a seat while MAX_SCREENS are all in use and none are idle. */
  waiting: string[];
  open: { botId: string } | null;
  disk: DiskPressureView | null;
  box: ForeverBoxStatus | null;
  lifecycle: { phase: string; step: string | null; error: string | null } | null;
  tasks: Record<string, AsyncTaskView[]>;
}

export function initialComputer(): ComputerState {
  return { activity: {}, cursor: {}, displays: {}, displaysLoad: "loading", displaysError: null, waiting: [], open: null, disk: null, box: null, lifecycle: null, tasks: {} };
}

export function applyComputerEvent(s: ComputerState, e: SseEvent, now: number): ComputerState {
  switch (e.channel) {
    case "computer-action": {
      const p = e.payload;
      const prev = s.cursor[p.botId];
      const x = p.x ?? prev?.x ?? 640;
      const y = p.y ?? prev?.y ?? 400;
      return { ...s, activity: { ...s.activity, [p.botId]: now }, cursor: { ...s.cursor, [p.botId]: { x, y, kind: p.kind, at: now } } };
    }
    case "displays":
      // The host's own channel. Publishing one IS an answer, so it heals a failed fetch (bug 36):
      // a screen that appears after a blip lights up without the user touching Retry.
      return { ...s, displays: Object.fromEntries(e.payload.displays.map((d) => [d.botId, d])), waiting: e.payload.waiting, displaysLoad: "ready", displaysError: null };
    case "box-disk-pressure":
      return { ...s, disk: e.payload };
    case "forever-box":
      return { ...s, box: e.payload };
    case "async-tasks":
      return { ...s, tasks: { ...s.tasks, [e.payload.botId]: e.payload.tasks } };
    default:
      return s;
  }
}

interface Actions {
  apply(e: SseEvent): void;
  openComputer(botId: string): void;
  closeComputer(): void;
  setLifecycle(s: ComputerState["lifecycle"]): void;
  setDisk(v: DiskPressureView | null): void;
  setBox(v: ForeverBoxStatus | null): void;
  setDisplaysLoad(load: DisplaysLoad, error?: string | null): void;
}

export const useComputer = create<ComputerState & Actions>((set) => ({
  ...initialComputer(),
  apply: (e) => set((s) => applyComputerEvent(s, e, Date.now())),
  openComputer: (botId) => {
    set({ open: { botId } });
    // Bug 48 / #3: opening Computer is the only user-visible moment that needs a seat.
    // Do not assign on create — MAX_SCREENS is 3, and a Bot that never opens the screen
    // must not consume one. Screens-full is designed, so this is callQuiet: the host
    // publishes `waiting` and the stage already renders "Waiting for a screen".
    void requestDisplay(botId);
  },
  closeComputer: () => set({ open: null }),
  setLifecycle: (lifecycle) => set({ lifecycle }),
  setDisk: (disk) => set({ disk }),
  setBox: (box) => set({ box }),
  setDisplaysLoad: (displaysLoad, error = null) => set({ displaysLoad, displaysError: error }),
}));

/**
 * Which Bots hold a screen on the shared computer (bug 36). The one-shot snapshot; the host's
 * `displays` SSE channel carries every change after it.
 *
 * `callQuiet` is still the right call: this is a background probe fired on every reconnect, and
 * `call()`'s default — the sidebar's role="alert" banner — would put a banner on screen every time
 * the box blips. What was wrong was the trailing `.catch(() => {})` next to it: "no banner" was
 * being used to justify no feedback ANYWHERE, so a failed fetch was invisible in the one place it
 * mattered. The rejection is RECORDED now, and the screen surfaces render it where the screen would
 * have been, with a Retry that calls this again. Quiet, local, actionable.
 */
/** Ask the host for a seat for this Bot. Success merges the display; failure invents nothing. */
export async function requestDisplay(botId: string): Promise<void> {
  try {
    const { display } = await callQuiet("ensureDisplay", { id: botId });
    if (!display) return;
    useComputer.setState((s) => ({
      displays: { ...s.displays, [display.botId]: display },
      waiting: s.waiting.filter((id) => id !== display.botId),
      displaysLoad: "ready",
      displaysError: null,
    }));
  } catch {
    // DisplayFullError (and any other rejection): the host publishes `waiting` over SSE.
    // Inventing a display here is how a 4th Bot used to look like it had a screen (#3).
  }
}

export async function loadDisplays(): Promise<void> {
  useComputer.getState().setDisplaysLoad("loading");
  try {
    const d = await callQuiet("getDisplays", {});
    useComputer.getState().apply({ channel: "displays", payload: d });
  } catch (e) {
    useComputer.getState().setDisplaysLoad("failed", e instanceof Error ? e.message : String(e));
  }
}
