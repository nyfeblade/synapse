import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

export interface CdpPage {
  readonly targetId: string;
  url(): string;
  title(): Promise<string>;
  goto(url: string, o: { timeoutMs: number }): Promise<void>;
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  closed(): boolean;
  bringToFront(): Promise<void>;
  screenshotWebp(): Promise<Buffer>;
  evaluate<T>(js: string): Promise<T>;
  close(): Promise<void>;
  mouse: { click(x: number, y: number, o?: { button?: "left" | "right" | "middle"; count?: number }): Promise<void>; move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { type(t: string): Promise<void>; press(k: string): Promise<void>; insertText(t: string): Promise<void> };
}
export interface CdpBrowser {
  pages(): Promise<CdpPage[]>;
  newPage(): Promise<CdpPage>;
  targets(): Promise<{ targetId: string; type: string; url: string }[]>;
  browserSend<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  connected(): boolean;
  close(): Promise<void>;
}
export interface BrowserConnector { connect(port: number): Promise<CdpBrowser> }

class PwPage implements CdpPage {
  constructor(private p: Page, private s: CDPSession, readonly targetId: string) {}
  url() { return this.p.url(); }
  title() { return this.p.title(); }
  async goto(url: string, o: { timeoutMs: number }) { await this.p.goto(url, { timeout: o.timeoutMs, waitUntil: "domcontentloaded" }); }
  send<T>(method: string, params?: Record<string, unknown>): Promise<T> { return this.s.send(method as never, params as never) as Promise<T>; }
  closed() { return this.p.isClosed(); }
  bringToFront() { return this.p.bringToFront(); }
  async screenshotWebp() {
    const r = await this.s.send("Page.captureScreenshot", { format: "webp", quality: 80 });
    return Buffer.from(r.data, "base64");
  }
  evaluate<T>(js: string): Promise<T> { return this.p.evaluate(js) as Promise<T>; }
  close() { return this.p.close(); }
  mouse = {
    click: (x: number, y: number, o?: { button?: "left" | "right" | "middle"; count?: number }) => this.p.mouse.click(x, y, { button: o?.button, clickCount: o?.count }),
    move: (x: number, y: number) => this.p.mouse.move(x, y, { steps: 5 }),
    down: () => this.p.mouse.down(),
    up: () => this.p.mouse.up(),
    wheel: (dx: number, dy: number) => this.p.mouse.wheel(dx, dy),
  };
  keyboard = {
    type: (t: string) => this.p.keyboard.type(t, { delay: 12 }),
    press: (k: string) => this.p.keyboard.press(k),
    insertText: (t: string) => this.p.keyboard.insertText(t),
  };
}

/** BRW-04: Playwright-core over CDP to the Bot's Chromium (never launches a browser; no bundled browsers needed). */
export class PlaywrightConnector implements BrowserConnector {
  constructor(
    private dial: (url: string) => ReturnType<typeof chromium.connectOverCDP> = (url) => chromium.connectOverCDP(url, { timeout: 10_000 }),
    private o: { retryMs: number; stepMs: number } = { retryMs: 20_000, stepMs: 250 },
  ) {}

  /** T29 box finding: a screen's Chromium opens its CDP port a moment after `bot-display start`; wait for it. */
  private async dialWhenUp(url: string): ReturnType<typeof chromium.connectOverCDP> {
    const until = Date.now() + this.o.retryMs;
    for (;;) {
      try {
        return await this.dial(url);
      } catch (e) {
        if (!/ECONNREFUSED/.test(String((e as Error).message)) || Date.now() >= until) throw e;
        await new Promise((r) => setTimeout(r, this.o.stepMs));
      }
    }
  }

  async connect(port: number): Promise<CdpBrowser> {
    const b = await this.dialWhenUp(`http://127.0.0.1:${port}`);
    const ctx: BrowserContext = b.contexts()[0] ?? (await b.newContext());
    const bs = await b.newBrowserCDPSession();
    const cache = new WeakMap<Page, PwPage>();
    const wrap = async (page: Page): Promise<PwPage> => {
      const hit = cache.get(page);
      if (hit) return hit;
      const s = await ctx.newCDPSession(page);
      const { targetInfo } = await s.send("Target.getTargetInfo");
      const w = new PwPage(page, s, targetInfo.targetId);
      cache.set(page, w);
      return w;
    };
    return {
      pages: async () => Promise.all(ctx.pages().map(wrap)),
      newPage: async () => wrap(await ctx.newPage()),
      targets: async () => ((await bs.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] }).targetInfos.map((t) => ({ targetId: t.targetId, type: t.type, url: t.url })),
      browserSend: <T>(method: string, params?: Record<string, unknown>) => bs.send(method as never, params as never) as Promise<T>,
      connected: () => b.isConnected(),
      close: () => b.close(),
    };
  }
}
