import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { CommandName, GatewayCommands } from "@synapse/shared";
import { launchLocalHost, type LocalHost } from "../src/main/local-host";
import type { Recording } from "./types";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostBundle = path.resolve(appDir, "..", "host", "dist", "host.mjs");

export interface Rig {
  page: Page;
  browser: Browser;
  call<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]>;
  record<T>(fn: () => Promise<T>): Promise<Recording>;
  /** The composited screen, every frame the compositor produces (CDP screencast): what the user SEES,
   *  View Transition pseudo-elements included, which a DOM sample cannot show. */
  film(fn: () => Promise<void>): Promise<Shot[]>;
  close(): Promise<void>;
}
export interface Shot { t: number; jpeg: string }

async function bundle(entry: string, define: Record<string, string> = {}): Promise<string> {
  const r = await build({ entryPoints: [path.join(appDir, "motion", entry)], bundle: true, write: false, format: "iife", target: "esnext", define });
  return r.outputFiles[0]!.text;
}

/**
 * The renderer, headless: the FUZZ local host (fake brain, never real Claude), the renderer's own Vite
 * config served with `/gw` proxied to that host, and a headless Chromium page with the bridge shim and
 * the frame recorder injected. No Electron, no visible window.
 */
export async function startRig(): Promise<Rig> {
  if (!fs.existsSync(hostBundle)) throw new Error(`no host bundle at ${hostBundle}: run \`node host/build.mjs\` first`);
  let host: LocalHost | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const close = async () => {
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await host?.stop().catch(() => {});
  };
  try {
    host = await launchLocalHost({ bundle: hostBundle, dataDir: "", disposable: true, nodePath: process.execPath, env: { ...process.env, WEBHOOK_PORT: "0" } });
    const h = host;
    vite = await createServer({
      configFile: path.join(appDir, "vite.config.ts"), root: path.join(appDir, "src", "renderer"), logLevel: "error",
      // Its own dependency cache (not the checkout's node_modules/.vite, which a worktree may share).
      cacheDir: path.join(os.tmpdir(), "bots-motion-vite"),
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, proxy: { "/gw": { target: h.baseUrl, changeOrigin: true, rewrite: (p) => p.replace(/^\/gw/, ""),
        // The host refuses any request with an Origin (a browser); the Electron coordinator sends none.
        configure: (proxy) => { proxy.on("proxyReq", (req) => req.removeHeader("origin")); } } } },
    });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("vite did not report a URL");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true, colorScheme: "light", reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.addInitScript(await bundle("shim.ts", { __GW_TOKEN__: JSON.stringify(h.token), __LATENCY__: String(Number(process.env.MOTION_LATENCY_MS ?? 60)) }));
    await page.addInitScript(await bundle("recorder.ts"));
    const call = async <K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]) => {
      const res = await fetch(`${h.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: JSON.stringify(args ?? {}) });
      const body = (await res.json()) as { ok: boolean; result: GatewayCommands[K]["result"]; error?: { message: string } };
      if (!body.ok) throw new Error(`${cmd}: ${body.error?.message}`);
      return body.result;
    };
    await page.goto(url);
    // Connected and the (empty) Bot list loaded before a caller creates anything: a Bot created while a cold Vite was
    // still compiling the renderer could land between its first list and its event stream, and never show (the
    // sidebar kept only the first of four Bots and the motion check timed out in its setup).
    await page.getByText("Create your first Bot").first().waitFor({ timeout: 90_000 });
    const record = async <T>(fn: () => Promise<T>): Promise<Recording> => {
      await page.evaluate(() => (window as unknown as { __motion: { start(): void } }).__motion.start());
      try { await fn(); } finally { /* always stop */ }
      await page.waitForTimeout(1200); // every spring (<= 680ms + 160ms of stagger) has settled
      return page.evaluate(() => (window as unknown as { __motion: { stop(): Recording } }).__motion.stop());
    };
    const cdp = await ctx.newCDPSession(page);
    const film = async (fn: () => Promise<void>): Promise<Shot[]> => {
      const shots: Shot[] = [];
      const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        shots.push({ t: (f.metadata.timestamp ?? 0) * 1000, jpeg: f.data });
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      };
      cdp.on("Page.screencastFrame", onFrame);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
      try { await fn(); await page.waitForTimeout(900); } finally { await cdp.send("Page.stopScreencast"); cdp.off("Page.screencastFrame", onFrame); }
      return shots;
    };
    return { page, browser, call, record, film, close };
  } catch (e) {
    await close();
    throw e;
  }
}
