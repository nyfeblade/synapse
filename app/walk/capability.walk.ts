import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SseEvent, UsageView } from "@synapse/shared";
import { fakeVncSocket } from "../../host/computer/fuzz-fakes";
import { COMPOSIO_HEADER, COMPOSIO_MCP_URL } from "../src/renderer/marketplace/custom-mcp-preset";
import { closeDev, launchDev, openBot, preflight, restoreOAuthPort, WALK_PREFIX, type DevApp } from "./app";
import { Gateway } from "./gateway";
import { assertWalkEnv, nonce, redact, redacting, registerSecret, within } from "./guards";
import { duplexTransport, frameStats, isNonUniform, RfbClient, wsTransport, type FrameStats } from "./rfb";

test.describe.configure({ mode: "serial" });

type Verdict = { name: string; pass: boolean; detail: string };
function recorder() {
  const out: Verdict[] = [];
  return {
    out,
    check(name: string, pass: boolean, detail: string) { out.push({ name, pass, detail: redact(detail) }); expect.soft(pass, `${name}: ${redact(detail)}`).toBe(true); },
  };
}

const usageDelta = (a: UsageView, b: UsageView) => ({
  budgetPct: `${a.budgetPct} -> ${b.budgetPct}`,
  tokens: b.rows.reduce((s, r) => s + r.tokens, 0) - a.rows.reduce((s, r) => s + r.tokens, 0),
  costUsd: +(b.rows.reduce((s, r) => s + r.costUsd, 0) - a.rows.reduce((s, r) => s + r.costUsd, 0)).toFixed(4),
});

function report(name: string, t0: number, v: Verdict[], extra: Record<string, unknown>): void {
  const body = { journey: name, wallSeconds: Math.round((Date.now() - t0) / 1000), verdicts: v, ...extra };
  const dir = path.join(os.tmpdir(), "bots-walk"); // outside Playwright's outputDir, which is wiped per run
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-${Date.now()}.json`), redact(JSON.stringify(body, null, 2)));
  console.log(redact(`WALK ${name} ${JSON.stringify(body)}`));
}

/** Every 4th pixel of the Computer view's noVNC canvas, as RGBA — what the user's window is showing. */
async function sampleUiCanvas(win: Page): Promise<FrameStats | null> {
  const s = await win.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".computer-view .cv-canvas canvas");
    if (!c || !c.width || !c.height) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const w = Math.floor(c.width / 4), h = Math.floor(c.height / 4);
    const out: number[] = new Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((y * 4) * c.width + x * 4) * 4, o = (y * w + x) * 4; out[o] = d[s]!; out[o + 1] = d[s + 1]!; out[o + 2] = d[s + 2]!; out[o + 3] = d[s + 3]!; }
    return { w, h, px: out, alphaZero: out.filter((_, i) => i % 4 === 3 && out[i] === 0).length };
  });
  if (!s) return null;
  const st = frameStats(Uint8Array.from(s.px), s.w, s.h);
  // A never-drawn canvas is transparent black: count that as blank whatever the RGB says.
  return s.alphaZero === s.w * s.h ? { ...st, distinctColors: 1, dominantFraction: 1 } : st;
}

// ---------------------------------------------------------------------------------------------
// The instrument, checked against inputs where the right answer is FAIL. Offline; no box needed.
test("instrument: the frame checks can fail", async () => {
  const fake = await RfbClient.connect(duplexTransport(fakeVncSocket({ width: 64, height: 40 })));
  const uniform = await fake.frame();
  fake.close();
  expect(uniform.distinctColors, "fake server paints one solid RRE rect").toBe(1);
  expect(isNonUniform(uniform), "a uniform frame must FAIL the non-uniform check").toBe(false);

  const px = new Uint8Array(64 * 40 * 4);
  expect(isNonUniform(frameStats(px, 64, 40)), "all-black frame").toBe(false);
  px[0] = 255; // one stray pixel (a cursor) is not a desktop
  expect(isNonUniform(frameStats(px, 64, 40)), "one stray pixel").toBe(false);
  const a = frameStats(px, 64, 40);
  for (let i = 0; i < px.length / 2; i++) px[i] = 200;
  const b = frameStats(px, 64, 40);
  expect(isNonUniform(b), "half the frame differs").toBe(true);
  expect(a.hash === b.hash, "hash must change when pixels change").toBe(false);
  expect(frameStats(px, 64, 40).hash, "hash is stable for identical pixels").toBe(b.hash);
});

// ---------------------------------------------------------------------------------------------
test("J1: Computer glyph gives a new Bot a live screen (real box)", async () => {
  assertWalkEnv();
  const t0 = Date.now();
  const r = recorder();
  const g = Gateway.fromBox();
  await g.events();
  const usage0 = await g.call("getUsage", {});
  const pre = await preflight(g);
  const name = `${WALK_PREFIX}${nonce()}`;
  let botId = "";
  let dev: DevApp | null = null;
  let rfb: RfbClient | null = null;
  const extra: Record<string, unknown> = { preflight: pre };
  try {
    ({ id: botId } = await g.call("createAgent", { name }));
    const created = g.mark();
    dev = await launchDev(name);
    const { win } = dev;
    await openBot(win, name);
    const glyph = win.getByRole("button", { name: "Computer activity" });
    await glyph.waitFor({ state: "visible", timeout: 30_000 });

    // A1 — before the click: no seat, and none was ever published for this Bot.
    const before = await g.call("getDisplays", {});
    const leaked = g.since(created).some((e) => e.channel === "displays" && e.payload.displays.some((d) => d.botId === botId));
    r.check("A1 no display before click", !before.displays.some((d) => d.botId === botId) && !leaked,
      `getDisplays=${JSON.stringify(before.displays.map((d) => d.botId))} leakedOnSse=${leaked}`);

    // A2 — the click (renderer openComputer → requestDisplay → ensureDisplay) gives it one.
    const m = g.mark();
    const tClick = Date.now();
    await glyph.click();
    let shown: { index: number; running: boolean } | null = null;
    try {
      shown = await g.waitFor((e: SseEvent) => e.channel === "displays" && e.payload.displays.find((d) => d.botId === botId && d.running), { from: m, timeoutMs: 90_000, label: `displays: ${name} running` });
    } catch (e) { extra.a2Error = (e as Error).message; }
    const after = await g.call("getDisplays", {});
    const mine = after.displays.find((d) => d.botId === botId);
    r.check("A2 display after click", !!shown && !!mine?.running, `sse=${JSON.stringify(shown)} getDisplays=${JSON.stringify(mine ?? null)} after ${Date.now() - tClick} ms; waiting=${JSON.stringify(after.waiting)}`);
    if (!mine) throw new Error("A2 failed: no display; A3-A5 cannot run");

    // A3 — the VNC frame is a real desktop, not a solid fill. Give the desktop up to 30 s to paint.
    rfb = await within(RfbClient.connect(await wsTransport(g.baseUrl, g.auth, botId)), 30_000, "RFB handshake over /vnc");
    let f = await within(rfb.frame(), 20_000, "first full frame");
    const until = Date.now() + 30_000;
    while (!isNonUniform(f) && Date.now() < until) { const n = await rfb.waitForChange(f.hash, until - Date.now()); if (!n) break; f = n; }
    r.check("A3 VNC frame non-uniform", isNonUniform(f), `${rfb.width}x${rfb.height} "${rfb.name}" distinct=${f.distinctColors} dominant=${f.dominantFraction.toFixed(4)} hash=${f.hash}`);

    // A4 — input changes the frame: pointer first; if the cursor isn't in the framebuffer, openComputerApp.
    const base = (await rfb.frame()).hash;
    rfb.pointer(Math.floor(rfb.width / 2), Math.floor(rfb.height / 2), 0);
    rfb.pointer(Math.floor(rfb.width / 3), Math.floor(rfb.height / 3), 0);
    let changed = await rfb.waitForChange(base, 5_000);
    let via = "pointer";
    if (!changed) {
      via = "openComputerApp(terminal)";
      await g.call("openComputerApp", { id: botId, app: "terminal" });
      changed = await rfb.waitForChange(base, 30_000);
    }
    r.check("A4 frame hash changes after input", !!changed, `via=${via} base=${base} now=${changed?.hash ?? "unchanged"}`);

    // A5 — the renderer's canvas shows the screen (non-blank pixels in the user's window).
    let ui: FrameStats | null = null;
    const uiUntil = Date.now() + 60_000;
    while (Date.now() < uiUntil) { ui = await sampleUiCanvas(win); if (ui && isNonUniform(ui)) break; await win.waitForTimeout(1_000); }
    const absence = await win.locator(".computer-view .cv-stage").innerText().catch(() => "");
    r.check("A5 UI canvas non-blank", !!ui && isNonUniform(ui), ui ? `canvas ${ui.width * 4}x${ui.height * 4} distinct=${ui.distinctColors} dominant=${ui.dominantFraction.toFixed(4)}` : `no drawable canvas; stage text=${JSON.stringify(absence.slice(0, 200))}`);
    await win.screenshot({ path: path.join(os.tmpdir(), `walk-J1-${name}.png`) }).catch(() => {});
    extra.screenshot = path.join(os.tmpdir(), `walk-J1-${name}.png`);
  } finally {
    rfb?.close();
    await closeDev(dev);
    if (botId) extra.deleteAgent = await g.call("deleteAgent", { id: botId }).then(() => "ok", (e) => `FAILED ${(e as Error).message}`);
    extra.oauthPort = await restoreOAuthPort(g).catch((e) => `FAILED ${(e as Error).message}`);
    extra.usage = usageDelta(usage0, await g.call("getUsage", {}));
    extra.appStderrTail = dev?.stderr.join("").split("\n").filter((l) => /error|fail|keychain/i.test(l)).slice(-15);
    report("J1", t0, r.out, extra);
    g.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Minimal MCP (streamable HTTP) client — the ground truth for "a value only that result could hold".
async function mcp(url: string, headers: Record<string, string>) {
  let session = "";
  let id = 0;
  const rpc = async (method: string, params: unknown, notify = false) => {
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id: ++id }) }) });
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) return null;
    const text = await res.text();
    const json = res.headers.get("content-type")?.includes("event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}" : text;
    const j = JSON.parse(json) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`MCP ${method}: ${j.error.message}`);
    return j.result as Record<string, unknown>;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "walk", version: "0" } });
  await rpc("notifications/initialized", {}, true);
  return rpc;
}

test("J2: Composio custom MCP server from the add form (real box)", async () => {
  assertWalkEnv();
  const keyFile = path.join(os.homedir(), ".composio-key");
  const raw = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
  test.skip(!raw, "blocked: no key (~/.composio-key missing or empty)");
  registerSecret(raw);
  process.env.WALK_COMPOSIO_KEY = raw; // stripped from the app's env by launchDev (WALK_*)
  const KEY = () => process.env.WALK_COMPOSIO_KEY!;

  await redacting(async () => {
    const t0 = Date.now();
    const r = recorder();
    const g = Gateway.fromBox();
    await g.events();
    const usage0 = await g.call("getUsage", {});
    const pre = await preflight(g);
    const name = `${WALK_PREFIX}${nonce()}`;
    let botId = "";
    let dev: DevApp | null = null;
    const serverIds: string[] = [];
    const extra: Record<string, unknown> = { preflight: pre };
    try {
      const existing = (await g.call("listMcpServers", {})).servers.map((s) => s.id);
      ({ id: botId } = await g.call("createAgent", { name }));
      dev = await launchDev(name);
      const { win, app } = dev;
      await openBot(win, name);

      await win.getByRole("button", { name: "Marketplace" }).click();
      const dlg = win.getByRole("dialog", { name: "Marketplace" });
      await dlg.getByRole("link", { name: /Your plugins, \d+ installed/ }).click();
      await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
      await dlg.getByLabel("Name").fill("Composio");
      const url = await dlg.getByLabel("Server URL").inputValue();
      const hdr = await dlg.getByLabel("Header name").inputValue();
      r.check("B0 name autofills URL and header name", url === COMPOSIO_MCP_URL && hdr === COMPOSIO_HEADER, `url=${url} header=${hdr}`);

      // Paste, as the user would: through the clipboard, restored afterwards. The key is never an action argument.
      const prior = await app.evaluate(({ clipboard }) => clipboard.readText());
      await app.evaluate(({ clipboard }, k) => clipboard.writeText(k), KEY());
      await dlg.getByLabel("Header value").focus();
      await win.keyboard.press("Meta+V");
      await app.evaluate(({ clipboard }, p) => clipboard.writeText(p), prior);
      const m = g.mark();
      await dlg.getByRole("button", { name: "Add", exact: true }).click();

      let connected = false;
      try {
        await g.waitFor((e: SseEvent) => e.channel === "mcp-servers" && e.payload.servers.some((s) => !existing.includes(s.id) && s.name === "Composio" && s.status === "connected"), { from: m, timeoutMs: 90_000, label: "Composio connected" });
        connected = true;
      } catch (e) { extra.b1Error = (e as Error).message; }
      const listed = (await g.call("listMcpServers", {})).servers.filter((s) => !existing.includes(s.id));
      serverIds.push(...listed.map((s) => s.id));
      const comp = listed.find((s) => s.name === "Composio");
      r.check("B1 listMcpServers shows Connected", connected && comp?.status === "connected", `sse=${connected} list=${JSON.stringify(listed.map((s) => ({ id: s.id, status: s.status, tools: s.tools.length })))}`);
      expect(await win.content()).not.toContain(KEY());

      // Ground truth: the same server, called by the walk directly with the same header.
      const call = await mcp(COMPOSIO_MCP_URL, { [COMPOSIO_HEADER]: KEY() });
      const tools = ((await call("tools/list", {}))?.tools ?? []) as { name: string; inputSchema?: { required?: string[] } }[];
      const pick = tools.find((t) => !(t.inputSchema?.required ?? []).length && /LIST|GET|CHECK|SEARCH/i.test(t.name)) ?? tools.find((t) => !(t.inputSchema?.required ?? []).length);
      if (!pick) throw new Error(`no zero-argument Composio tool to call (${tools.map((t) => t.name).join(", ")})`);
      const truth = JSON.stringify(await call("tools/call", { name: pick.name, arguments: {} }));
      const prompt = `Call the Composio tool ${pick.name} exactly once with no arguments, then reply with the five longest identifier-like values from its raw result, verbatim, one per line.`;
      const tokens = [...new Set(truth.match(/[A-Za-z0-9_-]{8,}/g) ?? [])].filter((t) => /\d/.test(t) && !prompt.includes(t) && !pick.name.includes(t));
      extra.groundTruth = { tool: pick.name, candidateTokens: tokens.length };

      const mt = g.mark();
      const composer = win.getByPlaceholder(`Message ${name}`);
      await composer.fill(prompt);
      await composer.press("Enter");
      const toolCall = await g.waitFor((e: SseEvent) => e.channel === "transcript" && e.payload.botId === botId && "entry" in e.payload && e.payload.entry.kind === "tool-call" && e.payload.entry.name.toLowerCase().includes(pick.name.toLowerCase()) && e.payload.entry.status !== "running" && e.payload.entry, { from: mt, timeoutMs: 240_000, label: `tool-call ${pick.name} settles` }).catch((e: Error) => { extra.b2Error = e.message; return null; });
      r.check("B2 transcript shows a successful Composio tool call", !!toolCall && toolCall.status === "done", JSON.stringify(toolCall ? { name: toolCall.name, status: toolCall.status, step: toolCall.step } : null));
      const reply = await g.waitFor((e: SseEvent) => e.channel === "transcript" && e.payload.botId === botId && "entry" in e.payload && e.payload.entry.kind === "message" && e.payload.entry.role === "assistant" && e.payload.op === "append" && e.payload.entry.content, { from: mt, timeoutMs: 240_000, label: "assistant reply" }).catch(() => "");
      const hit = tokens.find((t) => (reply as string).includes(t));
      r.check("B3 reply holds a value only the result could", !!hit, `matched=${hit ? `${hit.slice(0, 4)}…` : "none"} of ${tokens.length} candidates; reply ${String(reply).length} chars`);

      // Control: the same URL, no header, must never reach Connected.
      const ctlName = `${name}-noauth`;
      const mc = g.mark();
      const { server: ctl } = await g.call("addMcpServer", { name: ctlName, url: COMPOSIO_MCP_URL });
      serverIds.push(ctl.id);
      const settled = await g.waitFor((e: SseEvent) => e.channel === "mcp-servers" && e.payload.servers.find((s) => s.id === ctl.id && s.status !== "unknown"), { from: mc, timeoutMs: 60_000, label: "control settles" }).catch(() => null);
      const everConnected = g.since(mc).some((e) => e.channel === "mcp-servers" && e.payload.servers.some((s) => s.id === ctl.id && s.status === "connected"));
      const finalCtl = (await g.call("listMcpServers", {})).servers.find((s) => s.id === ctl.id);
      r.check("B4 control without header never Connected", !everConnected && finalCtl?.status !== "connected", `settled=${settled?.status ?? "none"} final=${finalCtl?.status}`);
    } finally {
      await closeDev(dev);
      for (const id of serverIds) await g.call("removeMcpServer", { serverId: id }).catch(() => {});
      if (botId) extra.deleteAgent = await g.call("deleteAgent", { id: botId }).then(() => "ok", (e) => `FAILED ${(e as Error).message}`);
      extra.oauthPort = await restoreOAuthPort(g).catch((e) => `FAILED ${(e as Error).message}`);
      extra.usage = usageDelta(usage0, await g.call("getUsage", {}));
      report("J2", t0, r.out, extra);
      g.close();
    }
  });
});
