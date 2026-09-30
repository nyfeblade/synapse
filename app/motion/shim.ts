/**
 * `window.synapse` for the renderer in a plain (headless) browser: the motion check runs the real
 * renderer against the FUZZ local host (fake brain, stub reviewer) without Electron, so no window
 * ever opens on the user's screen. Gateway calls and the event stream go straight to the host,
 * through the check's dev server (`/gw` is proxied to the host, which adds no CORS headers). Native
 * surfaces (VNC, secrets, updates, the box lifecycle) answer inertly: the motion check never uses them.
 * Bundled by esbuild into an init script (harness.ts), so it runs before the renderer's own modules.
 */
import { SseParser } from "../src/coordinator/sse-parser";

declare const __GW_TOKEN__: string;
/** The real app reaches its host in a VM through the coordinator: calls and events arrive late, and not
 *  in a promised order. The check adds that latency (ms) to both, so motion is judged at real timing. */
declare const __LATENCY__: number;
const later = (fn: () => void) => { if (__LATENCY__ > 0) setTimeout(fn, __LATENCY__); else fn(); };
type Cb = (x: unknown) => void;
const events = new Set<Cb>();
const conns = new Set<Cb>();
let connection: unknown = { kind: "starting" };
const setConn = (c: unknown) => { connection = c; for (const s of conns) s(c); };
const headers = { authorization: `Bearer ${__GW_TOKEN__}` };

async function stream(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch("/gw/events", { headers: { ...headers, accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      setConn({ kind: "connected" });
      const parser = new SseParser((d) => { let e: unknown; try { e = JSON.parse(d); } catch { return; } later(() => { for (const s of events) s(e); }); });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; parser.feed(value); }
    } catch { /* retry */ }
    setConn({ kind: "reconnecting", attempt: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
}

const inert = async () => ({ ok: false, error: { code: "UNSUPPORTED", message: "not in the motion check" } });
(window as unknown as { synapse: unknown }).synapse = {
  call: async (cmd: string, args: unknown) => {
    // `tokenConfigured` too: the public build shows the API-key screen until a key is saved (the check never uses one).
    if (cmd === "getOnboarding") return { ok: true, result: { hasSeenOnboarding: true, tokenConfigured: true } };
    const res = await fetch(`/gw/api/${cmd}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(args ?? {}) });
    const body: unknown = await res.json();
    return new Promise((r) => later(() => r(body)));
  },
  onEvent: (cb: Cb) => { events.add(cb); return () => events.delete(cb); },
  onConnection: (cb: Cb) => { conns.add(cb); cb(connection); return () => conns.delete(cb); },
  retry: () => {},
  appInfo: async () => ({ userName: "Tester" }),
  vncUrl: () => null,
  secrets: { list: async () => [], save: inert, remove: inert, keepOnBox: inert, rename: inert, submitRequest: async () => "", submitForm: async () => "" },
  box: { update: async () => ({ status: "done" }), recover: async () => {}, reset: async () => {}, info: async () => ({ bundledImageVersion: "motion" }), onLifecycle: () => () => {} },
  saveFile: async () => ({ saved: false }),
  onOpenBot: () => () => {},
  setNativeTheme: () => {},
  native: { invoke: inert, on: () => () => {} },
};
/** The reply scenario drives the renderer with the host's exact event sequence for a streamed reply
 *  (glitch.motion.ts): the fake brain cannot stream a SendMessage, so the check delivers those events
 *  itself, through the same subscribers the host stream feeds. */
(window as unknown as { __motionInject: (e: unknown) => void }).__motionInject = (e) => { for (const s of events) s(e); };
void stream();
