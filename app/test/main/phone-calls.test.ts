import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneCalls } from "../../src/main/phone/calls";
import type { CallLink } from "../../src/main/phone/server";
import { helperArgs, registerDictation, type RemoteAudio } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Bug 198: the call bridge between the phone's socket and the Mac's call helper.

function link(deviceId = "dev-1") {
  const sent: Record<string, unknown>[] = [];
  const audio: Buffer[] = [];
  const l: CallLink = { deviceId, send: (m) => void sent.push(m), audio: (p) => void audio.push(p), close: () => {} };
  return { l, sent, audio };
}

function calls() {
  const toRenderer: unknown[] = [];
  const fed: Buffer[] = [];
  const muted: boolean[] = [];
  const c = new PhoneCalls({ toRenderer: (e) => void toRenderer.push(e), feed: (p) => { fed.push(p); return true; }, muteHelper: (m) => void muted.push(m) });
  return { c, toRenderer, fed, muted };
}

afterEach(() => vi.useRealTimers());

describe("PhoneCalls", () => {
  it("a call opens the Mac's call screen; the phone's microphone flows only once the helper is up", () => {
    const { c, toRenderer, fed } = calls();
    const p = link();
    c.call(p.l, "nova");
    expect(toRenderer).toEqual([{ type: "call", botId: "nova", seq: 1 }]);
    expect(p.sent).toEqual([{ type: "connecting", botId: "nova" }]);
    expect(c.active()).toBe(true);
    c.mic(p.l, Buffer.alloc(3200));
    expect(fed).toHaveLength(0);
    c.event({ type: "ready" }, "s1");
    expect(p.sent.at(-1)).toEqual({ type: "live" });
    c.mic(p.l, Buffer.alloc(3200));
    expect(fed).toHaveLength(1);
  });

  it("mirrors what the helper hears and says, and its audio, to the phone", () => {
    const { c } = calls();
    const p = link();
    c.call(p.l, "nova");
    c.event({ type: "ready" }, "s1");
    c.event({ type: "partial", text: "hello no" }, "s1");
    c.event({ type: "final", text: " hello nova " }, "s1");
    c.line("Hi! What can I do?");
    c.event({ type: "speak-audio", id: "sp-1" }, "s1");
    c.out(Buffer.from([1, 2]));
    c.event({ type: "barge-in" }, "s1");
    c.event({ type: "speak-end", id: "sp-1", interrupted: true }, "s1");
    c.flush();
    expect(p.sent.slice(2)).toEqual([
      { type: "partial", text: "hello no" }, { type: "heard", text: "hello nova" }, { type: "line", text: "Hi! What can I do?" },
      { type: "speaking" }, { type: "flush" }, { type: "flush" }, { type: "flush" },
    ]);
    expect(p.audio).toEqual([Buffer.from([1, 2])]);
  });

  it("the phone hanging up (or its socket dropping) closes the call screen", () => {
    const { c, toRenderer } = calls();
    const p = link();
    c.call(p.l, "nova");
    c.hangup(p.l);
    expect(toRenderer.at(-1)).toEqual({ type: "hangup", botId: "nova", seq: 1 });
    expect(p.sent.at(-1)).toEqual({ type: "ended", reason: "phone" });
    expect(c.active()).toBe(false);
    const q = link();
    c.call(q.l, "nova");
    c.closed(q.l);
    expect(c.active()).toBe(false);
  });

  it("the Mac ending the call tells the phone — but a late end for an older call can't end a newer one", () => {
    const { c } = calls();
    const p = link();
    c.call(p.l, "nova");
    c.hangup(p.l);
    const q = link();
    c.call(q.l, "nova");
    c.endedOnMac("nova", 1);
    expect(c.active()).toBe(true);
    c.endedOnMac("nova", 2);
    expect(c.active()).toBe(false);
    expect(q.sent.at(-1)).toEqual({ type: "ended", reason: "mac" });
  });

  it("a second phone takes the call over; the first is told", () => {
    const { c, toRenderer } = calls();
    const a = link("a"), b = link("b");
    c.call(a.l, "nova");
    c.call(b.l, "atlas");
    expect(a.sent.at(-1)).toEqual({ type: "ended", reason: "elsewhere" });
    expect(toRenderer).toEqual([{ type: "call", botId: "nova", seq: 1 }, { type: "hangup", botId: "nova", seq: 1 }, { type: "call", botId: "atlas", seq: 2 }]);
    c.mic(a.l, Buffer.alloc(2));
    expect(c.current()).toMatchObject({ botId: "atlas", deviceId: "b" });
  });

  it("mute goes to the helper, and again to a helper that comes up later in the call", () => {
    const { c, muted } = calls();
    const p = link();
    c.call(p.l, "nova");
    c.event({ type: "ready" }, "s1");
    c.mute(p.l, true);
    c.event({ type: "ready" }, "s2");
    expect(muted).toEqual([true, true]);
  });

  it("gives up if the Mac never brings the call up", () => {
    vi.useFakeTimers();
    const { c, toRenderer } = calls();
    const p = link();
    c.call(p.l, "nova");
    vi.advanceTimersByTime(20_001);
    expect(p.sent.at(-1)).toEqual({ type: "ended", reason: "failed" });
    expect(toRenderer.at(-1)).toEqual({ type: "hangup", botId: "nova", seq: 1 });
  });
});

// ---- the helper side: dictation.ts with a phone call live ----

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }; stdout: EventEmitter };
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.stdout = new EventEmitter();
  return child;
}

describe("dictation with a phone call live", () => {
  function setup(active: boolean) {
    const sent: { channel: string; payload: { type?: string } }[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (_c: string, m: { channel: string; payload: { type?: string } }) => sent.push(m) } };
    const h = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void h.set(ch, fn) } as never, () => win as never);
    const kids: ReturnType<typeof fakeChild>[] = [];
    const spawnFn = vi.fn((_bin: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const remote: RemoteAudio & { outs: Buffer[]; evs: string[]; lines: string[]; flushes: number } = {
      outs: [], evs: [], lines: [], flushes: 0,
      active: () => active, out(p) { this.outs.push(p); }, event(e) { this.evs.push(e.type); }, line(t) { this.lines.push(t); }, flush() { this.flushes++; },
    };
    const micAccess = vi.fn(async () => "granted" as const);
    const d = registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, remote, micAccess, devices: () => ({ input: "USB-MIC", output: "USB-SPK" }) });
    const call = (name: string, args: unknown) => h.get("native")!({}, { name, args });
    return { sent, kids, spawnFn, remote, micAccess, d, call };
  }

  it("the helper runs with --remote-audio: no voice processing, no Mac devices, no microphone prompt", async () => {
    const t = setup(true);
    await t.call("dictation.start", { sessionId: "s1", mode: "call" });
    const args = t.spawnFn.mock.calls[0]![1] as string[];
    expect(args).toContain("--remote-audio");
    expect(args).not.toContain("--voice-processing");
    expect(args).not.toContain("--input-device");
    expect(args).not.toContain("--output-device");
    expect(t.micAccess).not.toHaveBeenCalled();
  });

  it("a Mac call is unchanged when no phone call is live", async () => {
    const t = setup(false);
    await t.call("dictation.start", { sessionId: "s1", mode: "call" });
    const args = t.spawnFn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--remote-audio");
    expect(args).toContain("--voice-processing");
    expect(t.micAccess).toHaveBeenCalled();
    expect(t.d.feedRemote(Buffer.alloc(4))).toBe(false);
  });

  it("the helper's audio goes to the phone, never to the renderer; the phone's mic goes to the helper", async () => {
    const t = setup(true);
    await t.call("dictation.start", { sessionId: "s1", mode: "call" });
    const pcm = Buffer.from([1, 0, 2, 0]);
    t.kids[0]!.stdout.emit("data", Buffer.from(`{"type":"ready","source":"remote"}\n{"type":"out","data":"${pcm.toString("base64")}"}\n{"type":"final","text":"hi"}\n`));
    expect(t.remote.outs).toEqual([pcm]);
    expect(t.remote.evs).toEqual(["ready", "final"]);
    expect(t.sent.map((s) => s.payload.type)).toEqual(["ready", "final"]);
    expect(t.d.feedRemote(Buffer.from([5, 0, 6, 0]))).toBe(true);
    expect(t.kids[0]!.stdin.write).toHaveBeenLastCalledWith(`mic ${Buffer.from([5, 0, 6, 0]).toString("base64")}\n`);
    expect(t.d.feedRemote(Buffer.from([1]))).toBe(false);
    t.d.muteRemote(true);
    expect(t.kids[0]!.stdin.write).toHaveBeenLastCalledWith("mute\n");
  });

  it("backpressure: a helper not reading its stdin makes the phone's frames drop, not pile up in main", async () => {
    const t = setup(true);
    await t.call("dictation.start", { sessionId: "s1", mode: "call" });
    const stdin = t.kids[0]!.stdin as unknown as { write: ReturnType<typeof vi.fn>; once: (ev: string, cb: () => void) => void; writableLength: number };
    let drain: (() => void) | null = null;
    stdin.once = (_ev, cb) => { drain = cb; };
    stdin.write.mockReturnValueOnce(false);
    expect(t.d.feedRemote(Buffer.alloc(3200))).toBe(true);
    const writes = stdin.write.mock.calls.length;
    expect(t.d.feedRemote(Buffer.alloc(3200))).toBe(false);
    expect(stdin.write.mock.calls.length).toBe(writes);
    drain!();
    expect(t.d.feedRemote(Buffer.alloc(3200))).toBe(true);
    stdin.writableLength = 300 * 1024;
    expect(t.d.feedRemote(Buffer.alloc(3200))).toBe(false);
  });

  it("a spoken line is captioned on the phone, and a hush flushes the phone's queue", async () => {
    const t = setup(true);
    await t.call("dictation.start", { sessionId: "s1", mode: "call" });
    await t.call("dictation.speak", { sessionId: "s1", id: "sp-1", text: "Hello there." });
    expect(t.remote.lines).toEqual(["Hello there."]);
    await t.call("dictation.hush", { sessionId: "s1" });
    expect(t.remote.flushes).toBe(1);
  });

  it("builds the argv", () => {
    expect(helperArgs("call", undefined, { input: "A", output: "B" }, null, undefined, undefined, [], true)).toEqual(["--mode", "call", "--remote-audio", "--silence-ms", expect.any(String)]);
  });
});
