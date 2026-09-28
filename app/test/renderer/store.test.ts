import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Gate L-2 (run 4): right after launch, a New chat click was overridden by the boot openBot(active).
const agent = { id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Piper", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" }, settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false } };
let release!: () => void;
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  const gate = new Promise<void>((r) => { release = r; });
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "listAgents") { await gate; return { ok: true, result: { agents: [agent], activeAgentId: "a" } }; }
      if (cmd === "getHostSettings") return { ok: true, result: { pinnedAgentIds: [] } };
      if (cmd === "getTrays") return { ok: true, result: { trays: [] } };
      if (cmd === "getTeachRecordingStatus") return { ok: true, result: { status: { state: "IDLE", botId: null, sessionId: null, sessionDir: null, startedAtMs: null, elapsedMs: 0, goal: null } } };
      if (cmd === "openAgent") return { ok: true, result: { agent } };
      if (cmd === "getAgentTranscriptTail") return { ok: true, result: { entries: [] } };
      return { ok: true, result: {} };
    }),
  };
  useUi.setState(initialState());
});

describe("loadAll boot navigation (L-2)", () => {
  it("does not override a New chat click made while the boot load was in flight", async () => {
    const p = useUi.getState().loadAll();
    useUi.getState().openNewChat();
    release();
    await p;
    expect(useUi.getState().view).toEqual({ kind: "new-chat" });
    expect(calls).not.toContain("openAgent");
    expect(useUi.getState().bots.a).toBeTruthy();
  });

  it("still opens the active Bot when the user didn't navigate", async () => {
    const p = useUi.getState().loadAll();
    release();
    await p;
    expect(useUi.getState().view).toEqual({ kind: "chat", botId: "a" });
  });

  it("reloads a paused recording so the bar comes back after the app reopens", async () => {
    const paused = { state: "PAUSED", botId: "a", sessionId: "teach-1", sessionDir: "/w/t", startedAtMs: 1, elapsedMs: 45_000, goal: "File an expense" };
    (globalThis as unknown as { synapse: { call: ReturnType<typeof vi.fn> } }).synapse.call = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "listAgents") { await new Promise<void>((r) => { release = r; }); return { ok: true, result: { agents: [agent], activeAgentId: "a" } }; }
      if (cmd === "getHostSettings") return { ok: true, result: { pinnedAgentIds: [] } };
      if (cmd === "getTrays") return { ok: true, result: { trays: [] } };
      if (cmd === "getTeachRecordingStatus") return { ok: true, result: { status: paused } };
      if (cmd === "openAgent") return { ok: true, result: { agent } };
      if (cmd === "getAgentTranscriptTail") return { ok: true, result: { entries: [] } };
      return { ok: true, result: {} };
    });
    const p = useUi.getState().loadAll();
    release();
    await p;
    expect(calls).toContain("getTeachRecordingStatus");
    expect(useUi.getState().teach).toMatchObject(paused);
  });
});
