// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { STRB, type BrowserArgs } from "@synapse/shared";
import { BrowserController, type BrowserDriver, type ControllerRequest, type Tab } from "../../src/main/browser/controller";
import { pageAgent, type PageAgent } from "../../src/main/browser/page-agent";

/**
 * The controller against a fake tab: jsdom runs the REAL page agent; clicks land on the element under the point
 * (every clickable in these fixtures has its own data-y). No browser needed.
 */
Element.prototype.getBoundingClientRect = function (this: Element) {
  const y = Number((this as HTMLElement).dataset?.y ?? 10);
  return { x: 0, y, top: y, left: 0, bottom: y + 20, right: 100, width: 100, height: 20, toJSON() {} } as DOMRect;
};
const syn = () => (globalThis as unknown as { __syn: PageAgent }).__syn;

const PAGES: Record<string, { title: string; html: string }> = {
  "http://t.test/": { title: "Home", html: `<h1>Home</h1><a href="/shop" data-y="40">Shop</a><button data-y="70" id="more">Show more</button><div id="out"></div>` },
  "http://t.test/shop": { title: "Shop", html: `<h1>Cart</h1><form method="post" action="/buy"><input aria-label="Card number" data-y="100"><input type="password" aria-label="Password" data-y="130"><button data-y="160">Pay now</button></form>` },
  // full-auto-quiet: an ordinary POST form that is not one of the five categories.
  "http://t.test/signup": { title: "Sign up", html: `<h1>Create your account</h1><form method="post" action="/signup"><input aria-label="Full name" data-y="100"><button data-y="160">Create account</button></form>` },
};

class FakeTab implements Tab {
  static n = 0;
  id = `tab${++FakeTab.n}`;
  url = "about:blank";
  typed: string[] = [];
  keys: string[] = [];
  clicks: string[] = [];
  private ev: ((k: string) => void)[] = [];
  private cl: (() => void)[] = [];
  constructor(private init: string) { this.load("about:blank"); }
  private load(url: string) {
    this.url = url;
    const p = PAGES[url] ?? { title: "", html: "" };
    document.title = p.title;
    document.body.innerHTML = p.html;
    history.replaceState(null, "", "/"); // jsdom's location stays on its own origin; the agent reports it
    delete (globalThis as { __syn?: unknown }).__syn;
    pageAgent();
    (globalThis as { __synapseEvent?: (p: string) => void }).__synapseEvent = (x) => this.emit(JSON.parse(x).kind);
    new Function(this.init)();
    const more = document.getElementById("more");
    more?.addEventListener("click", () => { document.getElementById("out")!.innerHTML = `<p data-y="200">Loaded 3 more results</p>`; });
  }
  emit(k: string) { for (const f of this.ev) f(k); }
  async agent<T>(fn: keyof PageAgent, ...args: unknown[]): Promise<T> {
    const r = (syn()[fn] as (...a: unknown[]) => unknown)(...args) as T & { url?: string };
    if (fn === "collect" && r && typeof r === "object") (r as { url: string }).url = this.url;
    return r;
  }
  async mouse(kind: "click" | "move", x: number, y: number) {
    if (kind !== "click") return;
    const hit = [...document.querySelectorAll("[data-y]")].filter((e) => { const r = e.getBoundingClientRect(); return y >= r.top && y <= r.bottom && x >= r.left && x <= r.right; }).pop() as HTMLElement | undefined;
    if (!hit) return;
    this.clicks.push(hit.textContent ?? "");
    if (hit.tagName === "A") this.load(new URL(hit.getAttribute("href")!, this.url).href);
    else if (!hit.closest("form")) hit.click(); // jsdom can't submit a form; the click record is what these tests check
  }
  async wheel() {}
  async insertText(t: string) { const a = document.activeElement as HTMLInputElement; a.value += t; this.typed.push(t); }
  async key(k: string) { this.keys.push(k); }
  async navigate(url: string) { this.load(url); }
  async history() { return false; }
  async settle() {}
  async screenshot() { return "SlBFRw=="; }
  async front() {}
  async close() { for (const f of this.cl) f(); }
  onEvent(cb: (k: string) => void) { this.ev.push(cb); }
  onClosed(cb: () => void) { this.cl.push(cb); }
}

class FakeDriver implements BrowserDriver {
  kind = "chrome" as const;
  windows: FakeTab[] = [];
  async newWindow(o: { init: string }) { const t = new FakeTab(o.init); this.windows.push(t); return t; }
  onPopup() {}
  async download() { return null; }
  alive() { return true; }
  async close() {}
}

let now = 1_000;
let drv: FakeDriver;
let c: BrowserController;
beforeEach(() => {
  now = 1_000;
  drv = new FakeDriver();
  c = new BrowserController({ launch: async () => drv, now: () => now, log: () => {}, sleep: async () => { now += 250; } });
});
const req = (args: BrowserArgs, o: Partial<ControllerRequest> = {}): ControllerRequest => ({ botId: "b1", botName: "Ava", args, approved: false, origins: [], explicit: false, turn: "t1", userTurn: true, ...o });
const ok = async (r: ControllerRequest) => {
  const x = await c.handle(r);
  if (!x.ok) throw new Error(x.error);
  return x.reply;
};
const refOf = (text: string, name: string) => new RegExp(`\\[(e\\d+)\\] \\w+ "${name}"`).exec(text)![1]!;

describe("reading and acting", () => {
  it("open returns an outline with refs; an action returns only the diff", async () => {
    const r = await ok(req({ action: "open", url: "http://t.test/" }));
    expect(r.text).toContain('h1 "Home"');
    expect(r.text).toMatch(/\[e\d+\] button "Show more"/);
    expect(r.steps).toBe(1);
    const d = await ok(req({ action: "click", ref: refOf(r.text, "Show more") }));
    expect(d.text).toContain('+ "Loaded 3 more results"');
    expect(d.text).not.toContain("Shop");
    expect(d.steps).toBe(2);
  });

  it("a stale ref is refused with a pointer to the latest outline", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    const x = await c.handle(req({ action: "click", ref: "e999" }));
    expect(x).toMatchObject({ ok: false, error: STRB.staleRef("e999") });
  });

  it("screenshot is the explicit fallback: an image comes back and it says snapshot is cheaper", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    const r = await ok(req({ action: "screenshot" }));
    expect(r.image).toBe("SlBFRw==");
    expect(r.text).toMatch(/Prefer snapshot/);
  });
});

describe("consequential actions", () => {
  it("asks first, and only an approval for exactly that refused call lets it through", async () => {
    const r = await ok(req({ action: "open", url: "http://t.test/shop" }));
    const pay = refOf(r.text, "Pay now");
    const first = await c.handle(req({ action: "click", ref: pay }));
    expect(first).toMatchObject({ ok: false, needsApproval: true });
    expect((first as { error: string }).error).toContain("Click “Pay now”");
    expect(drv.windows[0]!.clicks).toEqual([]);
    expect(c.lastRefusalOrigin("b1")).toBe("t.test");
    // an approval for something else (no matching refusal) is not enough
    const other = await c.handle(req({ action: "click", ref: pay, value: "x" }, { approved: true }));
    expect(other).toMatchObject({ ok: false, needsApproval: true });
    // the approval that answered the card for this exact call runs it, once
    await c.handle(req({ action: "click", ref: pay }));
    await ok(req({ action: "click", ref: pay }, { approved: true }));
    expect(drv.windows[0]!.clicks).toEqual(["Pay now"]);
    expect(await c.handle(req({ action: "click", ref: pay }))).toMatchObject({ ok: false, needsApproval: true });
  });

  it("an explicit always-allow rule for the site skips the card", async () => {
    const r = await ok(req({ action: "open", url: "http://t.test/shop" }));
    await ok(req({ action: "click", ref: refOf(r.text, "Pay now") }, { origins: ["t.test"] }));
    expect(drv.windows[0]!.clicks).toEqual(["Pay now"]);
  });

  /**
   * full-auto-quiet: in Full auto the controller applies the same five-category policy as the tool guard and the
   * Mac coordinator (@synapse/shared full-auto.ts). Money still cards. An ordinary POST form does not.
   */
  it("Full auto: “Pay now” still cards, an ordinary form submit runs", async () => {
    const shop = await ok(req({ action: "open", url: "http://t.test/shop" }, { mode: "full-auto" }));
    const pay = await c.handle(req({ action: "click", ref: refOf(shop.text, "Pay now") }, { mode: "full-auto" }));
    expect(pay, "money always asks, in every mode").toMatchObject({ ok: false, needsApproval: true });

    const signup = await ok(req({ action: "open", url: "http://t.test/signup" }, { mode: "full-auto" }));
    const create = refOf(signup.text, "Create account");
    expect(await c.handle(req({ action: "click", ref: create }, { mode: "ask" })), "Ask is unchanged").toMatchObject({ ok: false, needsApproval: true });
    await ok(req({ action: "click", ref: create }, { mode: "full-auto" }));
    expect(drv.windows[0]!.clicks).toContain("Create account");
  });
});

describe("password and payment fields", () => {
  it("won't type into them unless the user gave the value this turn", async () => {
    const r = await ok(req({ action: "open", url: "http://t.test/shop" }));
    const card = refOf(r.text, "Card number");
    const pw = refOf(r.text, "Password");
    expect(await c.handle(req({ action: "type", ref: card, text: "4242 4242 4242 4242" }))).toEqual({ ok: false, error: STRB.sensitive("card") });
    expect(await c.handle(req({ action: "type", ref: pw, text: "hunter2" }))).toEqual({ ok: false, error: STRB.sensitive("password") });
    expect(drv.windows[0]!.typed).toEqual([]);
    const typed = await ok(req({ action: "type", ref: pw, text: "hunter2" }, { explicit: true }));
    expect(drv.windows[0]!.typed).toEqual(["hunter2"]);
    expect(typed.text).not.toContain("hunter2");
  });
});

describe("stop and take-over", () => {
  it("Stop holds the Bot until the user sends a new message", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    now += 10_000;
    drv.windows[0]!.emit("stop");
    expect(await c.handle(req({ action: "snapshot" }))).toEqual({ ok: false, error: STRB.held("Ava", true) });
    // a routine or wake (not a new user message) stays held
    expect(await c.handle(req({ action: "snapshot" }, { turn: "t2", userTurn: false }))).toMatchObject({ ok: false });
    await ok(req({ action: "snapshot" }, { turn: "t3", userTurn: true }));
  });

  it("the user's own input pauses the Bot; the Bot's input during an action doesn't; Resume on the bar continues", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    drv.windows[0]!.emit("input"); // inside the post-action grace: the Bot's own click/keys
    await ok(req({ action: "snapshot" }));
    now += 10_000;
    drv.windows[0]!.emit("input"); // the user, later
    const held = await c.handle(req({ action: "snapshot" }));
    expect(held).toEqual({ ok: false, error: STRB.held("Ava", false) });
    // the bar shows it
    expect(syn().barRoot()!.textContent).toContain(STRB.barPaused);
    drv.windows[0]!.emit("resume");
    await ok(req({ action: "snapshot" }));
    expect(syn().barRoot()!.textContent).toContain(STRB.bar("Ava"));
  });
});

describe("one Bot per window", () => {
  it("gives each Bot its own window and never lets one drive another's tabs", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    await ok(req({ action: "open", url: "http://t.test/shop" }, { botId: "b2", botName: "Max" }));
    expect(drv.windows).toHaveLength(2);
    const tabs = await ok(req({ action: "tabs", value: "list" }, { botId: "b2", botName: "Max" }));
    expect(tabs.text.split("\n")).toHaveLength(1);
    expect(await c.handle(req({ action: "tabs", value: "switch 2" }, { botId: "b2", botName: "Max" }))).toMatchObject({ ok: false });
  });

  it("serializes one Bot's actions", async () => {
    const order: string[] = [];
    const a = c.handle(req({ action: "open", url: "http://t.test/" })).then(() => order.push("open"));
    const b = c.handle(req({ action: "snapshot" })).then(() => order.push("snapshot"));
    await Promise.all([a, b]);
    expect(order).toEqual(["open", "snapshot"]);
  });
});

describe("sign-in help (bug-log 150)", () => {
  it("a take-over tells the Bot it is paused and how the user resumes; a new user message resumes it", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    now += 10_000;
    drv.windows[0]!.emit("input");
    const held = await c.handle(req({ action: "snapshot" }));
    expect(held).toMatchObject({ ok: false });
    const msg = (held as { error: string }).error;
    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/say "continue"/);
    expect(msg).toContain(STRB.barResume);
    // the user says "continue": a new user turn resumes the Bot
    await ok(req({ action: "snapshot" }, { turn: "t9", userTurn: true }));
  });

  it("when Google refuses the sign-in in the automated window, the reply tells the Bot to send the user to Sign in to sites", async () => {
    const r = await ok(req({ action: "open", url: "https://accounts.google.com/v3/signin/rejected?continue=x" }));
    expect(r.text.startsWith(STRB.signinBlocked)).toBe(true);
    expect(STRB.signinBlocked).toContain(STRB.signinButton);
    const plain = await ok(req({ action: "open", url: "http://t.test/" }));
    expect(plain.text).not.toContain(STRB.signinBlocked);
  });

  it("while the user signs in, every action waits; afterwards the browser starts again", async () => {
    await ok(req({ action: "open", url: "http://t.test/" }));
    await c.beginSignin();
    expect(await c.handle(req({ action: "snapshot" }))).toEqual({ ok: false, error: STRB.signingIn });
    c.endSignin();
    await ok(req({ action: "open", url: "http://t.test/" }));
  });
});
