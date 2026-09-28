import { SECRET_NAME, type RawField } from "./redact";

export interface CdpTarget { role: string; name: string; url: string; bbox: [number, number, number, number] | null }
export interface CdpLike {
  onNavigate(cb: (e: { url: string; title: string; tabId: string }) => void): void;
  onField(cb: (f: RawField) => void): void;
  targetAt(x: number, y: number): Promise<CdpTarget | null>;
  snapshot(): Promise<unknown | null>;
  close(): Promise<void>;
}

const BINDING = "__botTeachField";
/** I8: the field script and its binding live in an isolated world, so the page itself can't call the binding. */
const WORLD = "__botTeach";
const FIELD_SCRIPT = `(() => { if (window.__botTeach) return; window.__botTeach = 1;
  document.addEventListener("change", (e) => { const el = e.target; if (!el || !("value" in el)) return;
    const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || el.placeholder || "";
    window.${BINDING}(JSON.stringify({ role: el.getAttribute("role") || el.tagName.toLowerCase(), name: el.name || el.id || "",
      inputType: el.type || "", autocomplete: el.autocomplete || "", label: String(label).slice(0, 200), value: String(el.value) })); }, true); })()`;

interface Page { id: string; ws: WebSocket; next: number; waiting: Map<number, (r: { result?: Record<string, unknown>; error?: unknown }) => void>; isolated: Set<number> }
export interface CdpConnectOptions { fetch?: typeof fetch; ws?(url: string): WebSocket; pollMs?: number }
interface AxNode { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; properties?: { name: string }[]; childIds?: string[]; nodeId: string }

/** CDP over Chromium's debugging port: navigations, the element under a click, field commits and accessibility snapshots (ORIG-08 §08.1). */
export class CdpClient implements CdpLike {
  private pages = new Map<string, Page>();
  private navCbs: ((e: { url: string; title: string; tabId: string }) => void)[] = [];
  private fieldCbs: ((f: RawField) => void)[] = [];
  private poll: NodeJS.Timeout | null = null;

  private constructor(private port: number, private o: CdpConnectOptions) {}

  static async connect(port: number, o: CdpConnectOptions = {}): Promise<CdpClient> {
    const c = new CdpClient(port, o);
    await c.refresh();
    const every = o.pollMs ?? 2000;
    if (every > 0) c.poll = setInterval(() => void c.refresh().catch(() => {}), every);
    return c;
  }

  onNavigate(cb: (e: { url: string; title: string; tabId: string }) => void): void { this.navCbs.push(cb); }
  onField(cb: (f: RawField) => void): void { this.fieldCbs.push(cb); }

  private async refresh(): Promise<void> {
    const list = (await (await (this.o.fetch ?? fetch)(`http://127.0.0.1:${this.port}/json/list`)).json()) as { id: string; type: string; webSocketDebuggerUrl?: string }[];
    for (const t of list) if (t.type === "page" && t.webSocketDebuggerUrl && !this.pages.has(t.id)) await this.attach(t.id, t.webSocketDebuggerUrl);
  }

  private async attach(id: string, url: string): Promise<void> {
    const ws = this.o.ws ? this.o.ws(url) : new WebSocket(url);
    const page: Page = { id, ws, next: 1, waiting: new Map(), isolated: new Set() };
    this.pages.set(id, page);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp connect failed")); });
    ws.onclose = () => this.pages.delete(id);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
      if (msg.id !== undefined) { page.waiting.get(msg.id)?.(msg); page.waiting.delete(msg.id); return; }
      if (msg.method === "Page.frameNavigated") {
        const frame = msg.params?.frame as { parentId?: string; url: string };
        if (!frame.parentId) void this.title(page).then((title) => this.navCbs.forEach((cb) => cb({ url: frame.url, title, tabId: id })));
      }
      if (msg.method === "Runtime.executionContextCreated") {
        const ctx = msg.params?.context as { id?: number; name?: string } | undefined;
        if (ctx?.name === WORLD && typeof ctx.id === "number") page.isolated.add(ctx.id);
      }
      if (msg.method === "Runtime.executionContextDestroyed") page.isolated.delete(Number(msg.params?.executionContextId));
      if (msg.method === "Runtime.executionContextsCleared") page.isolated.clear();
      // I8: only the teach world's context may report a field; a page calling the binding from its own world is dropped.
      if (msg.method === "Runtime.bindingCalled" && msg.params?.name === BINDING && page.isolated.has(Number(msg.params.executionContextId))) {
        try { const f = JSON.parse(String(msg.params.payload)) as RawField; this.fieldCbs.forEach((cb) => cb(f)); } catch { /* malformed page payload */ }
      }
    };
    for (const m of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"]) await this.send(page, m);
    await this.send(page, "Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    await this.send(page, "Page.addScriptToEvaluateOnNewDocument", { source: FIELD_SCRIPT, worldName: WORLD });
    const tree = await this.send(page, "Page.getFrameTree");
    const frameId = (tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id;
    if (frameId) {
      const w = await this.send(page, "Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false });
      const ctx = Number(w.executionContextId);
      if (Number.isFinite(ctx)) {
        page.isolated.add(ctx);
        await this.send(page, "Runtime.evaluate", { expression: FIELD_SCRIPT, contextId: ctx });
      }
    }
  }

  private send(p: Page, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = p.next++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { p.waiting.delete(id); rej(new Error(`cdp ${method} timed out`)); }, 5000);
      p.waiting.set(id, (r) => { clearTimeout(t); if (r.error) rej(new Error(JSON.stringify(r.error))); else res(r.result ?? {}); });
      p.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private async evalValue<T>(p: Page, expression: string): Promise<T> {
    const r = await this.send(p, "Runtime.evaluate", { expression, returnByValue: true });
    return (r.result as { value: T }).value;
  }

  private async title(p: Page): Promise<string> {
    return this.evalValue<string>(p, "document.title").catch(() => "");
  }

  private async focused(): Promise<Page | null> {
    for (const p of this.pages.values()) if (await this.evalValue<boolean>(p, "document.hasFocus()").catch(() => false)) return p;
    return [...this.pages.values()][0] ?? null;
  }

  async targetAt(x: number, y: number): Promise<CdpTarget | null> {
    const p = await this.focused();
    if (!p) return null;
    const [sx, sy, ow, oh, url] = await this.evalValue<[number, number, number, number, string]>(p, "[screenX, screenY, outerWidth - innerWidth, outerHeight - innerHeight, location.href]");
    const px = Math.round(x - sx - ow / 2);
    const py = Math.round(y - sy - (oh - ow / 2));
    const loc = await this.send(p, "DOM.getNodeForLocation", { x: px, y: py, includeUserAgentShadowDOM: false }).catch(() => null);
    const backendNodeId = loc?.backendNodeId as number | undefined;
    if (!backendNodeId) return null;
    const ax = await this.send(p, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true }).catch(() => null);
    const node = ((ax?.nodes ?? []) as AxNode[]).find((n) => !n.ignored && n.role?.value && n.role.value !== "generic" && n.role.value !== "none");
    const box = await this.send(p, "DOM.getBoxModel", { backendNodeId }).catch(() => null);
    const q = (box?.model as { border?: number[] } | undefined)?.border;
    return { role: node?.role?.value ?? "generic", name: String(node?.name?.value ?? ""), url, bbox: q ? [q[0]!, q[1]!, q[2]! - q[0]!, q[5]! - q[1]!] : null };
  }

  /** browser_snapshot-style tree (BRW-04 bounds: ≤ 400 nodes, depth ≤ 20), secrets redacted. */
  async snapshot(): Promise<unknown | null> {
    const p = await this.focused();
    if (!p) return null;
    const r = await this.send(p, "Accessibility.getFullAXTree", { depth: 20 }).catch(() => null);
    const nodes = ((r?.nodes ?? []) as AxNode[]).filter((n) => !n.ignored && n.role?.value && n.role.value !== "generic" && n.role.value !== "none");
    const url = await this.evalValue<string>(p, "location.href").catch(() => "");
    return {
      url,
      nodes: nodes.slice(0, 400).map((n) => {
        const name = String(n.name?.value ?? "").slice(0, 200);
        const secret = n.properties?.some((pr) => pr.name === "protected") || SECRET_NAME.test(name);
        const value = n.value?.value === undefined ? undefined : secret ? "[redacted]" : String(n.value.value).slice(0, 200);
        return { role: n.role!.value, name, ...(value === undefined ? {} : { value }) };
      }),
    };
  }

  async close(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    for (const p of this.pages.values()) p.ws.close();
    this.pages.clear();
  }
}
