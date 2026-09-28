/**
 * mac-browser: the Chrome DevTools Protocol side. CdpConnection is a minimal client (one WebSocket, flattened target
 * sessions). CdpTab turns one page's CDP channel into the controller's Tab (the page agent in an isolated world,
 * trusted input, navigation, JPEG screenshots). ChromeDriver runs the user's installed Google Chrome with a DEDICATED
 * profile (its own --user-data-dir under the app's data; the user's normal profile is never touched), remote debugging
 * on 127.0.0.1 at a random port. The Electron fallback (electron-driver.ts) reuses CdpTab over webContents.debugger.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { BrowserDriver, Tab } from "./controller";
import { pageAgent, type PageAgent } from "./page-agent";
import { nameProfile, profileLock, quitProcess } from "./signin";

export const WORLD = "synapse";
const BINDING = "__synapseEvent";
const LOAD_MS = 15_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => void;
export interface CdpChannel {
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: Handler): () => void;
}

export class CdpConnection {
  private id = 0;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private handlers = new Map<string, Set<{ cb: Handler; session?: string }>>();
  private closed = false;
  private closers: (() => void)[] = [];

  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result);
        return;
      }
      for (const h of this.handlers.get(m.method ?? "") ?? []) if (h.session === m.sessionId || h.session === "*") { try { h.cb(m.params); } catch { /* a listener never breaks the socket */ } }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new Error("The browser closed."));
      this.waiting.clear();
      for (const f of this.closers) f();
    });
    ws.on("error", () => {});
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once("open", () => resolve(new CdpConnection(ws)));
      ws.once("error", reject);
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser closed."));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** `session` undefined = browser-level events; "*" = any session. */
  on(method: string, cb: Handler, session?: string): () => void {
    const set = this.handlers.get(method) ?? new Set();
    const h = { cb, session };
    set.add(h);
    this.handlers.set(method, set);
    return () => set.delete(h);
  }

  channel(sessionId: string): CdpChannel {
    return { send: (m, p) => this.send(m, p ?? {}, sessionId), on: (e, cb) => this.on(e, cb, sessionId) };
  }

  onClose(f: () => void): void { this.closers.push(f); }
  get isOpen(): boolean { return !this.closed; }
  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Tab: { code: "Tab", vk: 9 }, Escape: { code: "Escape", vk: 27 }, Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 }, ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 }, PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 }, Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 }, Space: { code: "Space", vk: 32, text: " " },
};
const MODS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export class CdpTab implements Tab {
  private ctx: number | null = null;
  private frame = "";
  private loading = false;
  private ev: ((k: string) => void)[] = [];
  private cl: (() => void)[] = [];
  private src: string;

  private constructor(readonly id: string, private ch: CdpChannel, private o: { init: string; close(): Promise<void>; front?(): Promise<void>; sleep?(ms: number): Promise<void> }) {
    // The agent, then the per-window init (the bar, top frame only), on every new document of this tab.
    this.src = `(${pageAgent.toString()})();\nif (window === window.top) { ${o.init} }`;
  }

  static async create(id: string, ch: CdpChannel, o: { init: string; close(): Promise<void>; front?(): Promise<void> }): Promise<CdpTab> {
    const t = new CdpTab(id, ch, o);
    await t.setup();
    return t;
  }

  private sleep(ms: number) { return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  private async setup(): Promise<void> {
    const ch = this.ch;
    ch.on("Runtime.executionContextCreated", (p: { context: { id: number; name: string; auxData?: { frameId?: string } } }) => {
      if (p.context.name === WORLD && p.context.auxData?.frameId === this.frame && this.ctx === null) this.ctx = p.context.id;
    });
    ch.on("Runtime.executionContextsCleared", () => { this.ctx = null; });
    ch.on("Runtime.executionContextDestroyed", (p: { executionContextId: number }) => { if (p.executionContextId === this.ctx) this.ctx = null; });
    ch.on("Runtime.bindingCalled", (p: { name: string; payload: string; executionContextId: number }) => {
      if (p.name !== BINDING || p.executionContextId !== this.ctx) return; // only our world in the top frame speaks
      let kind = "";
      try { kind = String((JSON.parse(p.payload) as { kind?: string }).kind ?? ""); } catch { return; }
      for (const f of this.ev) f(kind);
    });
    ch.on("Page.frameStartedLoading", (p: { frameId: string }) => { if (p.frameId === this.frame) this.loading = true; });
    ch.on("Page.frameStoppedLoading", (p: { frameId: string }) => { if (p.frameId === this.frame) this.loading = false; });
    ch.on("Inspector.detached", () => { for (const f of this.cl) f(); });
    await ch.send("Page.enable");
    await ch.send("Runtime.enable");
    const tree = await ch.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    this.frame = tree.frameTree.frame.id;
    await ch.send("Page.addScriptToEvaluateOnNewDocument", { source: this.src, worldName: WORLD });
    await ch.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
  }

  /** Our world in the current document: the one the new-document script made, else made now (the first blank page). */
  private async world(): Promise<number> {
    for (let i = 0; i < 20 && this.ctx === null; i++) await this.sleep(50);
    if (this.ctx !== null) return this.ctx;
    const r = await this.ch.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: this.frame, worldName: WORLD });
    this.ctx = r.executionContextId;
    await this.ch.send("Runtime.evaluate", { expression: this.src, contextId: this.ctx });
    return this.ctx;
  }

  private async evaluate<T>(expression: string, retry = true): Promise<T> {
    const contextId = await this.world();
    let r: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    try {
      r = await this.ch.send("Runtime.evaluate", { expression, contextId, returnByValue: true });
    } catch (e) {
      if (retry && /context/i.test((e as Error).message)) { this.ctx = null; return this.evaluate<T>(expression, false); }
      throw e;
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "page error");
    return r.result?.value as T;
  }

  agent<T>(fn: keyof PageAgent, ...args: unknown[]): Promise<T> {
    return this.evaluate<T>(`__syn.${String(fn)}(${args.map((a) => JSON.stringify(a ?? null)).join(",")})`);
  }

  async mouse(kind: "click" | "move", x: number, y: number): Promise<void> {
    await this.ch.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (kind === "move") return;
    await this.ch.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.ch.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async wheel(x: number, y: number, dy: number): Promise<void> {
    await this.ch.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
  }

  async insertText(text: string): Promise<void> { await this.ch.send("Input.insertText", { text }); }

  async key(name: string): Promise<void> {
    const parts = name.split("+").map((x) => x.trim()).filter(Boolean);
    const main = parts.pop() ?? "";
    const modifiers = parts.reduce((m, p) => m | (MODS[p.toLowerCase()] ?? 0), 0);
    const k = KEYS[main] ?? KEYS[main.charAt(0).toUpperCase() + main.slice(1).toLowerCase()];
    const key = k ? (main === "Space" ? " " : Object.keys(KEYS).find((x) => KEYS[x] === k)!) : main;
    const text = modifiers & ~8 ? undefined : k ? k.text : main.length === 1 ? main : undefined;
    const code = k?.code ?? (main.length === 1 ? (/[a-z]/i.test(main) ? `Key${main.toUpperCase()}` : /\d/.test(main) ? `Digit${main}` : "") : "");
    const vk = k?.vk ?? (main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0);
    await this.ch.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.ch.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
  }

  private async loaded(): Promise<void> {
    const until = Date.now() + LOAD_MS;
    while (this.loading && Date.now() < until) await this.sleep(50);
  }

  async navigate(url: string): Promise<void> {
    this.loading = true;
    const r = await this.ch.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) { this.loading = false; throw new Error(r.errorText); }
    await this.loaded();
  }

  async history(delta: -1 | 1): Promise<boolean> {
    const h = await this.ch.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const e = h.entries[h.currentIndex + delta];
    if (!e) return false;
    this.loading = true;
    await this.ch.send("Page.navigateToHistoryEntry", { entryId: e.id });
    await this.loaded();
    return true;
  }

  async settle(): Promise<void> {
    await this.sleep(150);
    await this.loaded();
  }

  async screenshot(maxWidth: number): Promise<string> {
    const m = await this.ch.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number } }>("Page.getLayoutMetrics");
    const v = m.cssVisualViewport;
    const dpr = (await this.evaluate<number>("devicePixelRatio").catch(() => 1)) || 1;
    // clip.scale applies on top of the device pixel ratio: the result is at most maxWidth px wide.
    const scale = Math.min(1, maxWidth / v.clientWidth) / dpr;
    const r = await this.ch.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60, captureBeyondViewport: false, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } });
    return r.data;
  }

  async front(): Promise<void> { if (this.o.front) await this.o.front(); else await this.ch.send("Page.bringToFront"); }
  async close(): Promise<void> { await this.o.close(); }
  onEvent(cb: (k: string) => void): void { this.ev.push(cb); }
  onClosed(cb: () => void): void { this.cl.push(cb); }
  closed(): void { for (const f of this.cl) f(); }
}

/** The user's installed Google Chrome, or null (then the Electron window is the fallback). */
export function findChrome(home = os.homedir(), exists: (p: string) => boolean = fs.existsSync): string | null {
  const rel = "Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const base of ["/Applications", path.join(home, "Applications")]) {
    const p = path.join(base, rel);
    if (exists(p)) return p;
  }
  return null;
}

/** The Chrome command line: a dedicated profile, loopback-only remote debugging on a random port, no first-run UI. */
export function chromeArgs(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--no-startup-window", "--disable-features=ChromeWhatsNewUI,PrivacySandboxSettings4",
  ];
}

export class ChromeDriver implements BrowserDriver {
  kind = "chrome" as const;
  private tabs = new Map<string, CdpTab>();
  /** Every target this driver made or adopted, with its window's init (a popup inherits its opener's). */
  private inits = new Map<string, string>();
  private popup: ((opener: string, tab: Tab) => void) | null = null;

  private constructor(private conn: CdpConnection, private proc: ChildProcess | null, private downloads: string) {}

  static async launch(o: { chrome: string; profileDir: string; downloads: string; headless?: boolean; timeoutMs?: number; spawnFn?: typeof spawn }): Promise<ChromeDriver> {
    fs.mkdirSync(o.profileDir, { recursive: true, mode: 0o700 });
    // Another Chrome on this profile (the sign-in window, or a leftover) would take our launch as a hand-off and exit.
    if (profileLock(o.profileDir)) throw new Error("the browser profile is open in another Chrome window");
    nameProfile(o.profileDir);
    const portFile = path.join(o.profileDir, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const args = [...chromeArgs(o.profileDir), ...(o.headless ? ["--headless=new", "--window-size=1280,800"] : [])];
    const proc = (o.spawnFn ?? spawn)(o.chrome, args, { stdio: "ignore", detached: false });
    const until = Date.now() + (o.timeoutMs ?? 20_000);
    let ws = "";
    while (!ws) {
      if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode}). Is another copy using this profile?`);
      if (Date.now() > until) { proc.kill(); throw new Error("Chrome did not open its debugging port in time."); }
      try {
        const [port, p] = fs.readFileSync(portFile, "utf8").split("\n");
        if (port && p) ws = `ws://127.0.0.1:${port.trim()}${p.trim()}`;
      } catch { /* not yet */ }
      if (!ws) await new Promise((r) => setTimeout(r, 100));
    }
    const conn = await CdpConnection.connect(ws);
    const d = new ChromeDriver(conn, proc, o.downloads);
    await d.init();
    return d;
  }

  private async init(): Promise<void> {
    await this.conn.send("Target.setDiscoverTargets", { discover: true });
    await this.conn.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: this.downloads, eventsEnabled: true });
    this.conn.on("Target.targetCreated", (p: { targetInfo: { targetId: string; type: string; openerId?: string } }) => {
      const t = p.targetInfo;
      if (t.type !== "page" || !t.openerId || !this.tabs.has(t.openerId) || this.inits.has(t.targetId)) return;
      void this.attach(t.targetId, this.inits.get(t.openerId) ?? "").then((tab) => this.popup?.(t.openerId!, tab)).catch(() => {});
    });
    this.conn.on("Target.targetDestroyed", (p: { targetId: string }) => {
      const t = this.tabs.get(p.targetId);
      this.inits.delete(p.targetId);
      if (!t) return;
      this.tabs.delete(p.targetId);
      t.closed();
    });
    this.conn.onClose(() => { for (const t of this.tabs.values()) t.closed(); this.tabs.clear(); });
  }

  private async attach(targetId: string, init: string): Promise<CdpTab> {
    this.inits.set(targetId, init);
    const { sessionId } = await this.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const tab = await CdpTab.create(targetId, this.conn.channel(sessionId), { init, close: async () => { await this.conn.send("Target.closeTarget", { targetId }).catch(() => {}); } });
    this.tabs.set(targetId, tab);
    return tab;
  }

  async newWindow(o: { init: string }): Promise<Tab> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
    return this.attach(targetId, o.init);
  }

  onPopup(cb: (opener: string, tab: Tab) => void): void { this.popup = cb; }

  download(trigger: () => Promise<void>, timeoutMs: number): Promise<{ path: string } | null> {
    return new Promise((resolve) => {
      let name = "";
      let guid = "";
      const offs: (() => void)[] = [];
      const done = (v: { path: string } | null) => { for (const f of offs) f(); clearTimeout(t); resolve(v); };
      const t = setTimeout(() => done(null), timeoutMs);
      offs.push(this.conn.on("Browser.downloadWillBegin", (p: { guid: string; suggestedFilename: string }) => { if (!guid) { guid = p.guid; name = p.suggestedFilename; } }));
      offs.push(this.conn.on("Browser.downloadProgress", (p: { guid: string; state: string }) => {
        if (p.guid !== guid) return;
        if (p.state === "completed") done({ path: path.join(this.downloads, name) });
        else if (p.state === "canceled") done(null);
      }));
      trigger().catch(() => done(null));
    });
  }

  alive(): boolean { return this.conn.isOpen && (this.proc === null || this.proc.exitCode === null); }

  async close(): Promise<void> {
    await this.conn.send("Browser.close").catch(() => {});
    this.conn.close();
    // Let Chrome finish its own shutdown (it writes cookies and marks a clean exit); a kill mid-way can lose sign-ins.
    if (this.proc) await quitProcess(this.proc, 5_000, null);
  }
}
