import { describe, expect, it } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { z } from "zod";
import { ToolRegistry } from "../../brain/provider/tool-registry";
import type { BotToolDef } from "../../brain/types";
import { createBrowserTools } from "../../computer/browser/browser-tools";
import type { CdpPage } from "../../computer/browser/connector";
import type { BotTab, BrowserHub } from "../../computer/browser/hub";
import { eventFor, planAction, validateComputer } from "../../computer/computer-actions";
import { createComputerTool } from "../../computer/computer-tool";
import type { DisplayManager } from "../../computer/displays";
import { createReadScreenTool, parseTesseractTsv, readScreenText, renderScreenText, type ScreenReader } from "../../computer/screen-read";
import { NATIVE_VIEW, screenViewFor, seesImagesFor, toScreen, toView } from "../../computer/screen-view";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool } from "../../review/classify";
import { tmpConfig } from "../helpers";

/** Synapse's own provider-neutral computer and browser tools: one set of tools for Claude and every provider. */

const OPENAI = { w: 1229, h: 768 };

describe("the screen view (one place coordinates are scaled)", () => {
  it("Claude and providers that don't shrink images see the display 1:1; OpenAI sees 1229×768", () => {
    expect(screenViewFor("claude-sonnet-5")).toEqual(NATIVE_VIEW);
    expect(screenViewFor("gemini:gemini-3.8-flash")).toEqual(NATIVE_VIEW);
    expect(screenViewFor("ollama:qwen3:4b")).toEqual(NATIVE_VIEW);
    expect(screenViewFor("openai:gpt-6.1-sol")).toEqual(OPENAI);
  });

  it("maps a model's point to the display and back, clamped, and is the identity at 1:1", () => {
    expect(toScreen(NATIVE_VIEW, 640, 400)).toEqual({ x: 640, y: 400 });
    expect(toScreen(OPENAI, 614, 384)).toEqual({ x: 639, y: 400 });
    expect(toScreen(OPENAI, 1228, 767)).toEqual({ x: 1279, y: 799 });
    expect(toView(OPENAI, 640, 400)).toEqual({ x: 615, y: 384 });
    for (const [x, y] of [[0, 0], [100, 700], [1228, 1]]) {
      const back = toView(OPENAI, toScreen(OPENAI, x!, y!).x, toScreen(OPENAI, x!, y!).y);
      expect(Math.abs(back.x - x!) + Math.abs(back.y - y!)).toBeLessThanOrEqual(1);
    }
  });

  it("which models get screenshots: Claude, catalog vision models, or what conformance measured; unknown is text-only", () => {
    expect(seesImagesFor("claude-opus-5", null)).toBe(true);
    expect(seesImagesFor("openai:gpt-6.1-sol", null)).toBe(true);
    expect(seesImagesFor("mistral:mistral-small-latest", null)).toBe(false);
    expect(seesImagesFor("deepseek:deepseek-flash", { vision: true, toolImages: true })).toBe(false); // the provider drops tool images
    expect(seesImagesFor("ollama:qwen3:4b", null)).toBe(false);
    expect(seesImagesFor("ollama:qwen3-vl:8b", { vision: true, toolImages: true })).toBe(true);
    expect(seesImagesFor("openai:gpt-6.1-sol", { vision: true, toolImages: false })).toBe(false);
    expect(seesImagesFor("openrouter:vendor/some-model", { vision: false, toolImages: null })).toBe(false);
  });
});

describe("Computer actions: double_click, and coordinates in the model's view", () => {
  it("double_click is a click with two presses, reviewed and needing a purpose", () => {
    expect(planAction({ action: "double_click", x: 10, y: 20 })).toEqual([{ xdotool: ["mousemove", "--sync", "10", "20"] }, { xdotool: ["click", "--repeat", "2", "--delay", "80", "1"] }]);
    expect(validateComputer({ action: "double_click", x: 10, y: 20 }, { enforce: true })).toMatch(/description/i);
    expect(validateComputer({ action: "double_click" }, { enforce: false })).toBe("double_click needs x and y.");
    expect(eventFor({ action: "double_click", x: 10, y: 20 })).toEqual({ kind: "click", x: 10, y: 20 });
  });

  it("bounds are the view's, points are scaled to the display, the preview's cursor gets display coordinates", () => {
    expect(validateComputer({ action: "click", x: 1250, y: 10, description: "x" }, { enforce: true, view: OPENAI })).toBe("Coordinates must be inside the 1229×768 screen: x from 0 to 1228, y from 0 to 767.");
    expect(validateComputer({ action: "click", x: 1250, y: 10, description: "x" }, { enforce: true })).toBeNull();
    expect(planAction({ action: "drag", x: 614, y: 384, x2: 1228, y2: 767 }, OPENAI)).toEqual([
      { xdotool: ["mousemove", "--sync", "639", "400"] }, { xdotool: ["mousedown", "1"] }, { xdotool: ["mousemove", "--sync", "1279", "799"] }, { xdotool: ["mouseup", "1"] },
    ]);
    expect(eventFor({ action: "drag", x: 614, y: 384, x2: 1228, y2: 767 }, OPENAI)).toEqual({ kind: "drag", x: 639, y: 400, x2: 1279, y2: 799 });
  });
});

function fakeDisplays(o: { shots: { w: number; h: number }[]; calls: string[] }) {
  return {
    ensure: async () => ({ botId: "b", index: 4, display: ":4", cdpPort: 9226, running: true, generation: 1 }),
    touch: () => {},
    x: () => ({
      xdotool: async (a: string[]) => { o.calls.push(a.join(" ")); return ""; },
      cursor: async () => ({ x: 640, y: 400 }),
      screenshotWebp: async (size?: { w: number; h: number }) => { o.shots.push(size ?? NATIVE_VIEW); return Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]); },
    }),
  } as unknown as DisplayManager;
}
const reader = (o: { a11y?: boolean; ocrCalls?: number[] } = {}): ScreenReader => ({
  read: async () => ({
    at: 0, windows: [{ key: "w", title: "Sign in - Chromium", role: "frame", app: "chromium", active: true, b: { x: 0, y: 0, w: 1280, h: 800 }, src: "web" }],
    els: o.a11y === false ? [] : [
      { key: "1", role: "textbox", name: "Email", states: ["focused"], b: { x: 500, y: 300, w: 280, h: 40 }, win: "w" },
      { key: "2", role: "button", name: "Continue", states: [], b: { x: 600, y: 380, w: 80, h: 40 }, win: "w" },
      { key: "3", role: "link", name: "Help", states: [], b: { x: 10, y: 780, w: 40, h: 16 }, win: "w" },
      { key: "4", role: "heading", name: "Welcome back", states: [], b: { x: 500, y: 200, w: 280, h: 40 }, win: "w" },
      { key: "5", role: "checkbox", name: "Remember me", states: ["checked"], b: { x: 500, y: 350, w: 20, h: 20 }, win: "w" },
      { key: "7", role: "textbox", name: "Password", states: [], b: { x: 500, y: 420, w: 280, h: 40 }, win: "w" },
      { key: "6", role: "text", name: "Offscreen", states: [], b: { x: 2000, y: 2000, w: 20, h: 20 }, win: "w" },
    ],
    page: { url: "http://127.0.0.1:8123/login", title: "Sign in", loading: false },
  }),
  ocr: async () => { o.ocrCalls?.push(1); return [{ text: "Welcome back", b: { x: 500, y: 200, w: 280, h: 40 } }]; },
});

describe("the Computer tool on any model", () => {
  it("a scaled view: the screenshot is taken at the view's size, clicks land on the display, the pointer is reported in the view", async () => {
    const o = { shots: [] as { w: number; h: number }[], calls: [] as string[] };
    const hub = new SseHub();
    const events: SseEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const tool = createComputerTool({ botId: "b", displays: fakeDisplays(o), hub, workspace: tmpConfig().workspace, enforce: () => true, now: () => 5, sleep: async () => {}, view: OPENAI });
    expect(tool.description).toContain("Act on your screen (1229×768)");
    expect(tool.description).toContain("0..1228 × 0..767");
    const r = await tool.handler({ action: "click", x: 615, y: 384, description: "Continue" });
    expect(o.calls).toEqual(["mousemove --sync 641 400", "click --repeat 1 --delay 80 1"]);
    expect(o.shots).toEqual([OPENAI]);
    expect(r.text).toContain("Pointer at (615, 384)."); // the display's (640, 400), in the model's view
    expect(r.images).toHaveLength(1);
    expect(events.find((e) => e.channel === "computer-action")!.payload).toMatchObject({ kind: "click", x: 641, y: 400 });
  });

  it("text-only: no screenshot is taken or sent; the result carries the screen as text with centre points", async () => {
    const o = { shots: [] as { w: number; h: number }[], calls: [] as string[] };
    const tool = createComputerTool({ botId: "b", displays: fakeDisplays(o), hub: new SseHub(), workspace: tmpConfig().workspace, enforce: () => true, now: () => 5, sleep: async () => {}, textOnly: { reader: async () => reader() } });
    expect(tool.description).toContain("text read of the screen");
    const r = await tool.handler({ action: "type", text: "ada@example.com" });
    expect(o.shots).toEqual([]);
    expect(r.images).toBeUndefined();
    expect(r.text).toContain("Done on the box desktop. Pointer at (640, 400).");
    expect(r.text).toContain('# page "Sign in - Chromium" http://127.0.0.1:8123/login [active]');
    expect(r.text).toContain('button "Continue" at (640, 400)');
    expect(r.text).toContain('textbox "Email" focused at (640, 320)');
    expect(r.text).not.toContain("Offscreen");
  });
});

describe("ReadScreen: accessibility and OCR text, for models that can't read images", () => {
  it("parses tesseract's TSV into lines with boxes in display pixels, dropping low-confidence noise", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t200\t100\t100\t40\t96\tTotal:",
      "5\t1\t1\t1\t1\t2\t320\t100\t140\t40\t91\t$73.15",
      "5\t1\t2\t1\t1\t1\t20\t1500\t60\t30\t12\t~~",
      "4\t1\t1\t1\t1\t0\t200\t100\t260\t40\t-1\t",
      "5\t1\t3\t1\t1\t1\t20\t1500\t120\t30\t88\tSubmit",
    ].join("\n");
    expect(parseTesseractTsv(tsv, 2)).toEqual([
      { text: "Total: $73.15", b: { x: 100, y: 50, w: 130, h: 20 } },
      { text: "Submit", b: { x: 10, y: 750, w: 60, h: 15 } },
    ]);
  });

  it("OCR runs when asked or when accessibility shows too little; points are in the model's view", async () => {
    const ocrCalls: number[] = [];
    const rich = await readScreenText(reader({ ocrCalls }), NATIVE_VIEW);
    expect(ocrCalls).toEqual([]);
    expect(rich).not.toContain("OCR");
    const bare = await readScreenText(reader({ a11y: false, ocrCalls }), OPENAI);
    expect(ocrCalls).toEqual([1]);
    expect(bare).toContain('# text on screen (OCR)\n"Welcome back" at (615, 211)');
    const tool = createReadScreenTool({ reader: async () => reader({ ocrCalls }), view: NATIVE_VIEW });
    expect(tool.readOnly).toBe(true);
    expect((await tool.handler({ ocr: true })).text).toContain('"Welcome back" at (640, 220)');
    expect(ocrCalls).toEqual([1, 1]);
  });

  it("an unreadable tree or a failed OCR is said plainly, never thrown", async () => {
    const t = await readScreenText({ read: async () => { throw new Error("no bus"); }, ocr: async () => { throw new Error("OCR isn't available on the computer (tesseract is not installed)."); } }, NATIVE_VIEW);
    expect(t).toContain("(the accessibility tree couldn't be read)");
    expect(t).toContain("(OCR: OCR isn't available on the computer (tesseract is not installed).)");
    expect(renderScreenText({ at: 0, windows: [], els: [] }, null, NATIVE_VIEW)).toBe("(no windows)");
  });
});

function browser(o: { textOnly?: boolean } = {}) {
  const log: string[] = [];
  const page = {
    targetId: "T1", url: () => "http://127.0.0.1:8123/form", title: async () => "Form",
    goto: async () => {},
    send: async (m: string, p?: Record<string, unknown>) => {
      log.push(`send ${m}${m === "Runtime.evaluate" ? ` ${String(p?.expression).slice(0, 40)}` : ""}`);
      if (m === "Runtime.evaluate") return String(p?.expression).includes("missing") || String(p?.expression).includes("Nope") ? { result: { subtype: "null" } } : { result: { objectId: "obj-9" } };
      if (m === "DOM.describeNode") return { node: { backendNodeId: 909 } };
      if (m === "DOM.getBoxModel") return { model: { content: [100, 200, 140, 200, 140, 220, 100, 220] } };
      return {};
    },
    closed: () => false, bringToFront: async () => {}, screenshotWebp: async () => Buffer.from("WEBP"),
    evaluate: async (js: string) => (js.includes("outerHTML") ? "<p>ok</p>" : ({ x: 0, y: 0 } as never)), close: async () => {},
    mouse: { click: async (x: number, y: number, c?: { count?: number }) => { log.push(`click ${x},${y}${c?.count === 2 ? " x2" : ""}`); }, move: async () => {}, down: async () => {}, up: async () => {}, wheel: async () => {} },
    keyboard: { type: async (t: string) => { log.push(`type ${t}`); }, press: async (k: string) => { log.push(`press ${k}`); }, insertText: async () => {} },
  } as unknown as CdpPage;
  const tab: BotTab = { page, viewId: "v", index: 5 };
  const hub = { tab: async () => tab, remember: async () => {}, setRefs: () => {}, ref: (_v: string, r: string) => (r === "e2" ? 222 : null), browser: async () => ({ pages: async () => [page], newPage: async () => page }), setView: async () => {} } as unknown as BrowserHub;
  const tools = createBrowserTools({ botId: "b", viewId: () => "v", hub, bus: new SseHub(), now: () => 9, ...(o.textOnly ? { textOnly: true } : {}) });
  return { t: (n: string) => tools.find((x) => x.name === n)!, tools, log };
}

describe("browser tools over CDP: click by ref, selector or text; text-only results", () => {
  it("clicks an element by CSS selector or by its visible text", async () => {
    const s = browser();
    const a = await s.t("browser_click").handler({ selector: "#submit" });
    expect(a.text).toBe("Clicked #submit.");
    expect(s.log).toContain('send Runtime.evaluate document.querySelector("#submit")');
    expect(s.log).toContain("click 120,210");
    const b = await s.t("browser_click").handler({ text: "Continue", double: true });
    expect(b.text).toBe("Clicked “Continue”.");
    expect(s.log.at(-1)).toBe("click 120,210 x2");
    expect(a.images).toHaveLength(1);
  });

  it("types into an element by selector; exactly one target is required; a miss says what to do", async () => {
    const s = browser();
    await s.t("browser_type").handler({ selector: "input[name=email]", text: "ada@example.com", submit: true });
    expect(s.log.slice(-2)).toEqual(["type ada@example.com", "press Enter"]);
    expect(await s.t("browser_click").handler({})).toEqual({ text: "Give exactly one of ref, selector or text.", isError: true });
    expect(await s.t("browser_click").handler({ ref: "e2", selector: "#x" })).toEqual({ text: "Give exactly one of ref, selector or text.", isError: true });
    expect((await s.t("browser_click").handler({ selector: "#missing" })).text).toBe("No element matches the selector #missing.");
    expect((await s.t("browser_click").handler({ text: "Nope" })).text).toMatch(/^No element shows the text “Nope”\. Take a browser_snapshot/);
  });

  it("text-only: no screenshot tool, no images in results, a nudge to snapshot instead", async () => {
    const s = browser({ textOnly: true });
    expect(s.tools.map((x) => x.name)).not.toContain("browser_take_screenshot");
    expect(s.tools).toHaveLength(14);
    const r = await s.t("browser_click").handler({ ref: "e2" });
    expect(r.images).toBeUndefined();
    expect(r.text).toBe("Clicked e2. Take a browser_snapshot to see the page now.");
  });
});

describe("the provider path names and reviews these tools exactly as the Claude path", () => {
  const def = (name: string): BotToolDef => ({ name, description: name, readOnly: false, schema: { a: z.string().optional() }, handler: async () => ({ text: "" }) });

  it("a computer tool keeps its canonical mcp__computer__ name and goes to the model under its bare name", () => {
    const reg = new ToolRegistry([{ canonical: "mcp__computer__Computer", def: def("Computer") }, { canonical: "mcp__computer__browser_click", def: def("browser_click") }, { canonical: "mcp__bot__Shell", def: def("Shell") }], "loose");
    expect(reg.wireTools().map((t) => t.name)).toEqual(["Computer", "browser_click", "Shell"]);
    expect(reg.fromWire("Computer")!.canonical).toBe("mcp__computer__Computer");
    expect(reg.fromWire("browser_click")!.canonical).toBe("mcp__computer__browser_click");
  });

  it("the gate's classifier: double_click is reviewed like a click, ReadScreen only reads, a selector names the click's target", () => {
    const c = (toolName: string, input: Record<string, unknown>) => classifyTool({ toolName, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/hp" });
    expect(c("mcp__computer__Computer", { action: "double_click", x: 5, y: 6, description: "Open the file" })).toMatchObject({ surface: "computer", sideEffect: true, summary: expect.stringMatching(/^Double-click at \(5, 6\).* to open the file$/) });
    expect(c("mcp__computer__Computer", { action: "double_click", x: 5, y: 6 })).toMatchObject({ hardDeny: expect.any(String) });
    expect(c("mcp__computer__ReadScreen", { ocr: true })).toMatchObject({ sideEffect: false });
    expect(c("mcp__computer__browser_click", { selector: "#pay" }).summary).toMatch(/^Click “#pay” in the browser/);
    expect(c("mcp__computer__browser_click", { text: "Place order" }).summary).toMatch(/^Click “Place order” in the browser/);
  });
});
