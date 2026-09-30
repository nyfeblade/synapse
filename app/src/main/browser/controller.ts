/**
 * mac-browser: the Mac-side controller (main process). One window per Bot, in a Synapse-managed browser (the user's
 * Google Chrome with a dedicated profile, or an Electron window as a fallback). Every action reads the page through
 * the isolated-world agent and answers with a diff; a screenshot only on request, downscaled, counted and logged.
 *
 * Safety that lives here, against the live page: consequential actions (submit/send/post/buy/delete/account changes)
 * need an approval that followed this controller's own refusal for exactly that call, or a per-Bot always-allow rule
 * for the site; password/card fields take typing only when the user gave the value this turn; a Stop or the user's
 * own input on the window holds the Bot until the user resumes it or sends a new message.
 */
import { STR_RULES, macBrowserFacts, macRuleDecision, type MacRulesView } from "@synapse/shared";
import { GOOGLE_CLIENT_ID_RE, GOOGLE_CLIENT_SECRET_RE, STRB, STRGS, isGoogleClientPage, probesGoogleClient, scrubGoogleClientValues, blocksGoogleConsent, browserBindTarget, fullAutoAsk, googleConsoleChange, type BrowserArgs, type BrowserReply, type BrowserSessionStatus, type PermMode } from "@synapse/shared";
import { consequentialAction, sensitiveField, siteOf, type ElementFacts } from "./classify";
import { OUTLINE_MAX_CHARS, diffPaged, page, renderOutline, type PageState } from "./outline";
import { CARD_HINT_SOURCE, type BarText, type PageAgent } from "./page-agent";

/** One tab, at the level the controller needs (CDP or Electron's debugger underneath). */
export interface Tab {
  id: string;
  agent<T>(fn: keyof PageAgent, ...args: unknown[]): Promise<T>;
  mouse(kind: "click" | "move", x: number, y: number): Promise<void>;
  wheel(x: number, y: number, dy: number): Promise<void>;
  insertText(text: string): Promise<void>;
  key(name: string): Promise<void>;
  navigate(url: string): Promise<void>;
  history(delta: -1 | 1): Promise<boolean>;
  /** Waits out a navigation the last input started (bounded). */
  settle(): Promise<void>;
  screenshot(maxWidth: number): Promise<string>;
  front(): Promise<void>;
  close(): Promise<void>;
  /** Bar / take-over events from the page ("input" | "stop" | "resume"), and the tab going away. */
  onEvent(cb: (kind: string) => void): void;
  onClosed(cb: () => void): void;
}
export interface BrowserDriver {
  kind: "chrome" | "electron";
  /** A new window with one tab; `init` runs in the agent's world on every new document (the bar). */
  newWindow(o: { init: string }): Promise<Tab>;
  /** Tabs a page opened (target=_blank, window.open) from one of ours. */
  onPopup(cb: (openerId: string, tab: Tab) => void): void;
  /** Runs `trigger` and waits for the download it starts to land in the Downloads folder. */
  download(trigger: () => Promise<void>, timeoutMs: number): Promise<{ path: string } | null>;
  alive(): boolean;
  close(): Promise<void>;
}

export interface ControllerRequest { botId: string; botName: string; args: BrowserArgs; approved: boolean; origins: string[]; explicit: boolean; turn?: string; userTurn?: boolean;
  /** Safety v2: the owner's rules (from the Mac's gate), judged here against the live page. */
  rules?: MacRulesView | null;
  /** full-auto-quiet: the Bot's permission mode on this Mac. In "full-auto" only the five categories card. */
  mode?: PermMode }
export type ControllerResult = { ok: true; reply: BrowserReply } | { ok: false; error: string; needsApproval?: boolean };

interface Session {
  botId: string; botName: string; id: string; tabs: Tab[]; active: number; steps: number; screenshots: number;
  hold: { kind: "paused" | "stopped"; turn: string | undefined } | null; busyUntil: number; lastTurn: string | undefined;
  state: PageState | null; rest: string[]; refs: number; refusal: { bind: string; what: string } | null; lastOrigin: string | null;
  /** Navigation blocks this Bot already read in this window (collapsed on later pages). */
  navs: Set<string>;
}

const WAIT_MS = 10_000;
const SAFE_URL = /^(https?:\/\/|about:blank$)/i;

/** Google's "Couldn't sign you in" (it treats a remote-debugging Chrome as automated): send the user to Sign in to sites. */
const SIGNIN_REFUSED = /^https:\/\/accounts\.google\.com\/(v\d+\/)?signin\/(v\d+\/)?rejected\b/i;
export const signinHint = (url: string): string => (SIGNIN_REFUSED.test(url) ? STRB.signinBlocked : "");

export const barText = (bot: string): BarText => ({ active: STRB.bar(bot), paused: STRB.barPaused, stopped: STRB.barStopped, stop: STRB.barStop, resume: STRB.barResume });

export class BrowserController {
  private sessions = new Map<string, Session>();
  private driver: BrowserDriver | null = null;
  private starting: Promise<BrowserDriver> | null = null;
  private queue = new Map<string, Promise<unknown>>();
  /** "Sign in to sites" has the profile (plain Chrome, no debugging): no action runs and nothing relaunches. */
  private signingIn = false;

  constructor(private d: {
    launch(): Promise<BrowserDriver>;
    now(): number;
    log(line: string): void;
    sleep?(ms: number): Promise<void>;
    /** Screenshot width cap (px). */
    maxShotWidth?: number;
    onSession?(botId: string, status: BrowserSessionStatus): void;
  }) {}

  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  private async drv(): Promise<BrowserDriver> {
    if (this.driver?.alive()) return this.driver;
    if (this.driver) { this.sessions.clear(); this.driver = null; }
    this.starting ??= this.d.launch().then((x) => {
      this.driver = x;
      x.onPopup((opener, tab) => {
        const s = [...this.sessions.values()].find((v) => v.tabs.some((t) => t.id === opener));
        if (s) this.adopt(s, tab); else void tab.close();
      });
      return x;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private adopt(s: Session, tab: Tab): void {
    s.tabs.push(tab);
    tab.onEvent((k) => this.event(s, k));
    tab.onClosed(() => {
      const i = s.tabs.indexOf(tab);
      if (i < 0) return;
      s.tabs.splice(i, 1);
      if (s.active >= s.tabs.length) s.active = Math.max(0, s.tabs.length - 1);
      if (!s.tabs.length) { this.sessions.delete(s.botId); this.d.onSession?.(s.botId, "closed"); }
    });
  }

  private async session(botId: string, botName: string): Promise<Session> {
    const cur = this.sessions.get(botId);
    if (cur && cur.tabs.length) { cur.botName = botName || cur.botName; return cur; }
    const drv = await this.drv();
    const tab = await drv.newWindow({ init: `__syn.bar(${JSON.stringify({ bot: botName, mode: "active", text: barText(botName) })});` });
    const s: Session = { botId, botName, id: `w_${tab.id.slice(0, 12)}`, tabs: [], active: 0, steps: 0, screenshots: 0, hold: null, busyUntil: 0, lastTurn: undefined, state: null, rest: [], refs: 0, refusal: null, lastOrigin: null, navs: new Set() };
    this.adopt(s, tab);
    this.sessions.set(botId, s);
    return s;
  }

  /** Bar / take-over. The Bot's own input (while an action runs, plus a short grace) never counts as the user's. */
  private event(s: Session, kind: string): void {
    if (kind === "input") {
      if (this.d.now() < s.busyUntil || s.hold) return;
      s.hold = { kind: "paused", turn: s.lastTurn };
    } else if (kind === "stop") s.hold = { kind: "stopped", turn: s.lastTurn };
    else if (kind === "resume") s.hold = null;
    else return;
    this.d.log(`browser: ${s.botName} ${kind === "resume" ? "resumed" : kind === "stop" ? "stopped by the user" : "paused: the user took over"}`);
    void this.bar(s);
    this.d.onSession?.(s.botId, this.status(s));
  }

  private status(s: Session): BrowserSessionStatus { return s.hold ? s.hold.kind : "active"; }

  private async bar(s: Session): Promise<void> {
    const tab = s.tabs[s.active];
    if (!tab) return;
    await tab.agent("bar", { bot: s.botName, mode: s.hold ? s.hold.kind : "active", text: barText(s.botName) }).catch(() => {});
  }

  /** Serialized per Bot: one action at a time drives a window. */
  handle(req: ControllerRequest): Promise<ControllerResult> {
    const prev = this.queue.get(req.botId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.run(req));
    this.queue.set(req.botId, run);
    return run;
  }

  async show(botId: string): Promise<boolean> {
    const s = this.sessions.get(botId);
    const tab = s?.tabs[s.active];
    if (!tab) return false;
    await tab.front();
    return true;
  }

  /** The site of this Bot's last consequential refusal (an "Always" answer makes it an always-allow rule). */
  lastRefusalOrigin(botId: string): string | null { return this.sessions.get(botId)?.lastOrigin ?? null; }

  async close(): Promise<void> { this.sessions.clear(); await this.driver?.close().catch(() => {}); this.driver = null; }

  /**
   * Hands the profile to "Sign in to sites": Chrome allows one process per profile, so the automated one quits first
   * (its windows close; their cards show Closed). Until endSignin, every action answers STRB.signingIn; the next
   * action after it relaunches automated Chrome, which reads the cookies the plain window saved.
   */
  async beginSignin(): Promise<void> {
    this.signingIn = true;
    for (const s of this.sessions.values()) this.d.onSession?.(s.botId, "closed");
    this.sessions.clear();
    const starting = this.starting;
    if (starting) await starting.catch(() => null);
    const d = this.driver;
    this.driver = null;
    await d?.close().catch(() => {});
  }

  endSignin(): void { this.signingIn = false; }

  private async run(req: ControllerRequest): Promise<ControllerResult> {
    const a = req.args;
    if (this.signingIn) return { ok: false, error: STRB.signingIn };
    let s: Session;
    try { s = await this.session(req.botId, req.botName); } catch (e) { return { ok: false, error: `The browser could not start on this Mac: ${(e as Error).message}` }; }
    // A Stop / take-over holds until the user resumes from the bar or sends a new message.
    if (s.hold) {
      if (req.userTurn && req.turn && req.turn !== s.hold.turn) { s.hold = null; await this.bar(s); }
      else return { ok: false, error: STRB.held(s.botName, s.hold.kind === "stopped") };
    }
    s.lastTurn = req.turn;
    const tab = s.tabs[s.active]!;
    s.busyUntil = Number.POSITIVE_INFINITY;
    try {
      const out = await this.act(s, tab, req);
      if (typeof out !== "string" && "ok" in out) return out;
      s.steps += 1;
      await this.bar(s);
      const st = s.state;
      const text = typeof out === "string" ? out : out.text;
      // google-setup re-review 1: on a console client page, which client values sit in editable fields (the host
      // captures only page text a Bot can't have typed). A failed read reports nothing, and the host then captures nothing.
      const editable = st && isGoogleClientPage(st.url)
        ? await tab.agent<string[]>("editable", [GOOGLE_CLIENT_ID_RE.source, GOOGLE_CLIENT_SECRET_RE.source]).then((v) => (Array.isArray(v) ? v : null), () => null)
        : undefined;
      return { ok: true, reply: { text, title: st?.title ?? "", url: st?.url ?? "", session: s.id, steps: s.steps, status: this.status(s), ...(typeof out === "string" ? {} : { image: out.image }), ...(editable ? { editable } : {}) } };
    } catch (e) {
      return { ok: false, error: `Browser ${a.action} failed: ${(e as Error).message}` };
    } finally {
      s.busyUntil = this.d.now() + 600;
    }
  }

  private async collect(s: Session, tab: Tab): Promise<PageState> {
    const r = await tab.agent<{ url: string; title: string; doc: string; vh: number; next: number; nodes: PageState["nodes"] }>("collect", s.refs, { card: CARD_HINT_SOURCE });
    s.refs = Math.max(s.refs, r.next);
    return { url: r.url, title: r.title, doc: r.doc, vh: r.vh, nodes: r.nodes };
  }

  /** The page after an action: a diff against the last state (or the whole outline for a new page). */
  private async after(s: Session, tab: Tab, prefix = ""): Promise<string> {
    await tab.settle();
    const next = await this.collect(s, tab);
    const out = s.state ? diffPaged(s.state, next, { seenNavs: s.navs }) : renderOutline(next, { seenNavs: s.navs });
    s.state = next;
    s.rest = out.rest;
    return signinHint(next.url) + prefix + out.text;
  }

  private async full(s: Session, tab: Tab): Promise<string> {
    await tab.settle();
    s.state = await this.collect(s, tab);
    // An explicit snapshot lists everything again (the Bot asked to see the whole page).
    const out = renderOutline(s.state);
    s.rest = out.rest;
    return signinHint(s.state.url) + out.text;
  }

  private async facts(tab: Tab, ref: string | undefined): Promise<ElementFacts | string> {
    if (!ref) return "This action needs a ref from the outline, e.g. ref: \"e12\".";
    const f = await tab.agent<({ ok: true } & ElementFacts) | { ok: false }>("facts", ref);
    return f.ok ? f : STRB.staleRef(ref);
  }

  /**
   * google-setup: a Bot never approves a Google OAuth consent. Any page action on a consent page, or an "Allow"-type
   * control anywhere in Google's OAuth flow, is refused outright: no card, no approval, no mode or rule lifts it.
   * Judged on the page's live address and on the last outline's, so a redirect after the snapshot can't slip by.
   */
  private async consent(s: Session, tab: Tab, el: { action: string; role?: string; tag?: string }): Promise<ControllerResult | null> {
    const live = await tab.agent<string>("href").catch(() => "");
    if (![live, s.state?.url ?? ""].some((u) => u && blocksGoogleConsent(u, el))) return null;
    this.d.log(`browser: refused ${s.botName}'s action on a Google consent page (the user approves it)`);
    return { ok: false, error: STRGS.consentBlocked };
  }

  /** The consequential gate: null = go ahead; else the refusal that becomes the card. */
  private gate(s: Session, req: ControllerRequest, f: ElementFacts, o: { submit?: boolean; key?: string } = {}): ControllerResult | null {
    const url = s.state?.url ?? "";
    // google-setup: a change to the user's Google Cloud project always cards, in words that say what it changes.
    const pressable = f.isSubmit || ["button", "link", "menuitem", "tab"].includes(f.role);
    const change = (req.args.action === "click" || req.args.action === "check") && pressable ? googleConsoleChange(url, f.name) : null;
    const what = change ?? consequentialAction(req.args.action === "check" ? "click" : req.args.action, f, url, o);
    // Safety v2: the owner's rules on the live page's address and the control's own text, in every mode.
    const ruled = this.ruleGate(s, req, url, { label: f.name, submit: o.submit, field: sensitiveField(f), consequential: what });
    if (ruled !== undefined) return ruled;
    if (!what) return null;
    // full-auto-quiet: in Full auto the shared classifier (the one the tool guard and the Mac coordinator use)
    // decides which consequential actions still card: sending or posting, money, deleting, and access changes.
    // A plain POST form or a "Save changes" on a settings page is none of those, so it runs.
    if (req.mode === "full-auto" && !fullAutoAsk(
      { kind: "browser", action: req.args.action, url, label: f.name, field: sensitiveField(f), submit: o.submit },
      { home: "", workspaces: [] },
    ).ask) return null;
    const site = siteOf(url);
    if (req.origins.includes(site)) return null;
    const bind = browserBindTarget(req.args);
    // Only an approval that answered this controller's own card for exactly this call counts (not a generic one).
    if (req.approved && s.refusal?.bind === bind && s.refusal.what === what) { s.refusal = null; return null; }
    s.refusal = { bind, what };
    s.lastOrigin = site;
    return { ok: false, needsApproval: true, error: change ? STRGS.consoleCard(change) : STRB.consequential(what, site) };
  }

  /**
   * Safety v2: an owner's Never is a refusal (no card); an Ask first is a card, answered for exactly this call like
   * the consequential card. undefined = no rule decides (the consequential gate goes on); null = approved.
   */
  private ruleGate(s: Session, req: ControllerRequest, url: string, o: { label?: string; submit?: boolean; field?: "password" | "card" | null; consequential?: string | null }): ControllerResult | null | undefined {
    const rule = macRuleDecision(req.rules ?? null, macBrowserFacts(req.botId, { action: req.args.action, url, ...o }), { now: Date.now(), home: "" });
    if (!rule || rule.type === "allow") return undefined;
    if (rule.type === "never") return { ok: false, error: STR_RULES.macNever(rule.rule.text) };
    const bind = browserBindTarget(req.args);
    const what = `rule:${rule.rule.id}`;
    if (req.approved && s.refusal?.bind === bind && s.refusal.what === what) { s.refusal = null; return null; }
    s.refusal = { bind, what };
    s.lastOrigin = siteOf(url);
    return { ok: false, needsApproval: true, error: STR_RULES.macAsk(rule.rule.text) };
  }

  private async click(s: Session, tab: Tab, ref: string): Promise<string | null> {
    const p = await tab.agent<{ ok: true; x: number; y: number } | { ok: false; covered?: string }>("point", ref);
    if (!p.ok) return p.covered ? `${ref} is covered by ${p.covered}; click that instead, or close it first.` : STRB.staleRef(ref);
    await tab.mouse("click", p.x, p.y);
    return null;
  }

  private async act(s: Session, tab: Tab, req: ControllerRequest): Promise<string | ControllerResult | { text: string; image: string }> {
    const a = req.args;
    const fail = (error: string): ControllerResult => ({ ok: false, error });
    switch (a.action) {
      case "open": {
        const url = String(a.url ?? "").trim();
        if (!SAFE_URL.test(url)) return fail("Only http(s) pages can be opened.");
        const ruled = this.ruleGate(s, req, url, {}); // "Never browse example.com" stops the visit itself
        if (ruled) return ruled;
        await tab.navigate(url);
        return this.after(s, tab);
      }
      case "back": case "forward": {
        if (!(await tab.history(a.action === "back" ? -1 : 1))) return fail(`There is no page to go ${a.action} to.`);
        return this.after(s, tab);
      }
      case "snapshot": return this.full(s, tab);
      case "more": return s.rest.shift() ?? "Nothing more: that was the whole page.";
      case "text": {
        const t = await tab.agent<string>("text", a.ref ?? null, 200_000);
        // google-setup security fix 1: the reply's url is the page this text came from (the host captures a Google
        // client only off the console's client pages), so it is read now, never taken from an older outline.
        const st = await this.collect(s, tab);
        s.state = st;
        const out = page([`Page: ${st.title || "(untitled)"} — ${st.url}`], t.split("\n"), OUTLINE_MAX_CHARS);
        s.rest = out.rest;
        return out.text;
      }
      case "click": case "download": case "check": {
        if (a.action === "download" && !a.ref) {
          const url = String(a.url ?? "");
          if (!SAFE_URL.test(url)) return fail("download needs a ref to click or an http(s) url.");
          const got = await (await this.drv()).download(() => tab.navigate(url), 120_000);
          return got ? `Downloaded to ${got.path}` : fail("The download did not finish in time.");
        }
        const f = await this.facts(tab, a.ref);
        if (typeof f === "string") return fail(f);
        const blocked = await this.consent(s, tab, { action: a.action, role: f.role, tag: f.tag });
        if (blocked) return blocked;
        if (a.action === "check") {
          const want = !/^(off|false|no|uncheck)$/i.test(a.value ?? "");
          const now = await tab.agent<boolean | null>("checked", a.ref);
          if (now === want) return this.after(s, tab);
        }
        const g = this.gate(s, req, f);
        if (g) return g;
        if (a.action === "download") {
          let err: string | null = null;
          const got = await (await this.drv()).download(async () => { err = await this.click(s, tab, a.ref!); }, 120_000);
          if (err) return fail(err);
          return got ? `Downloaded to ${got.path}` : fail("No download started from that click.");
        }
        const err = await this.click(s, tab, a.ref!);
        return err ? fail(err) : this.after(s, tab);
      }
      case "type": {
        const f = await this.facts(tab, a.ref);
        if (typeof f === "string") return fail(f);
        const blocked = await this.consent(s, tab, { action: "type" });
        if (blocked) return blocked;
        // google-setup re-review 1: typing a client ID or secret could plant one on a console page. Any Bot, always.
        if (probesGoogleClient(String(a.text ?? ""))) return fail(STRGS.typeRefused);
        const sens = sensitiveField(f);
        // Never on the Bot's own initiative: only a value the user gave in this very turn.
        if (sens && !req.explicit) return fail(STRB.sensitive(sens));
        const g = this.gate(s, req, f, { submit: !!a.submit });
        if (g) return g;
        if (!(await tab.agent<boolean>("focus", a.ref))) return fail(`${a.ref} can't take text.`);
        const text = String(a.text ?? "");
        if (text) await tab.insertText(text); else await tab.key("Backspace");
        if (a.submit) await tab.key("Enter");
        return this.after(s, tab);
      }
      case "select": {
        const f = await this.facts(tab, a.ref);
        if (typeof f === "string") return fail(f);
        const blocked = await this.consent(s, tab, { action: "select" });
        if (blocked) return blocked;
        const r = await tab.agent<{ ok: boolean; chosen?: string; options?: string[] }>("select", a.ref, String(a.value ?? ""));
        if (!r.ok) return fail(r.options ? `No option "${a.value}". Options: ${r.options.join(", ")}` : `${a.ref} is not a select; click it instead.`);
        return this.after(s, tab);
      }
      case "hover": {
        const p = await tab.agent<{ ok: true; x: number; y: number } | { ok: false }>("point", a.ref);
        if (!p.ok) return fail(STRB.staleRef(String(a.ref)));
        await tab.mouse("move", p.x, p.y);
        return this.after(s, tab);
      }
      case "scroll": {
        if (a.ref) { if (!(await tab.agent<boolean>("scrollInto", a.ref))) return fail(STRB.staleRef(a.ref)); }
        else await tab.wheel(400, 300, (/^up$/i.test(a.value ?? "") ? -1 : 1) * Math.round((s.state?.vh ?? 800) * 0.8));
        return this.after(s, tab);
      }
      case "press": {
        const key = String(a.value ?? "");
        if (!key) return fail('press needs value, e.g. value: "Enter".');
        // A key on a consent page can press its focused Allow (Enter, Space) just as a click can.
        const blocked = await this.consent(s, tab, { action: "press" });
        if (blocked) return blocked;
        if (a.ref && !(await tab.agent<boolean>("focus", a.ref))) return fail(STRB.staleRef(a.ref));
        if (/^(enter|return)$/i.test(key)) {
          const active = a.ref ?? await tab.agent<string | null>("activeRef");
          if (active) {
            const f = await tab.agent<({ ok: true } & ElementFacts) | { ok: false }>("facts", active);
            if (f.ok) { const g = this.gate(s, req, f, { key }); if (g) return g; }
          }
        }
        await tab.key(key);
        return this.after(s, tab);
      }
      case "wait": {
        // google-setup security fix 2: "wait for text X" answers yes/no about the page, so it could be used to guess a
        // client secret one prefix at a time. Every Bot, always: no secret-shaped wait text, and the page is compared
        // only after its secrets and client IDs are replaced.
        if (a.text && probesGoogleClient(a.text)) return fail(STRGS.waitRefused);
        const until = this.d.now() + WAIT_MS;
        const before = s.state?.doc;
        for (;;) {
          if (a.value === "navigation") { const st = await this.collect(s, tab).catch(() => null); if (st && st.doc !== before) break; }
          else if (a.ref) { if (typeof (await this.facts(tab, a.ref)) !== "string") break; }
          else if (a.text) { const t = scrubGoogleClientValues(await tab.agent<string>("text", null, 400_000).catch(() => "")); if (t.includes(a.text)) break; }
          else { await this.sleep(1000); break; }
          if (this.d.now() >= until) return fail(`Waited ${WAIT_MS / 1000} s; it didn't happen. Take a snapshot to see the page.`);
          await this.sleep(250);
        }
        return this.after(s, tab);
      }
      case "tabs": {
        const v = String(a.value ?? "list").trim();
        const m = /^(switch|close)\s+(\d+)$/i.exec(v);
        if (m) {
          const i = Number(m[2]) - 1;
          const t = s.tabs[i];
          if (!t) return fail(`No tab ${m[2]}. ${s.tabs.length} open.`);
          if (/close/i.test(m[1]!)) {
            if (s.tabs.length === 1) return fail("That is the last tab of your window; leave it open.");
            await t.close();
            s.tabs.splice(i, 1);
            if (s.active >= s.tabs.length) s.active = s.tabs.length - 1;
            s.state = null;
            return this.full(s, s.tabs[s.active]!);
          }
          s.active = i;
          s.state = null;
          return this.full(s, t);
        }
        const rows: string[] = [];
        for (const [i, t] of s.tabs.entries()) {
          const st = await t.agent<{ url: string; title: string }>("collect", s.refs, { card: CARD_HINT_SOURCE }).catch(() => ({ url: "?", title: "?" }));
          rows.push(`${i + 1}${i === s.active ? " (active)" : ""}: ${st.title || "(untitled)"} — ${st.url}`);
        }
        return rows.join("\n");
      }
      case "screenshot": {
        // google-setup security fix 5: a client page can show the secret as pixels. Any Bot, judged on the live address.
        const here = await tab.agent<string>("href").catch(() => s.state?.url ?? "");
        if (isGoogleClientPage(here) || isGoogleClientPage(s.state?.url ?? "")) return fail(STRGS.noScreenshots);
        const img = await tab.screenshot(this.d.maxShotWidth ?? 1280);
        s.screenshots += 1;
        this.d.log(`browser: screenshot for ${s.botName} (${Math.round((img.length * 3) / 4 / 1024)} KB, #${s.screenshots} this session)`);
        const st = s.state ?? await this.collect(s, tab);
        s.state = st;
        return { text: `Screenshot of ${st.title || st.url} (JPEG, at most ${this.d.maxShotWidth ?? 1280} px wide). Prefer snapshot: it is far cheaper.`, image: img };
      }
    }
    return fail(`Unknown browser action ${String(a.action)}.`);
  }
}
