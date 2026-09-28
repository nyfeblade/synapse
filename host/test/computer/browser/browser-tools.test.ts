import { describe, expect, it } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { BROWSER_TOOL_NAMES, cdpDenied, createBrowserTools } from "../../../computer/browser/browser-tools";
import type { BrowserHub, BotTab } from "../../../computer/browser/hub";
import type { CdpPage } from "../../../computer/browser/connector";
import { SseHub } from "../../../gateway/sse-hub";

function setup(html = "<h1>ok</h1>", title = "Example") {
  const log: string[] = [];
  let url = "about:blank";
  const page = {
    targetId: "T1", url: () => url, title: async () => title,
    goto: async (u: string) => { url = u; log.push(`goto ${u}`); },
    send: async (m: string, p?: Record<string, unknown>) => {
      log.push(`send ${m}`);
      if (m === "DOM.getBoxModel") return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      if (m === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      if (m === "Runtime.callFunctionOn") return { result: { value: true } };
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (m === "Runtime.evaluate") return { result: { value: { x: 0, y: 85 } } };
      if (m === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (m === "DOM.querySelectorAll") return { nodeIds: [] };
      if (m === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example" }, backendDOMNodeId: 5 }] };
      return { echoed: p ?? null };
    },
    closed: () => false, bringToFront: async () => {}, screenshotWebp: async () => Buffer.from("WEBP"),
    evaluate: async (js: string) => (js.includes("outerHTML") ? html : ({ x: 0, y: 85 } as never)), close: async () => {},
    mouse: { click: async (x: number, y: number) => { log.push(`click ${x},${y}`); }, move: async (x: number, y: number) => { log.push(`move ${x},${y}`); }, down: async () => { log.push("down"); }, up: async () => { log.push("up"); }, wheel: async (dx: number, dy: number) => { log.push(`wheel ${dx},${dy}`); } },
    keyboard: { type: async (t: string) => { log.push(`type ${t}`); }, press: async (k: string) => { log.push(`press ${k}`); }, insertText: async (t: string) => { log.push(`insert ${t}`); } },
  } as unknown as CdpPage;
  const refs = new Map<string, number>([["e2", 222], ["e3", 333]]);
  const tab: BotTab = { page, viewId: "view-1", index: 5 };
  const hub = {
    tab: async () => tab, remember: async () => {}, setRefs: (_v: string, r: Map<string, number>) => { for (const [k, v] of r) refs.set(k, v); },
    ref: (_v: string, r: string) => refs.get(r) ?? null,
    browser: async () => ({ pages: async () => [page], newPage: async () => page }),
    setView: async () => {},
  } as unknown as BrowserHub;
  const bus = new SseHub();
  const events: SseEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const tools = createBrowserTools({ botId: "b", viewId: () => "view-1", hub, bus, now: () => 9 });
  const t = (n: string) => tools.find((x) => x.name === n)!;
  return { t, tools, log, events };
}

describe("browser tools (BRW-05)", () => {
  it("defines exactly the 15 tools", () => {
    const s = setup();
    expect(s.tools.map((x) => x.name)).toEqual([...BROWSER_TOOL_NAMES]);
    expect(BROWSER_TOOL_NAMES).toHaveLength(15);
  });

  it("navigate goes to the URL, reports the title and returns a screenshot", async () => {
    const s = setup();
    const r = await s.t("browser_navigate").handler({ url: "https://example.com" });
    expect(s.log).toContain("goto https://example.com");
    expect(r.text).toBe("Navigated to https://example.com — “Example”.");
    expect(r.images?.[0]?.mimeType).toBe("image/webp");
  });

  it("adds BLOCKED_BY_SITE when a challenge page loads", async () => {
    const s = setup("<div id='cf-chl-widget'></div>", "Just a moment...");
    const r = await s.t("browser_navigate").handler({ url: "https://shop.example" });
    expect(r.text).toMatch(/\nBLOCKED_BY_SITE: cloudflare$/);
  });

  it("click resolves the ref to the box center, clicks, and emits a browser computer-action in screen coordinates", async () => {
    const s = setup();
    await s.t("browser_click").handler({ ref: "e2", element: "Continue button" });
    expect(s.log).toContain("send DOM.scrollIntoViewIfNeeded");
    expect(s.log).toContain("click 20,30");
    const ev = s.events.find((e) => e.channel === "computer-action")!.payload as { x: number; y: number; source: string };
    expect(ev).toMatchObject({ x: 20, y: 115, source: "browser" });
  });

  it("navigate counts as computer activity, so the header glyph turns purple while a Bot browses (T29 demo finding)", async () => {
    const s = setup();
    await s.t("browser_navigate").handler({ url: "https://example.com" });
    expect(s.events.find((e) => e.channel === "computer-action")?.payload).toMatchObject({ kind: "navigate", x: null, y: null, source: "browser" });
  });

  it("an unknown ref is a tool error that asks for a fresh snapshot", async () => {
    const s = setup();
    const r = await s.t("browser_click").handler({ ref: "e99" });
    expect(r).toEqual({ text: "Unknown ref e99. Take a fresh browser_snapshot and use a ref from it.", isError: true });
  });

  it("fill replaces the value with insertText; type types and can submit", async () => {
    const s = setup();
    await s.t("browser_fill").handler({ ref: "e3", value: "ada@example.com" });
    expect(s.log).toContain("insert ada@example.com");
    await s.t("browser_type").handler({ ref: "e3", text: "hello", submit: true });
    expect(s.log.slice(-2)).toEqual(["type hello", "press Enter"]);
  });

  it("browser_cdp refuses the denied prefixes and cookie methods, and caps output at 20,000 chars", async () => {
    expect(cdpDenied("Input.dispatchKeyEvent")).toBe(true);
    expect(cdpDenied("Network.getAllCookies")).toBe(true);
    expect(cdpDenied("Storage.getCookies")).toBe(true);
    expect(cdpDenied("Page.reload")).toBe(false);
    const s = setup();
    expect(await s.t("browser_cdp").handler({ method: "Target.createTarget" })).toEqual({ text: "The CDP method Target.createTarget is not allowed.", isError: true });
    const r = await s.t("browser_cdp").handler({ method: "Page.reload", params: { big: "x".repeat(30_000) } });
    expect(r.text.length).toBeLessThanOrEqual(20_000 + 40);
    expect(r.text).toMatch(/…\[truncated\]$/);
  });

  it("snapshot stores refs and returns text without a screenshot", async () => {
    const s = setup();
    const r = await s.t("browser_snapshot").handler({});
    expect(r.images).toBeUndefined();
    expect(s.log).toContain("send Accessibility.getFullAXTree");
    expect(r.text).toBe('Page: about:blank — “Example”\n- RootWebArea "Example" [ref=e1]');
  });
});
