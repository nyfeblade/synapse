import type { BotSummary, HostSettingsView, RoutineView, SseEvent, TeachState, TeachStatus, TranscriptEntry, Tray } from "@synapse/shared";
import type { ConnectionState } from "./bridge";
import type { AsyncStatus } from "./async-resource";

export type View = { kind: "chat"; botId: string } | { kind: "new-chat" } | { kind: "empty" };

export interface UiState {
  connection: ConnectionState;
  bots: Record<string, BotSummary>;
  activeBotId: string | null;
  pinned: string[];
  view: View;
  transcripts: Record<string, TranscriptEntry[]>;
  typing: Record<string, { typing: boolean; partialText: string | null }>;
  trays: Tray[];
  settings: HostSettingsView | null;
  panel: "details" | "settings" | "memory" | "files" | "routine" | "closed";
  settingsOpen: boolean;
  settingsFocus: string | null;
  userName: string;
  actionError: string | null;
  highlightEntryId: string | null;
  /** Bumped on every jumpTo so a repeat jump to the same entry still re-scrolls. */
  highlightSeq: number;
  /** False until the first loadAll() resolves: the sidebar shows no empty state before that. */
  botsLoaded: boolean;
  /** The bootstrap load (store.loadAll): three outcomes, so a failed one can never look like "no Bots yet". */
  bootstrap: AsyncStatus;
  routines: Record<string, RoutineView[]>;
  routineId: string | null;
  teach: TeachStatus;
  /**
   * The Bot a pending "Teach a task" setup form belongs to (bug 42). This is per-Bot AND
   * per-surface: the form opens on whichever surface the user is looking at, and `TeachSurface`
   * (TeachBanner.tsx) clears it when no visible surface can show it any more.
   */
  teachSetupFor: string | null;
}

/** The states in which a teach session exists and its bar has something to say (ORIG-08 §08.3). */
const TEACH_LIVE: readonly TeachState[] = ["RECORDING", "PAUSED", "FINALIZING", "ANALYZING"];

/**
 * The Bot a live teach session belongs to, or null.
 *
 * TCH-01 allows exactly one recording app-wide, so a running session is NOT a property of the chat
 * it was started from: its bar, and above all its Stop & save, have to follow the user. Bug 42 (b)
 * is what that costs when it doesn't — a recording started on one Bot's screen left a bar mounted
 * only in that Bot's chat, and walking away from that chat left no way to stop it.
 */
export function teachSessionBotId(s: Pick<UiState, "teach">): string | null {
  return TEACH_LIVE.includes(s.teach.state) ? s.teach.botId : null;
}

export function initialState(): UiState {
  return {
    connection: { kind: "starting" }, bots: {}, activeBotId: null, pinned: [], view: { kind: "empty" }, transcripts: {}, typing: {},
    trays: [], settings: null, panel: "closed", settingsOpen: false, settingsFocus: null, userName: "", actionError: null, highlightEntryId: null,
    highlightSeq: 0, botsLoaded: false, bootstrap: { status: "loading" },
    routines: {}, routineId: null,
    teach: { state: "IDLE", botId: null, sessionId: null, sessionDir: null, startedAtMs: null, elapsedMs: 0, goal: null },
    teachSetupFor: null,
  };
}

// settings-persist: a SNAPSHOT (a save's own response, or the startup/reconnect load) and the host's
// SSE events travel different roads, so they can arrive out of order. The events are the host's own
// ordered record and are always applied (applyEvent below); a snapshot only replaces what the store
// holds when it is at least as new. Without this, a slow response to one switch put back the Off of
// another switch the user had turned on meanwhile, and the startup load undid a change made while it ran.

/**
 * The host's own sequence decides, never a clock: `rev` counts within one `epoch` (one host run, or one load of its
 * settings file). A snapshot from a different epoch — the host restarted, or reset a quarantined settings file to
 * rev 0 — always wins, so a reset can't leave the app refusing every answer. No counter at all: the snapshot wins.
 */
function newer(cur: { rev?: number; epoch?: string } | null | undefined, next: { rev?: number; epoch?: string }): boolean {
  if (!cur || cur.epoch !== next.epoch) return true;
  return !(typeof cur.rev === "number" && typeof next.rev === "number" && cur.rev > next.rev);
}

/** Keep the newer of two copies of one Bot: a stale snapshot (lower `rev`, same `epoch`) never replaces it. */
export function fresherBot(cur: BotSummary | undefined, next: BotSummary): BotSummary {
  return cur && !newer(cur, next) ? cur : next;
}

/** The same for the account settings, by the host's save counter. */
export function fresherSettings(cur: HostSettingsView | null, next: HostSettingsView): HostSettingsView {
  return cur && !newer(cur, next) ? cur : next;
}

export function sortedBotIds(bots: Record<string, BotSummary>): string[] {
  return Object.values(bots).sort((a, b) => b.updatedAt - a.updatedAt).map((b) => b.id);
}

export function upsertEntry(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = list.findIndex((e) => e.id === entry.id);
  if (i < 0) return [...list, entry];
  const next = list.slice();
  next[i] = entry;
  return next;
}

export function applyEvent(s: UiState, e: SseEvent): UiState {
  switch (e.channel) {
    case "agent-upserted":
      return { ...s, bots: { ...s.bots, [e.payload.agent.id]: e.payload.agent } };
    case "agents": {
      const { [e.payload.removedId]: _gone, ...bots } = s.bots;
      const { [e.payload.removedId]: _t, ...transcripts } = s.transcripts;
      const viewingRemoved = s.view.kind === "chat" && s.view.botId === e.payload.removedId;
      const next = e.payload.activeAgentId && bots[e.payload.activeAgentId] ? e.payload.activeAgentId : null;
      return { ...s, bots, transcripts, activeBotId: next, view: viewingRemoved ? (next ? { kind: "chat", botId: next } : { kind: "empty" }) : s.view };
    }
    case "transcript": {
      const p = e.payload;
      if (p.op === "typing") return { ...s, typing: { ...s.typing, [p.botId]: { typing: p.typing, partialText: p.partialText } } };
      return { ...s, transcripts: { ...s.transcripts, [p.botId]: upsertEntry(s.transcripts[p.botId] ?? [], p.entry) } };
    }
    case "tray":
      return { ...s, trays: e.payload.trays };
    case "host-settings":
      return { ...s, settings: e.payload, pinned: e.payload.pinnedAgentIds };
    case "skills":
      // Private skills state isn't held in the UI store yet; a later task (Task 24/25) wires
      // this channel into its own module rather than growing this reducer.
      return s;
    case "automations":
      return { ...s, routines: { ...s.routines, [e.payload.botId]: e.payload.routines } };
    case "teach-recording":
      return { ...s, teach: e.payload, teachSetupFor: e.payload.state === "RECORDING" || e.payload.state === "PAUSED" ? null : s.teachSetupFor };
    // Phase 3 channels (computer-action, forever-box, box-disk-pressure, async-tasks, displays, box-help) and
    // Phase 5's (usage, mcp-servers, catalog, local-exec, phase5-settings) have no reducer state; their own
    // feature-store modules subscribe to them.
    default:
      return s;
  }
}
