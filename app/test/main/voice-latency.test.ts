import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_LATENCY, VOICE_SELFTEST, type SelfTestReport } from "@synapse/shared";
import { parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";
import { LatencyRecorder, LatencyStore, lastCallLatency, recordSelfTest, registerVoiceLatency } from "../../src/main/native/voice-latency";
const DAY = 24 * 3_600_000;

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "voice-latency-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function rec() {
  const clock = { t: 1_000_000 };
  const store = new LatencyStore(path.join(tmp(), "voice-latency.json"));
  let n = 0;
  const r = new LatencyRecorder({ store, now: () => clock.t, newId: () => `call-${++n}` });
  const at = (ms: number) => { clock.t += ms; };
  return { r, store, clock, at };
}

/** One reply: the voice stopped `since` ms before the final; then sent, first text, the line, its chunk, its audio. */
function reply(h: ReturnType<typeof rec>, o: { since?: number; text: number; chunk: number; audio: number; id: string; spec?: boolean }) {
  if (o.spec) h.r.mark("speculate");
  h.r.final(o.since);
  h.r.mark("sent");
  h.at(o.text); h.r.mark("first-text");
  h.r.line(o.id);
  h.at(o.chunk); h.r.chunk(o.id);
  h.at(o.audio); h.r.audio(o.id);
  h.at(3_000);
}

describe("5.8: the stage timing recorder", () => {
  it("times each reply from the end of speech: final, first text, first chunk, first audio", () => {
    const h = rec();
    h.r.callStart();
    reply(h, { since: 900, text: 400, chunk: 300, audio: 50, id: "sp-1", spec: true });
    const { summary } = h.r.callEnd();
    const turn = h.store.read().calls[0]!.turns[0]!;
    expect(turn).toMatchObject({ ref: "speech", sttFinal: 900, firstToken: 1_300, firstChunk: 1_600, firstAudio: 1_650, spec: true });
    expect(summary!.firstAudioP50).toBe(1_650);
    expect(summary!.over).toBe(1);
  });

  it("only the reply's own line counts: the call's 'mm' and a filler never set its chunk or audio", () => {
    const h = rec();
    h.r.callStart();
    h.r.final(800);
    h.r.mark("sent");
    h.at(250); h.r.chunk("sp-ack"); h.r.audio("sp-ack"); // a phrase: never handed over as a reply line
    h.at(500); h.r.mark("first-text"); h.r.line("sp-2");
    h.at(100); h.r.line("sp-3"); // the second line of the reply
    h.r.chunk("sp-3"); h.r.audio("sp-3");
    h.at(200); h.r.chunk("sp-2");
    h.at(20); h.r.audio("sp-2");
    h.r.callEnd();
    expect(h.store.read().calls[0]!.turns[0]).toMatchObject({ sttFinal: 800, firstToken: 1_550, firstChunk: 1_850, firstAudio: 1_870 });
  });

  it("a final the loop never sends (a backchannel, 'stop') is no turn; an older helper times from the final", () => {
    const h = rec();
    h.r.callStart();
    h.r.final(700); // "yeah" over the Bot: not sent
    h.at(2_000);
    reply(h, { text: 500, chunk: 200, audio: 10, id: "sp-1" }); // no sinceVoiceMs
    h.r.callEnd();
    const turns = h.store.read().calls[0]!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ ref: "final", sttFinal: 0, firstAudio: 710 });
    expect(lastCallLatency(h.store.read())).toBeNull(); // nothing measured against the budget
  });

  it("outside a call nothing is recorded, and a reply that never spoke keeps its audio empty", () => {
    const h = rec();
    h.r.final(500); h.r.mark("sent"); h.r.line("x"); h.r.audio("x");
    expect(h.r.inCall()).toBe(false);
    h.r.callStart();
    h.r.final(600); h.r.mark("sent"); // the voice said nothing ([quiet])
    h.r.callEnd();
    expect(h.store.read().calls[0]!.turns[0]).toMatchObject({ firstToken: null, firstChunk: null, firstAudio: null });
  });

  it("keeps numbers only: no transcript, no reply text in the file", () => {
    const h = rec();
    h.r.callStart();
    reply(h, { since: 900, text: 400, chunk: 300, audio: 50, id: "sp-1" });
    h.r.callEnd();
    const raw = fs.readFileSync((h.store as unknown as { file: string }).file, "utf8");
    const call = JSON.parse(raw).calls[0];
    expect(Object.keys(call).sort()).toEqual(["endedAt", "id", "startedAt", "turns"]);
    expect(Object.keys(call.turns[0]).sort()).toEqual(["at", "firstAudio", "firstChunk", "firstToken", "ref", "sttFinal"]);
  });

  it("the notice is a regression only: steady calls over the goal never raise it; 30% slower than the owner's own calls does (once a week); back to normal clears it", () => {
    const h = rec();
    const aCall = (ms: number) => { h.r.callStart(); for (let i = 0; i < 3; i++) reply(h, { since: 1_000, text: ms - 1_420, chunk: 400, audio: 20, id: `sp-${i}` }); return h.r.callEnd().verdict; };
    for (let i = 0; i < 8; i++) expect(aCall(2_000).action).not.toBe("raise"); // always over 1.2 s: never a notice
    expect(aCall(2_000)).toEqual({ action: "clear" });
    expect(aCall(2_800).action).toBe("clear"); // one slow call: the window's median is still the usual
    const v = aCall(2_800); // two of the last three: the median is 40% slower
    expect(v).toEqual({ action: "raise", p50Ms: 2_800, baselineMs: 2_000, calls: VOICE_LATENCY.consistentCalls });
    expect(h.store.read().noticedAt).toBe(h.clock.t);
    expect(aCall(2_800).action).toBe("none"); // raised already this week
    aCall(2_000);
    expect(aCall(2_000)).toEqual({ action: "clear" });
  });

  it("a finished nightly run joins its baseline; a regression raises the notice once a week and never becomes the baseline", () => {
    const h = rec();
    const night = (firstAudio: number, regression = false): SelfTestReport => ({ at: "", ok: !regression, budgetMs: 1_400, tts: "kokoro", scriptedReply: true, regression, stages: { likelyEnd: null, sttFinal: 900, firstToken: 900, firstChunk: null, firstAudio } });
    for (let i = 0; i < 9; i++) expect(recordSelfTest(h.store, night(1_150), h.clock.t)).toBe("clear");
    expect(h.store.read().selfTest.history).toHaveLength(VOICE_SELFTEST.historyNights);
    expect(recordSelfTest(h.store, night(1_500, true), h.clock.t)).toBe("raise");
    expect(recordSelfTest(h.store, night(1_500, true), h.clock.t + DAY)).toBe("none"); // once a week
    expect(h.store.read().selfTest.history.every((x) => x === 1_150)).toBe(true);
  });

  it("keeps the last 50 calls", () => {
    const h = rec();
    for (let i = 0; i < 55; i++) { h.r.callStart(); reply(h, { since: 500, text: 100, chunk: 100, audio: 10, id: "a" }); h.r.callEnd(); }
    const calls = h.store.read().calls;
    expect(calls).toHaveLength(VOICE_LATENCY.keepCalls);
    expect(calls.at(-1)!.id).toBe("call-55");
  });
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };
  c.stdin = { end: vi.fn(), write: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.kill = vi.fn();
  return c;
}

describe("5.8: main feeds the recorder from the helper and the renderer", () => {
  it("parses the final's sinceVoiceMs (and a final without it is as before)", () => {
    expect(parseDictationLine('{"type":"final","text":"Hi.","engine":"apple","sinceVoiceMs":912}')).toEqual({ type: "final", text: "Hi.", engine: "apple", sinceVoiceMs: 912 });
    expect(parseDictationLine('{"type":"final","text":"Hi."}')).toEqual({ type: "final", text: "Hi." });
    expect(parseDictationLine('{"type":"final","text":"Hi.","sinceVoiceMs":-5}')).toEqual({ type: "final", text: "Hi." });
  });

  it("a call's final, marks, reply lines and first audio reach it; dictation (the composer mic) never does", async () => {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const children: ReturnType<typeof fakeChild>[] = [];
    const latency = { final: vi.fn(), mark: vi.fn(), line: vi.fn(), chunk: vi.fn(), audio: vi.fn() };
    const cached = Buffer.alloc(4 * 100);
    registerDictation({
      binary: "bots-dictation", log: () => {}, latency,
      spawnFn: vi.fn(() => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; }) as never,
      phrases: { get: () => cached, has: () => true, put: () => {} } as never,
    });
    const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    await dispatch("dictation.start", { sessionId: "d1" }); // the composer mic
    children[0]!.stdout.emit("data", Buffer.from('{"type":"final","text":"note","sinceVoiceMs":700}\n'));
    expect(latency.final).not.toHaveBeenCalled();
    await dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const c = children[1]!;
    c.stdout.emit("data", Buffer.from('{"type":"final","text":"What time is it?","sinceVoiceMs":950}\n'));
    expect(latency.final).toHaveBeenCalledWith(950);
    await dispatch("dictation.mark", { sessionId: "c1", what: "sent" });
    expect(latency.mark).toHaveBeenCalledWith("sent");
    await dispatch("dictation.speak", { sessionId: "c1", id: "sp-ack", text: "Mm.", voice: "kokoro:af_heart", cache: true });
    expect(latency.line).not.toHaveBeenCalled(); // the call's own sound
    await dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "It's three.", voice: "kokoro:af_heart", cache: true, reply: true });
    expect(latency.line).toHaveBeenCalledWith("sp-1");
    expect(latency.chunk).toHaveBeenCalledWith("sp-1"); // a cached line's audio is ready at once
    c.stdout.emit("data", Buffer.from('{"type":"speak-audio","id":"sp-1"}\n'));
    expect(latency.audio).toHaveBeenCalledWith("sp-1");
  });

  it("the natives: a call on and off answers with the verdict; Settings reads the last call's first audio", async () => {
    const handlers = new Map<string, (a: unknown) => unknown>();
    const clock = { t: 5_000_000 };
    const { recorder } = registerVoiceLatency((n, fn) => void handlers.set(n, fn), { userData: tmp(), now: () => clock.t });
    expect(handlers.get("voice.latency.last")!({})).toEqual({ firstAudioMs: null, measured: 0, over: 0, endedAt: null, regressed: false });
    handlers.get("voice.latency.call")!({ on: true });
    for (let i = 0; i < 3; i++) { recorder.final(800); recorder.mark("sent"); recorder.line(`s${i}`); clock.t += 400; recorder.chunk(`s${i}`); recorder.audio(`s${i}`); clock.t += 2_000; }
    const r = handlers.get("voice.latency.call")!({ on: false }) as { firstAudioMs: number; measured: number; verdict: { action: string } };
    expect(r).toMatchObject({ firstAudioMs: 1_200, measured: 3, verdict: { action: "none" } }); // no baseline yet
    expect(handlers.get("voice.latency.last")!({})).toMatchObject({ firstAudioMs: 1_200, measured: 3, over: 0, regressed: false });
    expect(() => handlers.get("voice.latency.call")!({})).toThrow();
  });
});
