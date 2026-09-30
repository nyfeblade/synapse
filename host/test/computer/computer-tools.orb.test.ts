import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { ProviderBrain } from "../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../brain/provider/session-store";
import type { BrainWiring, TurnEvent } from "../../brain/types";
import { createBrowserTools } from "../../computer/browser/browser-tools";
import { PlaywrightConnector } from "../../computer/browser/connector";
import { BrowserHub } from "../../computer/browser/hub";
import { createComputerTool } from "../../computer/computer-tool";
import type { DisplayManager } from "../../computer/displays";
import { BoxIO } from "../../computer/perception/io";
import { createReadScreenTool, ocrScreen, type ScreenReader } from "../../computer/screen-read";
import { NATIVE_VIEW } from "../../computer/screen-view";
import { XRunner, type Exec } from "../../computer/x-exec";
import { SseHub } from "../../gateway/sse-hub";
import { setProviderRuntime } from "../../usage/metered-provider";
import { finish, startFakeChatServer, textChunks, toolChunks, usageChunk, type FakeReply } from "../brain/provider/fake-chat-server";
import { startProviderRuntime } from "../brain/provider/runtime";
import { tmpConfig } from "../helpers";

/**
 * The provider-neutral computer and browser tools on a REAL X display and a REAL Chromium, on a THROWAWAY OrbStack
 * machine that box/computer-tools-sim.sh creates (unique name, deleted after), never the owner's `box`. The tools'
 * X clients run in that machine (through `orb`, as the display's owner); CDP reaches its Chromium through OrbStack's
 * localhost forwarding. Skipped unless the script sets CUA_SIM_MACHINE.
 */
const M = process.env.CUA_SIM_MACHINE ?? "";
const CDP = Number(process.env.CUA_SIM_CDP ?? 0);
const PAGE = process.env.CUA_SIM_PAGE ?? "";
const DISPLAY = ":7";
const ORB = process.env.ORB ?? "/Applications/OrbStack.app/Contents/MacOS/bin/orb";

/** Runs a command in the throwaway machine, as the display's owner `sim`, with the display's env. */
const orbExec: Exec = (file, args, o = {}) => new Promise((resolve) => {
  if (!/^synapse-cua-\d+$/.test(M)) throw new Error(`refusing machine ${M}: not a throwaway synapse-cua-<pid>`);
  const env = Object.entries({ PATH: "/usr/local/bin:/usr/bin:/bin", ...(o.env ?? {}) }).map(([k, v]) => `${k}=${v}`);
  // The suite points HOME (and the XDG folders) at a temp folder (scripts/vitest-test-home.ts); the orb client needs
  // the real one to find OrbStack, so the script passes it as CUA_SIM_HOME.
  const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("XDG_")));
  const child = spawn(ORB, ["-m", M, "-u", "sim", "env", "-i", ...env, file, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...env0, HOME: process.env.CUA_SIM_HOME ?? "" } });
  const out: Buffer[] = [];
  let err = "";
  const t = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 30_000);
  child.stdout.on("data", (d: Buffer) => out.push(d));
  child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }); });
  child.stdin.end(o.input ?? undefined);
});

const xenv = { display: DISPLAY, xauthority: "/dev/null" };
const x = new XRunner(orbExec, xenv);
const info = { botId: "sim", index: 7, display: DISPLAY, cdpPort: CDP, running: true, generation: 1 };
const displays = { ensure: async () => info, touch: () => {}, x: () => x, info: () => info } as unknown as DisplayManager;
const browserHub = new BrowserHub({ displays, connector: new PlaywrightConnector(), stateDir: tmpConfig().hostPrivate });
const reader: ScreenReader = (() => {
  const io = new BoxIO({ exec: orbExec, xenv, index: 7, browser: () => browserHub.browser("sim"), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, atspi: async () => null });
  return { read: () => io.read(), ocr: () => ocrScreen(orbExec, xenv) };
})();
const hub = new SseHub();
const workspace = tmpConfig().workspace;

afterAll(() => setProviderRuntime(null));

describe.runIf(M !== "")("provider-neutral computer and browser tools on a throwaway machine's real display and Chromium", () => {
  const computer = createComputerTool({ botId: "sim", displays, hub, workspace, enforce: () => true, now: Date.now });
  const textComputer = createComputerTool({ botId: "sim", displays, hub, workspace, enforce: () => true, now: Date.now, textOnly: { reader: async () => reader } });
  const readScreen = createReadScreenTool({ reader: async () => reader, view: NATIVE_VIEW });
  const browser = createBrowserTools({ botId: "sim", viewId: () => "sim-view", hub: browserHub, bus: hub, now: Date.now });
  const b = (n: string) => browser.find((t) => t.name === n)!;
  const log: string[] = [];
  const show = (what: string, text: string) => { log.push(`${what}: ${text.slice(0, 400)}`); console.log(`[orb proof] ${what}: ${text.slice(0, 600)}`); };

  it("screenshot: a real 1280×800 WebP of the display", async () => {
    const r = await computer.handler({ action: "screenshot" });
    expect(r.isError, r.text).toBeFalsy();
    const webp = Buffer.from(r.images![0]!.data, "base64");
    expect(webp.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(webp.length).toBeGreaterThan(1000);
    show("screenshot", `${webp.length} bytes; ${r.text}`);
    const scaled = await x.screenshotWebp({ w: 1229, h: 768 });
    expect(scaled.subarray(8, 12).toString("ascii")).toBe("WEBP");
  }, 60_000);

  it("the Computer tool: navigate, read the screen as text, click the field, type, press Enter, read the result", async () => {
    const nav = await b("browser_navigate").handler({ url: PAGE });
    show("browser_navigate", nav.text);
    expect(nav.text).toContain("Greeter");
    const before = await readScreen.handler({});
    show("ReadScreen (before)", before.text);
    const field = /textbox "Your name"[^\n]* at \((\d+), (\d+)\)/.exec(before.text);
    expect(field, before.text).not.toBeNull();
    const click = await computer.handler({ action: "click", x: Number(field![1]), y: Number(field![2]), description: "Focus the name field" });
    expect(click.isError, click.text).toBeFalsy();
    const typed = await textComputer.handler({ action: "type", text: "Ada Lovelace" });
    expect(typed.isError, typed.text).toBeFalsy();
    const enter = await computer.handler({ action: "key", key: "Return" });
    expect(enter.images).toHaveLength(1);
    const after = await readScreen.handler({ ocr: true });
    show("ReadScreen (after, with OCR)", after.text);
    expect(after.text).toContain("Hello, Ada Lovelace!"); // from the accessibility tree
    expect(after.text).toMatch(/# text on screen \(OCR\)[\s\S]*Hello, Ada/); // and read off the pixels by tesseract
    const page = await (await browserHub.tab("sim", "sim-view")).page.evaluate<string>("document.getElementById('out').textContent");
    expect(page).toBe("Hello, Ada Lovelace!");
  }, 120_000);

  it("the browser tools over CDP: type by selector, click by visible text, snapshot reads the result", async () => {
    await b("browser_navigate").handler({ url: PAGE });
    const t = await b("browser_type").handler({ selector: "#name", text: "Grace Hopper" });
    expect(t.isError, t.text).toBeFalsy();
    const c = await b("browser_click").handler({ text: "Greet me" });
    expect(c.isError, c.text).toBeFalsy();
    expect(c.images).toHaveLength(1);
    const snap = await b("browser_snapshot").handler({});
    show("browser_snapshot", snap.text);
    expect(snap.text).toContain("Hello, Grace Hopper!");
  }, 120_000);

  it("a provider child (ProviderBrain, fake model) drives the real browser and screen with the same tools", async () => {
    const plan = [
      { name: "browser_navigate", args: { url: PAGE } },
      { name: "browser_type", args: { selector: "#name", text: "Katherine Johnson" } },
      { name: "browser_click", args: { text: "Greet me" } },
      { name: "Computer", args: { action: "screenshot" } },
    ];
    let k = 0;
    const server = await startFakeChatServer((req): FakeReply => {
      const step = plan[(req.body.messages as { role: string }[]).filter((m) => m.role === "assistant").length];
      if (!step) return { sse: [...textChunks("Report: greeted Katherine Johnson."), finish("stop"), usageChunk(10, 1)] };
      return { sse: [...toolChunks([{ id: `call_${++k}`, name: step.name, args: step.args }]), finish("tool_calls"), usageChunk(10, 1)] };
    });
    const rt = await startProviderRuntime({ upstream: server.url });
    try {
      const tools = [computer, ...browser];
      const wiring: BrainWiring = {
        preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
        botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }), flags: () => DEFAULT_FLAGS,
      };
      const brain = new ProviderBrain({
        botId: "child:sim", storeKey: "sim", wiring, store: new ProviderSessionStore(tmpConfig().hostPrivate), getSessionId: () => null, sleep: async () => {},
        systemPrompt: () => "You are a browserUse subagent.", serverTools: () => tools.map((def) => ({ canonical: `mcp__computer__${def.name}`, def })),
      });
      const ends: { name: string; isError: boolean }[] = [];
      const r = await brain.runTurn({ prompt: [{ text: "Greet Katherine Johnson on the page." }], hidden: true, lane: "background", source: "subagent-done", silenceAllowed: true, requestId: "child:sim", systemAppend: "", model: "openai:gpt-6.1-sol", autoReviewEpoch: "continue" }, (e: TurnEvent) => { if (e.kind === "tool_end") ends.push({ name: e.name, isError: e.isError }); });
      show("provider child", `${JSON.stringify(ends)} → ${r.finalText}`);
      expect(ends.map((e) => e.name)).toEqual(["mcp__computer__browser_navigate", "mcp__computer__browser_type", "mcp__computer__browser_click", "mcp__computer__Computer"]);
      expect(ends.every((e) => !e.isError)).toBe(true);
      expect(r.finalText).toBe("Report: greeted Katherine Johnson.");
      const images = (server.requests.at(-1)!.body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user" && Array.isArray(m.content)).flatMap((m) => m.content as { type: string }[]).filter((p) => p.type === "image_url");
      expect(images.length).toBeGreaterThanOrEqual(3); // the real screenshots went to the model
      const page = await (await browserHub.tab("sim", "sim-view")).page.evaluate<string>("document.getElementById('out').textContent");
      expect(page).toBe("Hello, Katherine Johnson!");
    } finally {
      await rt.stop();
      await server.close();
    }
  }, 180_000);
});
