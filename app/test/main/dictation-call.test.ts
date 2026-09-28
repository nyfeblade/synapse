import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { LIMITS5 } from "@synapse/shared";
import { parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

/** Bug 101: the helper protocol for voice mode "like a call" and failures that always carry a reason. */
describe("dictation helper protocol v2 (bug 101)", () => {
  it("parses the call events and an error's code", () => {
    expect(parseDictationLine('{"type":"audio","source":"mic","sampleRate":48000,"channels":1}')).toEqual({ type: "audio" });
    expect(parseDictationLine('{"type":"speech-start"}')).toEqual({ type: "speech-start" });
    expect(parseDictationLine('{"type":"speech-drop"}')).toEqual({ type: "speech-drop" }); // plan item 5
    expect(parseDictationLine('{"type":"barge-in"}')).toEqual({ type: "barge-in" });
    expect(parseDictationLine('{"type":"audio-restart","reason":"config-change"}')).toEqual({ type: "audio-restart", reason: "config-change" });
    expect(parseDictationLine('{"type":"speak-start","id":"s1","voice":"Ava"}')).toEqual({ type: "speak-start", id: "s1" });
    expect(parseDictationLine('{"type":"speak-end","id":"s1","interrupted":true,"seconds":1.2}')).toEqual({ type: "speak-end", id: "s1", interrupted: true });
    expect(parseDictationLine('{"type":"muted","muted":true}')).toEqual({ type: "muted", muted: true });
    expect(parseDictationLine('{"type":"error","code":"no-audio","message":"The microphone isn\'t sending any sound"}')).toEqual({ type: "error", code: "no-audio", message: "The microphone isn't sending any sound" });
    expect(parseDictationLine('{"type":"speak-end"}')).toBeNull(); // no id: not ours to route
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

function setup() {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
  const children: ReturnType<typeof makeFakeChild>[] = [];
  const spawnFn = vi.fn((_bin: string, _args: string[]) => {
    const c = makeFakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  });
  const log = vi.fn();
  registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, log });
  const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
  return { sent, children, spawnFn, dispatch, log };
}

describe("registerDictation call mode (bug 101)", () => {
  it("spawns the default (dictation) mode with no flags, and call mode with echo cancellation and the end-of-turn silence", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "d1" });
    expect(h.spawnFn.mock.calls[0]![1]).toEqual([]); // the helper defaults to dictation
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call", locale: "en-US" });
    expect(h.spawnFn.mock.calls[1]![1]).toEqual(["--mode", "call", "--voice-processing", "--silence-ms", String(LIMITS5.voiceSilenceMs), "--locale", "en-US"]);
    const bad = await h.dispatch("dictation.start", { sessionId: "c2", mode: "shout" });
    expect(bad.ok).toBe(false);
  });

  it("speak / hush / mute go to the session's own helper as stdin commands", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const c = h.children[0]!;
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "s1", text: "You have two meetings.", voice: "Ava", rate: 1.25, lang: "en-US" });
    const line = c.stdin.write.mock.calls.at(-1)![0] as string;
    expect(line.startsWith("speak ")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false); // one line, whatever the text holds
    expect(JSON.parse(line.slice(6))).toEqual({ id: "s1", text: "You have two meetings.", voice: "Ava", rate: 1.25, lang: "en-US" });
    await h.dispatch("dictation.hush", { sessionId: "c1" });
    expect(c.stdin.write).toHaveBeenLastCalledWith("hush\n");
    await h.dispatch("dictation.mute", { sessionId: "c1", muted: true });
    expect(c.stdin.write).toHaveBeenLastCalledWith("mute\n");
    await h.dispatch("dictation.mute", { sessionId: "c1", muted: false });
    expect(c.stdin.write).toHaveBeenLastCalledWith("unmute\n");
    // Another consumer's (stale) session never drives this helper.
    const before = c.stdin.write.mock.calls.length;
    await h.dispatch("dictation.hush", { sessionId: "other" });
    const r = await h.dispatch("dictation.speak", { sessionId: "other", id: "s2", text: "hi" });
    expect(c.stdin.write.mock.calls.length).toBe(before);
    expect(r.result).toEqual({ spoken: false });
  });

  it("rejects a speak that isn't text or is too long", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    expect((await h.dispatch("dictation.speak", { sessionId: "c1", id: "s1", text: 42 })).ok).toBe(false);
    expect((await h.dispatch("dictation.speak", { sessionId: "c1", id: "s1", text: "x".repeat(LIMITS5.voiceSpeakMaxChars + 1) })).ok).toBe(false);
    expect((await h.dispatch("dictation.speak", { sessionId: "c1", id: "bad id!", text: "hi" })).ok).toBe(false);
  });

  it("a helper that dies without a word reports its own last stderr line as the reason, and logs stderr", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "d1" });
    const c = h.children[0]!;
    c.stderr.emit("data", Buffer.from("[bots-dictation +5ms] start mode=dictation\n[bots-dictation +90ms] engine start failed: -10868\n"));
    c.emit("close", 1, null);
    const err = h.sent.find((s) => s.payload.type === "error")!;
    expect(err.payload.message).toContain("engine start failed: -10868");
    expect(err.payload.sessionId).toBe("d1");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("engine start failed"));
  });

  it("forwards an audio-restart so the app can log it, and the error code with the message", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "d1" });
    const c = h.children[0]!;
    c.stdout.emit("data", Buffer.from('{"type":"audio-restart","reason":"config-change"}\n{"type":"error","code":"no-audio","message":"The microphone isn\'t sending any sound"}\n'));
    expect(h.sent.map((s) => s.payload)).toEqual([
      { type: "audio-restart", reason: "config-change", sessionId: "d1" },
      { type: "error", code: "no-audio", message: "The microphone isn't sending any sound", sessionId: "d1" },
    ]);
  });
});
