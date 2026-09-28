import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { paramCandidates, teachAnalyzeProvider } from "../../teach/analyze";
import { CdpClient, type CdpLike } from "../../teach/cdp";
import { appendQueueEntry, findQueueEntry } from "../../teach/queue";
import { ffmpegArgs, TeachRecorder, type ChildLike } from "../../teach/recorder";
import { redactUrl, type RawField } from "../../teach/redact";
import { startSidecar, type SidecarEvent } from "../../teach/sidecar";
import type { XInputLike } from "../../teach/xinput";
import { tmpConfig } from "../helpers";

class FakeChild extends EventEmitter implements ChildLike {
  pid = 7;
  stdin = new PassThrough();
  stderr = new PassThrough();
  constructor() {
    super();
    this.stdin.on("data", (b: Buffer) => { if (b.toString().includes("q")) setTimeout(() => this.emit("exit", 0), 5); });
  }
  kill() { setTimeout(() => this.emit("exit", null), 5); return true; }
}

describe("I8: ffmpeg writes only a local mp4", () => {
  it("forces -f mp4 and -protocol_whitelist file for the output", () => {
    const a = ffmpegArgs(":3", "/p/demo.mp4");
    expect(a.slice(-5)).toEqual(["-protocol_whitelist", "file", "-f", "mp4", "/p/demo.mp4"]);
  });
});

describe("I8: sessions live under hostPrivate until scrubbed", () => {
  it("records in hostPrivate, scrubs there, then publishes to the workspace; the queue names the published folder", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const hub = new SseHub();
    const bots = new BotService({ cfg, hub, settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    const scrubbedAt: string[] = [];
    const rec = new TeachRecorder({
      cfg, bots, hub, runner: { enqueueWake: () => "t" }, displayOf: () => ":3",
      spawn: () => new FakeChild(), setTimer: () => 0, clearTimer: () => {},
      afterFinalize: async (s) => { scrubbedAt.push(s.sessionDir); fs.writeFileSync(path.join(s.sessionDir, "events.jsonl"), "{}\n"); },
    });
    const st = rec.start(id, "File an expense");
    const privateDir = path.join(cfg.hostPrivate, "teach-sessions", st.sessionId!);
    expect(st.sessionDir).toBe(privateDir);
    expect(fs.existsSync(path.join(cfg.workspace, "teach-sessions", st.sessionId!))).toBe(false);
    await rec.stop(id);
    const published = path.join(cfg.workspace, ".host-out", "teach", st.sessionId!) /* secfix round 3 */;
    expect(scrubbedAt).toEqual([privateDir]);
    expect(fs.existsSync(privateDir)).toBe(false);
    expect(fs.readFileSync(path.join(published, "events.jsonl"), "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(published, "session.json"))).toBe(true);
    expect(rec.current()!.sessionDir).toBe(published);
    expect(findQueueEntry({ keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl"), sessionId: st.sessionId!, botId: id })!.sessionDir).toBe(published);
  });
});

describe("I8: URL and parameter redaction", () => {
  it("redactUrl drops fragments, masks secret-named params and runs the scanner", () => {
    const scan = (t: string) => t.split("sk_live_SCANNED").join("[secret:STRIPE_KEY]");
    expect(redactUrl("https://x.example/cb?code=abc123&state=ok&access_token=zzz&q=sk_live_SCANNED#id_token=eyJ", scan))
      .toBe("https://x.example/cb?code=%5Bredacted%5D&state=ok&access_token=%5Bredacted%5D&q=%5Bsecret%3ASTRIPE_KEY%5D");
    expect(redactUrl("not a url sk_live_SCANNED", scan)).toBe("not a url [secret:STRIPE_KEY]");
  });

  it("the sidecar stores nav and target URLs redacted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-priv-"));
    const cbs: { nav?: (e: { url: string; title: string; tabId: string }) => void } = {};
    const cdp: CdpLike = {
      onNavigate: (cb) => { cbs.nav = cb; }, onField: () => {},
      targetAt: async () => ({ role: "link", name: "Reset", url: "https://x.example/reset?token=abc#frag", bbox: null }),
      snapshot: async () => null, close: async () => {},
    };
    let closed = false;
    const w: { wake?: () => void } = {};
    const q: string[] = [];
    const x: XInputLike = {
      lines: { [Symbol.asyncIterator]: () => ({ next: async (): Promise<IteratorResult<string>> => {
        while (!q.length && !closed) await new Promise<void>((r) => { w.wake = r; });
        return q.length ? { value: q.shift()!, done: false } : { value: undefined, done: true };
      } }) },
      keysym: () => null, pointer: async () => ({ x: 1, y: 1 }), activeWindow: async () => ({ title: "Chromium", class: "chromium" }),
      close: () => { closed = true; w.wake?.(); },
    };
    const h = startSidecar({ sessionDir: dir, startedAtMs: 0, xinput: x, cdp, now: () => 10, redact: (t) => t.split("SCANME").join("[secret:K]") });
    cbs.nav!({ url: "https://x.example/login?password=hunter2&next=SCANME#tok", title: "Login", tabId: "t1" });
    q.push("EVENT type 15 (RawButtonPress)", "    detail: 1");
    w.wake?.();
    await new Promise((r) => setTimeout(r, 50));
    await h.stop();
    const text = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("SCANME");
    expect(text).not.toContain("#tok");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("#frag");
  });

  it("paramCandidates marks secret-looking names and values secret:true, with no value", () => {
    const ev = (url: string): SidecarEvent => ({ t: 1, type: "nav", url, title: "", tabId: "t" });
    const fieldEv = (name: string, value: string): SidecarEvent => ({ t: 2, type: "field", role: "textbox", name, inputType: "text", value });
    const c = paramCandidates([ev("https://x.example/a?session_key=k1&city=Paris&sig=Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Ef7Gh0"), fieldEv("api_token", "abc"), fieldEv("City", "Rome")]);
    const by = Object.fromEntries(c.map((x) => [x.label, x]));
    expect(by.session_key).toMatchObject({ secret: true, value: null, typeGuess: "secret" });
    expect(by.sig).toMatchObject({ secret: true, value: null });
    expect(by.city).toMatchObject({ secret: false, value: "Paris" });
    expect(by.api_token).toMatchObject({ secret: true, value: null });
    expect(by.City).toMatchObject({ secret: false, value: "Rome" });
  });
});

describe("I8: the CDP field binding only trusts its own isolated world", () => {
  it("drops bindingCalled from any executionContextId but the teach world's", async () => {
    const sockets: FakeWs[] = [];
    class FakeWs {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((m: { data: string }) => void) | null = null;
      constructor() { sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
      send(data: string) {
        const m = JSON.parse(data) as { id: number; method: string };
        const result = m.method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F1" } } } : m.method === "Page.createIsolatedWorld" ? { executionContextId: 77 } : {};
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
      emit(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    }
    const fetchList = (async () => new Response(JSON.stringify([{ id: "p1", type: "page", webSocketDebuggerUrl: "ws://x" }]))) as unknown as typeof fetch;
    const c = await CdpClient.connect(9222, { fetch: fetchList, ws: () => new FakeWs() as unknown as WebSocket, pollMs: 0 });
    const got: RawField[] = [];
    c.onField((f) => got.push(f));
    const payload = JSON.stringify({ role: "textbox", name: "amount", inputType: "text", autocomplete: "", label: "Amount", value: "42" });
    sockets[0]!.emit({ method: "Runtime.bindingCalled", params: { name: "__botTeachField", payload, executionContextId: 1 } }); // the page's main world
    sockets[0]!.emit({ method: "Runtime.bindingCalled", params: { name: "__botTeachField", payload, executionContextId: 77 } });
    sockets[0]!.emit({ method: "Runtime.executionContextCreated", params: { context: { id: 88, name: "__botTeach", auxData: { frameId: "F1" } } } });
    sockets[0]!.emit({ method: "Runtime.bindingCalled", params: { name: "__botTeachField", payload, executionContextId: 88 } });
    expect(got).toHaveLength(2);
    await c.close();
  });
});

describe("I8: TeachAnalyze runs ffmpeg only on a real, host-published video", () => {
  it("refuses a demo.mp4 that is a symlink", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    const dir = path.join(cfg.workspace, "teach-sessions", "teach-20260918-171200-sym");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ goal: "g", startedAtMs: 1, videoStartPtsMs: 0 }));
    fs.symlinkSync("/etc/passwd", path.join(dir, "demo.mp4"));
    appendQueueEntry({ keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl"), entry: { sessionId: "teach-20260918-171200-sym", botId: "bot-1", sessionDir: dir, createdAt: 1 } });
    let called = false;
    const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "teach", hidden: true, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
    const tool = teachAnalyzeProvider({ cfg, extractFrames: async () => { called = true; return []; } })("bot-1", () => slot)[0]!;
    const r = await tool.handler({ session: "teach-20260918-171200-sym" });
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
});
