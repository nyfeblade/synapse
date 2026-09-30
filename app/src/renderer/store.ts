import { create } from "zustand";
import type { BotSummary, HostSettingsView, RoutineView, SseEvent, TranscriptEntry } from "@synapse/shared";
import { call, callQuiet, type ConnectionState } from "./bridge";
import { messageOf, setErrorSink } from "./error-channel";
import { applyEvent, fresherBot, fresherSettings, initialState, type UiState } from "./reducer";
import { timeOf } from "./transcript-items";
import { withViewChange } from "./view-transition";
import type { NewBotChoice } from "./model-picks";

interface Actions {
  setConnection(c: ConnectionState): void;
  apply(e: SseEvent): void;
  loadAll(): Promise<void>;
  openBot(id: string): Promise<void>;
  openNewChat(): void;
  /** `choice`: the model and key the owner picked while creating it (NewBotModelStep), saved as the picker saves it. */
  createBot(name?: string, choice?: NewBotChoice | null): Promise<string>;
  deleteBot(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  loadTranscript(id: string): Promise<void>;
  openSettings(focus?: string): void;
  closeSettings(): void;
  setPanel(p: UiState["panel"]): void;
  clearActionError(): void;
  mergeEntries(botId: string, entries: TranscriptEntry[]): void;
  jumpTo(botId: string, entryId: string): Promise<void>;
  clearHighlight(): void;
  createGroup(memberIds: string[], name?: string): Promise<string>;
  setGroupMembers(id: string, memberIds: string[]): Promise<void>;
  loadRoutines(botId: string): Promise<void>;
  openRoutine(routineId: string): void;
  closeRoutine(): void;
  upsertRoutine(r: RoutineView): void;
}

export const useUi = create<UiState & Actions>((set, get) => ({
  ...initialState(),
  setConnection: (c) => {
    // typing[botId] is only ever written by a live SSE event. A dropped stream loses the matching
    // `typing:false` (the event loop reopens /events with no replay), so anything still "typing" when
    // the connection goes away would animate forever: clear it on every transition away from connected.
    set(c.kind === "connected" ? { connection: c } : { connection: c, typing: {} });
    if (c.kind === "connected") void get().loadAll();
  },
  apply: (e) => set((s) => applyEvent(s, e)),
  // THE SINGLE WORST STATE THE AUDIT FOUND WAS HERE: this had no try/catch at all, so one failed
  // listAgents left the sidebar with no rows, no empty state and no error, the main pane blank, and
  // NOTHING that would ever try again — the app was simply over until the user quit it. The
  // outcome is now a three-state status the main pane renders, with a Retry that calls this again.
  // The `call`s below keep the default banner as well: on a RECONNECT the Bots are already on
  // screen, the pane never shows, and the banner is the only thing that would say what happened.
  loadAll: async () => {
    const before = get().view;
    // settings-persist: what the store holds as the load starts. Anything that differs when the answers
    // come back was changed WHILE they were in flight (the user's switch, confirmed by the host's event),
    // and an answer computed before that change must not put it back.
    const botsAtStart = get().bots;
    const settingsAtStart = get().settings;
    set({ bootstrap: { status: "loading" } });
    let loaded;
    try {
      loaded = await Promise.all([
        call("listAgents", {}),
        call("getHostSettings", {}),
        call("getTrays", {}),
        // The teach-recording SSE has no replay. A session that was already live — or paused when
        // the app quit — would come back as IDLE and lock Teach a task as "another recording".
        callQuiet("getTeachRecordingStatus", {}).catch(() => ({ status: initialState().teach })),
      ]);
    } catch (e) {
      set({ bootstrap: { status: "error", message: messageOf(e) } });
      return;
    }
    const [{ agents, activeAgentId }, loadedSettings, { trays }, teach] = loaded;
    const now = get();
    const bots = Object.fromEntries(agents.map((a) => {
      const cur = now.bots[a.id];
      return [a.id, cur && cur !== botsAtStart[a.id] ? fresherBot(cur, a) : a];
    }));
    const settings = now.settings && now.settings !== settingsAtStart ? fresherSettings(now.settings, loadedSettings) : loadedSettings;
    // typing is deliberately reset here too: a reconnect refreshes every Bot's real state, and any
    // typing flag left over from before the gap has no `typing:false` coming to end it.
    set({ bots, activeBotId: activeAgentId, settings, pinned: settings.pinnedAgentIds, trays, typing: {}, botsLoaded: true, bootstrap: { status: "ready" }, teach: teach.status ?? initialState().teach });
    // A reconnect may follow a host restart that changed runs (interrupted) while no SSE reached us: refresh cached routines.
    const known = new Set(agents.map((a) => a.id));
    for (const id of Object.keys(get().routines)) if (known.has(id)) void get().loadRoutines(id).catch(() => {});
    const v = get().view;
    // The user navigated (e.g. New chat) while this load was in flight: keep their choice (gate L-2).
    if (v !== before) return;
    const target = v.kind === "chat" && agents.some((a) => a.id === v.botId) ? v.botId : activeAgentId;
    try {
      if (target && agents.some((a) => a.id === target)) await get().openBot(target);
      else if (agents.length === 0) set({ view: { kind: "new-chat" } });
    } catch {
      // The list, settings and trays are already on screen, so this is not a failed bootstrap — it
      // is one Bot that would not open, and openBot's own call() has already put the reason in the
      // banner. Swallowed here only so `void loadAll()` (setConnection) cannot leave an unhandled
      // rejection behind; the bootstrap stays "ready" because the app is usable.
    }
  },
  openBot: async (id) => {
    // panel/routineId are global: opening another Bot with a Routine open left the panel pointing at
    // the first Bot's routine, which renders nothing and makes the header's details button a dead click.
    const show = () => set((s) => {
      const sameBot = s.view.kind === "chat" && s.view.botId === id;
      const closeRoutine = !sameBot && s.panel === "routine" ? { panel: "details" as const, routineId: null } : {};
      return { view: { kind: "chat", botId: id }, activeBotId: id, ...closeRoutine };
    });
    // Liquid motion: a real view change brings the main pane in (view-transition.ts); re-opening
    // the Bot already on screen is not a view change and stays a plain update.
    const v = get().view;
    if (v.kind === "chat" && v.botId === id) show(); else withViewChange(show);
    const [{ agent }] = await Promise.all([call("openAgent", { id }), get().loadTranscript(id)]);
    // Key by the response's own id, not the id that was asked for: sortedBotIds() (reducer.ts) derives
    // every id from each entry's `.id` field, so a map entry stored under a mismatched key would make
    // that helper hand back an id the map can't resolve, and every consumer that trusts the pair (e.g.
    // NewChat, Sidebar) would crash on it. No agent at all (e.g. the bot vanished mid-open) leaves the
    // map untouched rather than writing a hole into it.
    if (agent) acceptAgent(agent);
  },
  openNewChat: () => withViewChange(() => set({ view: { kind: "new-chat" } })),
  createBot: async (name, choice) => {
    const { id } = await call("createAgent", name ? { name, isKickstartRequested: true } : { isKickstartRequested: true });
    if (choice?.touched) {
      const r = await call("pickAgentModel", { id, model: choice.model, keyId: choice.keyId });
      if (r?.agent) acceptAgent(r.agent);
    }
    await get().openBot(id);
    return id;
  },
  deleteBot: async (id) => {
    try {
      const { activeAgentId } = await call("deleteAgent", { id });
      set((s) => applyEvent(s, { channel: "agents", payload: { removedId: id, activeAgentId } }));
    } catch (e) {
      set({ actionError: e instanceof Error ? e.message : String(e) });
    }
  },
  setPinned: async (id, pinned) => {
    try {
      const { pinnedAgentIds } = await call("setAgentPinned", { id, pinned });
      set({ pinned: pinnedAgentIds ?? [] });
    } catch (e) {
      set({ actionError: e instanceof Error ? e.message : String(e) });
    }
  },
  loadTranscript: async (id) => {
    const { entries } = await call("getAgentTranscriptTail", { id, limit: 300 });
    set((s) => {
      const { [id]: _stale, ...typing } = s.typing; // a refreshed tail supersedes any half-written stream
      return { transcripts: { ...s.transcripts, [id]: entries }, typing };
    });
  },
  openSettings: (focus) => set({ settingsOpen: true, settingsFocus: focus ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsFocus: null }),
  setPanel: (p) => set({ panel: p }),
  clearActionError: () => set({ actionError: null }),
  mergeEntries: (botId, entries) => set((s) => {
    const byId = new Map((s.transcripts[botId] ?? []).map((e) => [e.id, e]));
    for (const e of entries) byId.set(e.id, e);
    // Entry order relies on insertion order; a page merge keeps the host's order only when
    // the page is older than the tail, so sort by createdAt (then id) to be safe.
    const merged = [...byId.values()].sort((a, b) => timeOf(a) - timeOf(b));
    return { transcripts: { ...s.transcripts, [botId]: merged } };
  }),
  jumpTo: async (botId, entryId) => {
    if (get().view.kind !== "chat" || (get().view as { botId: string }).botId !== botId) await get().openBot(botId);
    if (!(get().transcripts[botId] ?? []).some((e) => e.id === entryId)) {
      const page = await call("getAgentTranscriptPage", { id: botId, aroundEntryId: entryId, before: 50, after: 50 });
      get().mergeEntries(botId, page.entries);
    }
    // The seq is what makes a second jump to the same entry re-scroll: the id alone is unchanged.
    set((s) => ({ highlightEntryId: entryId, highlightSeq: s.highlightSeq + 1 }));
  },
  clearHighlight: () => set({ highlightEntryId: null }),
  createGroup: async (memberIds, name) => {
    const { id } = await call("createGroup", name ? { memberIds, name } : { memberIds });
    await get().openBot(id);
    return id;
  },
  setGroupMembers: async (id, memberIds) => {
    const { agent } = await call("setGroupMembers", { id, memberIds });
    // Same reasoning as openBot above: key by the response's own id, and tolerate no agent at all.
    if (agent) acceptAgent(agent);
  },
  loadRoutines: async (botId) => {
    // callQuiet: RoutinesSection presents this one in place, with its own Retry, and the background
    // refresh in loadAll() above deliberately ignores it (the cached routines stay on screen).
    const { routines } = await callQuiet("getAgentAutomations", { id: botId });
    set((s) => ({ routines: { ...s.routines, [botId]: routines } }));
  },
  openRoutine: (routineId) => set({ panel: "routine", routineId }),
  closeRoutine: () => set({ panel: "details", routineId: null }),
  upsertRoutine: (r) => set((s) => {
    const list = s.routines[r.botId] ?? [];
    const i = list.findIndex((x) => x.id === r.id);
    return { routines: { ...s.routines, [r.botId]: i < 0 ? [...list, r] : list.map((x) => (x.id === r.id ? r : x)) } };
  }),
}));

/**
 * settings-persist: the one way a save's RESPONSE reaches the store. A response older than what the
 * store already holds (the host's event for a later save got here first) is dropped, not applied.
 */
export function acceptAgent(agent: BotSummary | null | undefined): void {
  if (!agent?.id) return;
  useUi.setState((s) => {
    const kept = fresherBot(s.bots[agent.id], agent);
    return kept === s.bots[agent.id] ? s : { bots: { ...s.bots, [agent.id]: kept } };
  });
}

/** settings-persist: the same for an account-settings response (setHostSettings). */
export function acceptSettings(view: HostSettingsView | null | undefined): void {
  if (!view) return;
  useUi.setState((s) => {
    const kept = fresherSettings(s.settings, view);
    return kept === s.settings ? s : { settings: kept };
  });
}

// The renderer's default failure route (bridge.ts → error-channel.ts → here): a rejected call()
// nobody handled lands in `actionError`, which Sidebar.tsx renders as a role="alert" banner.
setErrorSink((message) => useUi.setState({ actionError: message }));
