import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS5 } from "@synapse/shared";
import { parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";
import { WHISPER_STOP_WAIT_MS } from "../../src/main/native/stt-whisper";

describe("dictation helper protocol", () => {
  it("parses the JSON-lines events and ignores noise", () => {
    expect(parseDictationLine('{"type":"partial","text":"hello wor"}')).toEqual({ type: "partial", text: "hello wor" });
    expect(parseDictationLine('{"type":"final","text":"hello world"}')).toEqual({ type: "final", text: "hello world" });
    expect(parseDictationLine('{"type":"error","message":"denied"}')).toEqual({ type: "error", message: "denied" });
    // Bug 142: the likely end of turn reaches the call screen, which starts the reply early.
    expect(parseDictationLine('{"type":"likely-end","text":"text Sam that I am late."}')).toEqual({ type: "likely-end", text: "text Sam that I am late." });
    expect(parseDictationLine('{"type":"likely-end"}')).toBeNull();
    expect(parseDictationLine("2026-09-19 helper log line")).toBeNull();
    expect(parseDictationLine('{"type":"bogus"}')).toBeNull();
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
  };
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.stdout = new EventEmitter();
  return child;
}

describe("registerDictation stale-close race (CHAT-08 fix round 1 #1)", () => {
  it("keeps the active session's child when a stale first child's close event fires after a new session started", async () => {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never });
    const dispatch = handlers.get("native")!;

    // Session 1 starts.
    await dispatch({}, { name: "dictation.start", args: {} });
    // The helper sends its own protocol "end" line (natural stop -> final -> end), which flips the
    // renderer's `listening` to false and re-enables the Start button, well before the OS process
    // for this child actually exits.
    children[0].stdout.emit("data", Buffer.from('{"type":"end"}\n'));
    // In that window, the user starts a brand-new session.
    await dispatch({}, { name: "dictation.start", args: {} });
    // Only now does the stale first child's OS-level close event fire.
    children[0].emit("close");

    // The active (second) session must still be stoppable.
    await dispatch({}, { name: "dictation.stop", args: {} });
    expect(children[1].stdin.write).toHaveBeenCalledWith("stop\n");
    expect(children[0].stdin.write).not.toHaveBeenCalled();
  });
});

describe("registerDictation stale-child event suppression (fix round 1 #2)", () => {
  function setup() {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_ch: string, msg: { channel: string; payload: unknown }) => sent.push(msg) },
    };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never });
    const dispatch = handlers.get("native")!;
    return { sent, children, dispatch };
  }

  it("never forwards a stale child's belated close (\"end\") once a newer session has started", async () => {
    const { sent, children, dispatch } = setup();

    // Session 1 starts and naturally ends (its own stdout "end" line arrives).
    await dispatch({}, { name: "dictation.start", args: {} });
    children[0].stdout.emit("data", Buffer.from('{"type":"end"}\n'));
    const emittedAfterSession1End = sent.filter((s) => s.channel === "dictation").length;
    expect(emittedAfterSession1End).toBe(1); // the legitimate end for session 1

    // User immediately starts session 2 while session 1's OS process hasn't exited yet.
    await dispatch({}, { name: "dictation.start", args: {} });
    const countBeforeStaleClose = sent.filter((s) => s.channel === "dictation").length;

    // Session 1's belated close now fires. It must NOT reach the renderer as a second "end",
    // because that would be misattributed to session 2 (still actually recording) by the
    // renderer's single shared subscription.
    children[0].emit("close");

    const dictationEvents = sent.filter((s) => s.channel === "dictation");
    expect(dictationEvents.length).toBe(countBeforeStaleClose);
    expect(dictationEvents.some((s) => (s.payload as { type: string }).type === "end")).toBe(true); // only session 1's own legitimate end
    expect(dictationEvents.length).toBe(1);
  });

  it("never forwards a stale child's belated stdout data (partial/final) once a newer session has started", async () => {
    const { sent, children, dispatch } = setup();

    await dispatch({}, { name: "dictation.start", args: {} });
    await dispatch({}, { name: "dictation.start", args: {} });
    // Starting session 2 supersedes session 1, which tells session 1's owner — on session 1's own
    // id — that its session ended. Nothing the stale CHILD itself produces may be forwarded, so
    // the count must not move from here (same shape as the belated-close test above).
    const countBeforeStaleData = sent.filter((s) => s.channel === "dictation").length;

    // Session 1's process is still alive and its stdout delivers a late buffered line after
    // session 2 has already taken over as the active child.
    children[0].stdout.emit("data", Buffer.from('{"type":"partial","text":"stale"}\n'));

    expect(sent.filter((s) => s.channel === "dictation").length).toBe(countBeforeStaleData);
    expect(sent.filter((s) => s.channel === "dictation").map((s) => (s.payload as { type: string }).type)).not.toContain("partial");
  });

  it("never forwards a stale child's belated error once a newer session has started", async () => {
    const { sent, children, dispatch } = setup();

    await dispatch({}, { name: "dictation.start", args: {} });
    await dispatch({}, { name: "dictation.start", args: {} });
    const countBeforeStaleError = sent.filter((s) => s.channel === "dictation").length;

    children[0].emit("error", new Error("stale failure"));

    expect(sent.filter((s) => s.channel === "dictation").length).toBe(countBeforeStaleError);
    expect(sent.filter((s) => s.channel === "dictation").map((s) => (s.payload as { type: string }).type)).not.toContain("error");
  });
});

// ---------------------------------------------------------------------------
// Session identity (defect 2) and a stop that can actually stop (defect 3).
// The renderer has two consumers of the single "dictation" channel — the
// composer mic and the voice overlay — so every event has to say which session
// it belongs to, and a stop has to name the session it means to end.
// ---------------------------------------------------------------------------
function makeKillableChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return child;
}

function session() {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
  const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
  installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
  const children: ReturnType<typeof makeKillableChild>[] = [];
  const spawnFn = vi.fn(() => { const c = makeKillableChild(); children.push(c); return c as unknown as ChildProcess; });
  registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never });
  const dispatch = handlers.get("native")!;
  return {
    children, sent, spawnFn,
    start: (args: Record<string, unknown>) => dispatch({}, { name: "dictation.start", args }),
    stop: (args: Record<string, unknown>) => dispatch({}, { name: "dictation.stop", args }),
    events: () => sent.filter((s) => s.channel === "dictation").map((s) => s.payload),
  };
}

describe("dictation session identity (defect 2)", () => {
  it("stamps every event of a session with the caller's session id", async () => {
    const s = session();
    await s.start({ sessionId: "overlay-1" });
    s.children[0].stdout.emit("data", Buffer.from('{"type":"ready"}\n{"type":"partial","text":"hello"}\n{"type":"final","text":"hello there"}\n'));
    s.children[0].emit("close");
    expect(s.events()).toEqual([
      { type: "ready", sessionId: "overlay-1" },
      { type: "partial", text: "hello", sessionId: "overlay-1" },
      { type: "final", text: "hello there", sessionId: "overlay-1" },
      { type: "end", sessionId: "overlay-1" },
    ]);
  });

  it("stamps a spawn error with the session id too", async () => {
    const s = session();
    await s.start({ sessionId: "mic-1" });
    s.children[0].emit("error", new Error("helper missing"));
    expect(s.events()).toEqual([{ type: "error", message: "helper missing", sessionId: "mic-1" }]);
  });

  it("supersedes the running session and tells its owner that it ended", async () => {
    const s = session();
    await s.start({ sessionId: "mic-1" });
    await s.start({ sessionId: "overlay-1" });
    // The newest requester wins the single microphone, and the superseded consumer is told
    // so its UI does not sit there claiming to be listening.
    expect(s.events()).toEqual([{ type: "end", sessionId: "mic-1" }]);
    expect(s.children[0].stdin.end).toHaveBeenCalled();
    // The new session owns the channel from here on.
    s.children[1].stdout.emit("data", Buffer.from('{"type":"partial","text":"mine"}\n'));
    expect(s.events().at(-1)).toEqual({ type: "partial", text: "mine", sessionId: "overlay-1" });
    // The superseded child's belated close must not produce a second "end" for anyone.
    s.children[0].emit("close");
    expect(s.events().filter((e) => e.type === "end")).toEqual([{ type: "end", sessionId: "mic-1" }]);
  });

  it("ignores a stop from a session that no longer owns the microphone", async () => {
    const s = session();
    await s.start({ sessionId: "mic-1" });
    await s.start({ sessionId: "overlay-1" });
    await s.stop({ sessionId: "mic-1" });
    expect(s.children[1].stdin.write).not.toHaveBeenCalled();
    await s.stop({ sessionId: "overlay-1" });
    expect(s.children[1].stdin.write).toHaveBeenCalledWith("stop\n");
  });

  it("still serves a caller that does not name a session", async () => {
    const s = session();
    const r = (await s.start({})) as { ok: boolean; result: { sessionId: string } };
    expect(r.ok).toBe(true);
    expect(typeof r.result.sessionId).toBe("string");
    s.children[0].stdout.emit("data", Buffer.from('{"type":"partial","text":"x"}\n'));
    expect(s.events()[0]!.sessionId).toBe(r.result.sessionId);
    await s.stop({});
    expect(s.children[0].stdin.write).toHaveBeenCalledWith("stop\n");
  });
});

describe("dictation stop escalation (defect 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has a deliberate, short grace period before signalling", () => {
    expect(LIMITS5.dictationStopGraceMs).toBeGreaterThanOrEqual(1_000);
    expect(LIMITS5.dictationStopGraceMs).toBeLessThanOrEqual(5_000);
    expect(LIMITS5.dictationKillGraceMs).toBeGreaterThanOrEqual(500);
    expect(LIMITS5.dictationKillGraceMs).toBeLessThanOrEqual(5_000);
  });

  it("kills a helper that ignores `stop` on stdin, so the microphone cannot stay hot", async () => {
    const s = session();
    await s.start({ sessionId: "s1" });
    await s.stop({ sessionId: "s1" });
    // Graceful first: the helper flushes its final transcript when it stops cleanly.
    expect(s.children[0].stdin.write).toHaveBeenCalledWith("stop\n");
    expect(s.children[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIMITS5.dictationStopGraceMs - 1);
    expect(s.children[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.children[0].kill).toHaveBeenCalledWith("SIGTERM");
    // Still wedged after SIGTERM: escalate.
    vi.advanceTimersByTime(LIMITS5.dictationKillGraceMs);
    expect(s.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("never signals a helper that stopped cleanly", async () => {
    const s = session();
    await s.start({ sessionId: "s1" });
    await s.stop({ sessionId: "s1" });
    s.children[0].stdout.emit("data", Buffer.from('{"type":"final","text":"flushed"}\n'));
    s.children[0].emit("close");
    vi.advanceTimersByTime(LIMITS5.dictationStopGraceMs + LIMITS5.dictationKillGraceMs + 10_000);
    expect(s.children[0].kill).not.toHaveBeenCalled();
    expect(s.events().map((e) => e.type)).toEqual(["final", "end"]);
  });

  it("bug 185: with whisper on, a stop waits for the long turn's final instead of killing it at 2 s", async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const children: ReturnType<typeof makeKillableChild>[] = [];
    const spawnFn = vi.fn(() => { const c = makeKillableChild(); children.push(c); return c as unknown as ChildProcess; });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, whisper: () => ["--whisper-model", "/m.bin", "--whisper-budget-ms", "900"] });
    const dispatch = handlers.get("native")!;
    await dispatch({}, { name: "dictation.start", args: { sessionId: "w1" } });
    await dispatch({}, { name: "dictation.stop", args: { sessionId: "w1" } });
    // The helper is flushing: Apple's final for the last turn, then whisper's pass over its tail.
    vi.advanceTimersByTime(LIMITS5.dictationStopGraceMs + 1);
    expect(children[0].kill).not.toHaveBeenCalled();
    // ...but not forever: the helper's own budgets bound that wait, and so does this.
    vi.advanceTimersByTime(WHISPER_STOP_WAIT_MS);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bug 185: a new session right after a stop never kills the helper still flushing the last final", async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const children: ReturnType<typeof makeKillableChild>[] = [];
    const spawnFn = vi.fn(() => { const c = makeKillableChild(); children.push(c); return c as unknown as ChildProcess; });
    const active: boolean[] = [];
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, onActive: (a) => active.push(a), whisper: () => ["--whisper-model", "/m.bin"] });
    const dispatch = handlers.get("native")!;
    const evs = () => sent.filter((s) => s.channel === "dictation").map((s) => s.payload);
    await dispatch({}, { name: "dictation.start", args: { sessionId: "mic-1" } });
    await dispatch({}, { name: "dictation.stop", args: { sessionId: "mic-1" } });
    // The user presses the mic again (or starts a call) while the long speech is still in whisper.
    await dispatch({}, { name: "dictation.start", args: { sessionId: "mic-2" } });
    // The flushing helper is not "superseded": no end for its session yet, no stdin close, no SIGTERM at 2 s.
    expect(evs().some((e) => e.type === "end" && e.sessionId === "mic-1")).toBe(false);
    expect(children[0].stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIMITS5.dictationStopGraceMs + 1);
    expect(children[0].kill).not.toHaveBeenCalled();
    // Its last final still reaches its own session, then it ends — once.
    children[0].stdout.emit("data", Buffer.from('{"type":"final","text":"the last sentence"}\n'));
    children[0].emit("close", 0, null);
    expect(evs().filter((e) => e.sessionId === "mic-1").map((e) => `${e.type}:${e.text ?? ""}`)).toEqual(["final:the last sentence", "end:"]);
    // The new session is untouched, and still owns the microphone.
    expect(children[1].kill).not.toHaveBeenCalled();
    expect(active.at(-1)).toBe(true);
    await dispatch({}, { name: "dictation.stop", args: { sessionId: "mic-2" } });
    expect(children[1].stdin.write).toHaveBeenCalledWith("stop\n");
  });

  it("kills a superseded helper that will not go away", async () => {
    const s = session();
    await s.start({ sessionId: "mic-1" });
    await s.start({ sessionId: "overlay-1" });
    expect(s.children[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIMITS5.dictationStopGraceMs);
    expect(s.children[0].kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(LIMITS5.dictationKillGraceMs);
    expect(s.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(s.children[1].kill).not.toHaveBeenCalled();
  });
});

describe("dictation microphone permission (bug 99)", () => {
  function gated(access: () => Promise<"granted" | "denied" | "restricted">) {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const spawnFn = vi.fn(() => makeKillableChild() as unknown as ChildProcess);
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, micAccess: access });
    const dispatch = handlers.get("native")!;
    return { spawnFn, start: (args: Record<string, unknown>) => dispatch({}, { name: "dictation.start", args }), events: () => sent.filter((s) => s.channel === "dictation").map((s) => s.payload) };
  }

  it("denied microphone: never spawns the helper, reports the pane-specific fault and ends the session", async () => {
    const s = gated(async () => "denied");
    await s.start({ sessionId: "s1" });
    expect(s.events()).toEqual([
      { type: "error", message: "permission:microphone:denied", sessionId: "s1" },
      { type: "end", sessionId: "s1" },
    ]);
    expect(s.spawnFn).not.toHaveBeenCalled();
  });

  it("restricted microphone is reported as restricted", async () => {
    const s = gated(async () => "restricted");
    await s.start({ sessionId: "s1" });
    expect(s.events()[0]).toEqual({ type: "error", message: "permission:microphone:restricted", sessionId: "s1" });
  });

  it("granted microphone spawns the helper as before", async () => {
    const s = gated(async () => "granted");
    await s.start({ sessionId: "s1" });
    expect(s.spawnFn).toHaveBeenCalledTimes(1);
    expect(s.events()).toEqual([]);
  });

  it("a helper killed by macOS without a word is reported, not a quiet end", async () => {
    const s = session();
    await s.start({ sessionId: "s1" });
    s.children[0].emit("close", null, "SIGABRT");
    expect(s.events()).toEqual([
      // Bug 101: the reason travels with it (the signal, and the helper's last stderr line if any).
      { type: "error", code: "helper-exit", message: "The dictation helper stopped unexpectedly (signal SIGABRT).", sessionId: "s1" },
      { type: "end", sessionId: "s1" },
    ]);
  });

  it("a helper we stopped, or one that already reported, adds no crash error", async () => {
    const s = session();
    await s.start({ sessionId: "s1" });
    await s.stop({ sessionId: "s1" });
    s.children[0].emit("close", null, "SIGTERM");
    await s.start({ sessionId: "s2" });
    s.children[1].stdout.emit("data", Buffer.from('{"type":"error","message":"permission:speech:denied"}\n'));
    s.children[1].emit("close", 2, null);
    expect(s.events().filter((e) => e.type === "error")).toEqual([{ type: "error", message: "permission:speech:denied", sessionId: "s2" }]);
  });

  it("a newer start while the macOS prompt is still up supersedes the older one", async () => {
    let release!: (v: "granted") => void;
    const first = new Promise<"granted">((r) => { release = r; });
    let n = 0;
    const s = gated(() => (n++ === 0 ? first : Promise.resolve("granted" as const)));
    const p1 = s.start({ sessionId: "s1" });
    await s.start({ sessionId: "s2" });
    expect(s.spawnFn).toHaveBeenCalledTimes(1);
    release("granted");
    await p1;
    expect(s.spawnFn).toHaveBeenCalledTimes(1);
    expect(s.events()).toContainEqual({ type: "end", sessionId: "s1" });
  });
});

describe("registerDictation tells the wake word when it has the microphone", () => {
  it("onActive(true) before the helper spawns, onActive(false) once the current helper is gone", async () => {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const order: string[] = [];
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => { order.push("spawn"); const c = makeFakeChild(); children.push(c); return c as unknown as ChildProcess; });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, onActive: (a) => order.push(`active:${a}`) });
    const dispatch = handlers.get("native")!;
    await dispatch({}, { name: "dictation.start", args: { mode: "call" } });
    expect(order).toEqual(["active:true", "spawn"]);
    children[0]!.emit("close", 0, null);
    expect(order.at(-1)).toBe("active:false");
  });
});
