import { LIMITSC } from "@synapse/shared";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../../brain/types";
import type { SseHub } from "../../gateway/sse-hub";
import { blockLine, detectBlock } from "./block-detect";
import type { CdpPage } from "./connector";
import type { BotTab, BrowserHub } from "./hub";
import { takeSnapshot } from "./snapshot";

export const BROWSER_TOOL_NAMES = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_mouse_click_xy", "browser_type", "browser_fill",
  "browser_select_option", "browser_press_key", "browser_scroll", "browser_drag", "browser_get_bounding_box",
  "browser_highlight", "browser_cdp", "browser_tabs", "browser_take_screenshot",
] as const;
export { BROWSER_UNREVIEWED } from "@synapse/shared";
export const DENIED_CDP_PREFIXES = ["Browser.", "Target.", "Storage.", "SystemInfo.", "Security.", "Input.", "Tethering.", "Cast."] as const;
export const DENIED_CDP_METHODS = new Set(["Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies"]);

export function cdpDenied(method: string): boolean {
  return DENIED_CDP_PREFIXES.some((p) => method.startsWith(p)) || DENIED_CDP_METHODS.has(method);
}

interface Deps { botId: string; viewId(): string; hub: BrowserHub; bus: SseHub; now(): number; timeouts?: { actionMs: number; navigateMs: number } }
class UnknownRef extends Error {}

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

export function createBrowserTools(d: Deps): BotToolDef[] {
  const actionMs = d.timeouts?.actionMs ?? LIMITSC.browserActionMs;
  const navigateMs = d.timeouts?.navigateMs ?? LIMITSC.navigateMs;

  const tab = () => d.hub.tab(d.botId, d.viewId());
  const shot = async (page: CdpPage): Promise<BotToolResult["images"]> => [{ data: (await page.screenshotWebp()).toString("base64"), mimeType: "image/webp" }];
  const blocked = async (page: CdpPage): Promise<string> => {
    const html = String(await page.evaluate<string>("document.documentElement.outerHTML.slice(0, 20000)").catch(() => ""));
    const fam = detectBlock({ url: page.url(), title: await page.title().catch(() => ""), html });
    return fam ? `\n${blockLine(fam)}` : "";
  };
  const offset = async (page: CdpPage): Promise<{ x: number; y: number }> =>
    (await page.evaluate<{ x: number; y: number }>("({ x: window.screenX, y: window.screenY + (window.outerHeight - window.innerHeight) })").catch(() => ({ x: 0, y: 0 }))) ?? { x: 0, y: 0 };
  const emit = async (t: BotTab, kind: "click" | "drag" | "move" | "scroll" | "type" | "key" | "navigate", x: number | null, y: number | null, x2?: number, y2?: number) => {
    const o = x === null ? { x: 0, y: 0 } : await offset(t.page);
    d.bus.publish({ channel: "computer-action", payload: { botId: d.botId, index: t.index, kind, x: x === null ? null : Math.round(x + o.x), y: y === null ? null : Math.round((y as number) + o.y), ...(x2 !== undefined ? { x2: Math.round(x2 + o.x), y2: Math.round((y2 as number) + o.y) } : {}), at: d.now(), source: "browser" } });
  };
  const node = (ref: string): number => {
    const id = d.hub.ref(d.viewId(), ref);
    if (id === null) throw new UnknownRef(`Unknown ref ${ref}. Take a fresh browser_snapshot and use a ref from it.`);
    return id;
  };
  const center = async (page: CdpPage, backendNodeId: number): Promise<{ x: number; y: number; box: number[] }> => {
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { model } = await page.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId });
    const c = model.content;
    return { x: ((c[0] as number) + (c[4] as number)) / 2, y: ((c[1] as number) + (c[5] as number)) / 2, box: c };
  };
  const onNode = async (page: CdpPage, backendNodeId: number, fn: string, args: unknown[] = []) => {
    const { object } = await page.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
    return page.send<{ result: { value: unknown } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true });
  };
  const run = (name: string, fn: (t: BotTab) => Promise<BotToolResult>, ms = actionMs) => async (): Promise<BotToolResult> => {
    try {
      return await within(ms, (async () => fn(await tab()))(), name);
    } catch (e) {
      return { text: e instanceof UnknownRef ? e.message : `${name} failed: ${(e as Error).message}`, isError: true };
    }
  };
  const done = async (t: BotTab, text: string, checkBlock = false): Promise<BotToolResult> => {
    await d.hub.remember(t);
    return { text: text + (checkBlock ? await blocked(t.page) : ""), images: await shot(t.page) };
  };
  const tool = (name: (typeof BROWSER_TOOL_NAMES)[number], description: string, schema: BotToolDef["schema"], readOnly: boolean, handler: (a: Record<string, unknown>) => Promise<BotToolResult>): BotToolDef =>
    ({ name, description, schema, readOnly, handler });

  return [
    tool("browser_navigate", "Open a URL in your browser tab.", { url: z.string() }, false, (a) =>
      run("browser_navigate", async (t) => {
        await t.page.goto(String(a.url), { timeoutMs: navigateMs });
        await emit(t, "navigate", null, null); // CMP-06: browsing is activity (the header glyph)
        return done(t, `Navigated to ${t.page.url()} — “${await t.page.title()}”.`, true);
      }, navigateMs + 2000)()),
    tool("browser_snapshot", "Accessibility snapshot of your tab. Elements carry [ref=eN] ids for the other browser tools.", {}, true, () =>
      run("browser_snapshot", async (t) => {
        const s = await takeSnapshot(t.page);
        d.hub.setRefs(t.viewId, s.refs);
        return { text: `Page: ${t.page.url()} — “${await t.page.title()}”\n${s.text}` };
      })()),
    tool("browser_click", "Click an element by ref.", { ref: z.string(), element: z.string().optional(), button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional() }, false, (a) =>
      run("browser_click", async (t) => {
        const c = await center(t.page, node(String(a.ref)));
        await t.page.mouse.click(c.x, c.y, { button: a.button as "left" | undefined, count: a.double ? 2 : 1 });
        await emit(t, "click", c.x, c.y);
        return done(t, `Clicked ${a.element ? `“${String(a.element)}”` : String(a.ref)}.`, true);
      })()),
    tool("browser_mouse_click_xy", "Click at page coordinates (CSS pixels of the viewport).", { x: z.number(), y: z.number(), element: z.string().optional() }, false, (a) =>
      run("browser_mouse_click_xy", async (t) => {
        await t.page.mouse.click(Number(a.x), Number(a.y));
        await emit(t, "click", Number(a.x), Number(a.y));
        return done(t, `Clicked at (${Number(a.x)}, ${Number(a.y)}).`, true);
      })()),
    tool("browser_type", "Type text into an element by ref (keystrokes). Set submit to press Enter after.", { ref: z.string(), text: z.string().max(LIMITSC.textMax), submit: z.boolean().optional() }, false, (a) =>
      run("browser_type", async (t) => {
        const c = await center(t.page, node(String(a.ref)));
        await t.page.mouse.click(c.x, c.y);
        await t.page.keyboard.type(String(a.text));
        if (a.submit) await t.page.keyboard.press("Enter");
        await emit(t, "type", null, null);
        return done(t, `Typed into ${String(a.ref)}${a.submit ? " and pressed Enter" : ""}.`);
      })()),
    tool("browser_fill", "Replace the value of an input by ref.", { ref: z.string(), value: z.string().max(LIMITSC.textMax) }, false, (a) =>
      run("browser_fill", async (t) => {
        const id = node(String(a.ref));
        await t.page.send("DOM.focus", { backendNodeId: id });
        await onNode(t.page, id, "function () { if (this.select) this.select(); else document.execCommand('selectAll'); }");
        await t.page.keyboard.insertText(String(a.value));
        await emit(t, "type", null, null);
        return done(t, `Filled ${String(a.ref)}.`);
      })()),
    tool("browser_select_option", "Choose options in a <select> by ref (values or labels).", { ref: z.string(), values: z.array(z.string()).min(1) }, false, (a) =>
      run("browser_select_option", async (t) => {
        const r = await onNode(t.page, node(String(a.ref)), "function (vals) { const want = new Set(vals); let n = 0; for (const o of this.options ?? []) { o.selected = want.has(o.value) || want.has(o.label); if (o.selected) n++; } this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return n; }", [a.values]);
        return done(t, `Selected ${String(r.result.value)} option(s) in ${String(a.ref)}.`);
      })()),
    tool("browser_press_key", "Press a key or chord (Playwright names, e.g. Enter, Escape, Control+A).", { key: z.string().max(LIMITSC.keyMax) }, false, (a) =>
      run("browser_press_key", async (t) => {
        await t.page.keyboard.press(String(a.key));
        await emit(t, "key", null, null);
        return done(t, `Pressed ${String(a.key)}.`, true);
      })()),
    tool("browser_scroll", "Scroll the page (or scroll an element into view by ref).", { direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(20).optional(), ref: z.string().optional() }, true, (a) =>
      run("browser_scroll", async (t) => {
        if (a.ref) await t.page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node(String(a.ref)) });
        else {
          const px = 120 * Number(a.amount ?? 3);
          const dir = String(a.direction ?? "down");
          await t.page.mouse.wheel(dir === "left" ? -px : dir === "right" ? px : 0, dir === "up" ? -px : dir === "down" ? px : 0);
          await emit(t, "scroll", null, null);
        }
        return done(t, a.ref ? `Scrolled ${String(a.ref)} into view.` : `Scrolled ${String(a.direction ?? "down")}.`);
      })()),
    tool("browser_drag", "Drag from one element to another by refs.", { startRef: z.string(), endRef: z.string() }, false, (a) =>
      run("browser_drag", async (t) => {
        const s = await center(t.page, node(String(a.startRef)));
        const e = await center(t.page, node(String(a.endRef)));
        await t.page.mouse.move(s.x, s.y);
        await t.page.mouse.down();
        await t.page.mouse.move(e.x, e.y);
        await t.page.mouse.up();
        await emit(t, "drag", s.x, s.y, e.x, e.y);
        return done(t, `Dragged ${String(a.startRef)} to ${String(a.endRef)}.`);
      })()),
    tool("browser_get_bounding_box", "Bounding box of an element by ref, in page CSS pixels.", { ref: z.string() }, true, (a) =>
      run("browser_get_bounding_box", async (t) => {
        const c = await center(t.page, node(String(a.ref)));
        const [x1, y1, x2, , , y3] = c.box as [number, number, number, number, number, number];
        return { text: JSON.stringify({ x: x1, y: y1, width: x2 - x1, height: y3 - y1 }) };
      })()),
    tool("browser_highlight", "Outline an element by ref for two seconds (to show the user).", { ref: z.string() }, true, (a) =>
      run("browser_highlight", async (t) => {
        await onNode(t.page, node(String(a.ref)), "function () { const o = this.style.outline; this.style.outline = '3px solid #7951d8'; setTimeout(() => { this.style.outline = o; }, 2000); return true; }");
        return done(t, `Highlighted ${String(a.ref)}.`);
      })()),
    tool("browser_cdp", "Run one Chrome DevTools Protocol command on your tab. Browser., Target., Storage., SystemInfo., Security., Input., Tethering., Cast. and cookie methods are not allowed.", { method: z.string(), params: z.looseObject({}).optional() }, false, (a) => {
      const method = String(a.method);
      if (cdpDenied(method)) return Promise.resolve({ text: `The CDP method ${method} is not allowed.`, isError: true });
      return run("browser_cdp", async (t) => {
        const out = JSON.stringify(await t.page.send(method, (a.params as Record<string, unknown>) ?? {}));
        return { text: out.length > LIMITSC.cdpOutputCap ? `${out.slice(0, LIMITSC.cdpOutputCap)}…[truncated]` : out };
      })();
    }),
    tool("browser_tabs", "List, open (new), close or select tabs.", { action: z.enum(["list", "new", "close", "select"]), index: z.number().int().min(0).optional(), url: z.string().optional() }, false, (a) =>
      run("browser_tabs", async (t) => {
        const b = await d.hub.browser(d.botId);
        const pages = await b.pages();
        const list = async () => (await Promise.all((await b.pages()).map(async (p, i) => `${i}: ${p.targetId === t.page.targetId ? "(yours) " : ""}${await p.title().catch(() => "")} — ${p.url()}`))).join("\n");
        if (a.action === "new") {
          const p = await b.newPage();
          if (a.url) await p.goto(String(a.url), { timeoutMs: navigateMs });
          await d.hub.setView(d.botId, d.viewId(), p);
          return { text: `Opened a new tab and made it yours.\n${await list()}`, images: await shot(p) };
        }
        const target = pages[Number(a.index ?? -1)];
        if (a.action === "close") {
          if (!target) return { text: "No tab at that index.", isError: true };
          await target.close();
          return { text: `Closed tab ${Number(a.index)}.\n${await list()}` };
        }
        if (a.action === "select") {
          if (!target) return { text: "No tab at that index.", isError: true };
          await target.bringToFront();
          await d.hub.setView(d.botId, d.viewId(), target);
          return { text: `Tab ${Number(a.index)} is now yours.`, images: await shot(target) };
        }
        return { text: await list() };
      })()),
    tool("browser_take_screenshot", "Screenshot of your tab.", {}, true, () =>
      run("browser_take_screenshot", async (t) => ({ text: `Screenshot of ${t.page.url()}.`, images: await shot(t.page) }))()),
  ];
}
