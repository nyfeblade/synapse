import { PhoneAudio } from "./audio";
import { liveAvatar, stillAvatar } from "./avatar";
import { PS } from "./strings";

/**
 * Bug 198: Synapse on the phone — pair once, see the Bots, call one. Served by the Mac over the
 * user's tailnet (tailscale serve); the Mac runs the call, this page is its microphone and speaker.
 */

interface Bot { id: string; name: string; color: string; shape: string }
type Msg =
  | { type: "hello"; bots: Bot[] } | { type: "connecting"; botId: string } | { type: "live" }
  | { type: "partial" | "heard" | "line"; text: string } | { type: "speaking" } | { type: "flush" }
  | { type: "muted"; muted: boolean } | { type: "ended"; reason: string } | { type: "pong" };

const app = document.getElementById("app")!;
const state = {
  bots: [] as Bot[],
  calling: null as Bot | null,
  phase: "idle" as "idle" | "connecting" | "live" | "ended",
  muted: false,
  heard: [] as { who: string; text: string }[],
  partial: "",
  endedReason: "",
  lastAudioAt: 0,
  log: [] as Msg[],
};
const audio = new PhoneAudio();
let ws: WebSocket | null = null;
let avatar: ReturnType<typeof liveAvatar> | null = null;
let ui: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;

// Test and diagnostics hook: numbers only, nothing secret.
(window as unknown as Record<string, unknown>).__phone = { state, stats: audio.stats, get playing() { return audio.playing; } };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "className") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== false) e.append(c);
  return e;
}

function icon(name: "mic" | "mic-off" | "hang-up" | "phone"): SVGSVGElement {
  const paths: Record<string, string> = {
    mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0M12 17v3",
    "mic-off": "M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.9-.8M17 12a5 5 0 0 1-.6 2.4M7 12a5 5 0 0 0 7.5 4.3M12 17v3",
    "hang-up": "M3.5 14.5c4.7-4.3 12.3-4.3 17 0l-1.8 2.3-3.4-1.1-.4-2.3a9.5 9.5 0 0 0-5.8 0l-.4 2.3-3.4 1.1Z",
    phone: "M6.6 3.5h2.6l1.3 3.9-1.8 1.4a11 11 0 0 0 6.5 6.5l1.4-1.8 3.9 1.3v2.6a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 4.6 5.6a2 2 0 0 1 2-2.1Z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "26");
  svg.setAttribute("height", "26");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", paths[name]!);
  p.setAttribute("fill", name === "hang-up" || name === "phone" ? "currentColor" : "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", name === "hang-up" || name === "phone" ? "0" : "1.8");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

async function api<T>(path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const r = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data: T | null = null;
  try { data = (await r.json()) as T; } catch { /* not JSON */ }
  return { status: r.status, data };
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function render(node: Node): void {
  app.replaceChildren(node);
}

// ---------------- screens ----------------

function offline(): void {
  render(h("section", { className: "screen center" },
    h("h1", {}, PS.offline),
    h("button", { type: "button", className: "btn", onclick: () => void boot() }, PS.retry)));
}

function pairScreen(error = false): void {
  const input = h("input", { id: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", pattern: "[0-9 ]*", "aria-label": PS.codeLabel, className: "code", placeholder: "000000" });
  const form = h("form", { className: "pair", onsubmit: async (e: Event) => {
    e.preventDefault();
    const code = input.value.replace(/\D/g, "");
    const r = await api<{ ok: boolean }>("/api/pair", { code }).catch(() => null);
    if (!r) return offline();
    if (r.data?.ok) return void boot();
    pairScreen(true);
  } },
  h("label", { for: "code", className: "label" }, PS.codeLabel),
  input,
  error ? h("p", { className: "error", role: "alert" }, PS.badCode) : null,
  h("button", { type: "submit", className: "btn primary" }, PS.pair));
  render(h("section", { className: "screen center" }, h("h1", {}, PS.pairTitle), form));
  input.focus();
}

async function alertsRow(): Promise<HTMLElement | null> {
  if (isIos() && !standalone()) return h("p", { className: "hint", "data-testid": "ios-hint" }, PS.iosHint);
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  const perm = Notification.permission;
  const right = sub && perm === "granted"
    ? h("span", { className: "muted", "data-testid": "alerts-on" }, PS.alertsOn)
    : perm === "denied"
      ? h("span", { className: "muted" }, PS.alertsBlocked)
      : h("button", { type: "button", className: "btn small", "data-testid": "alerts-turn-on", onclick: () => void turnOnAlerts() }, PS.turnOn);
  return h("div", { className: "row setting" }, h("span", { className: "grow" }, PS.alerts), right);
}

async function turnOnAlerts(): Promise<void> {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return void listScreen();
    const reg = await navigator.serviceWorker.ready;
    const key = await api<{ publicKey: string }>("/api/push/key");
    if (!key.data?.publicKey) return;
    const raw = atob(key.data.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
    const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await api("/api/push/subscribe", sub.toJSON());
  } catch (e) {
    console.warn("alerts", e);
  }
  void listScreen();
}

async function listScreen(ring?: Bot): Promise<void> {
  const r = await api<{ bots: Bot[] }>("/api/bots").catch(() => null);
  if (!r) return offline();
  if (r.status === 401) return pairScreen();
  state.bots = r.data?.bots ?? [];
  const list = h("ul", { className: "bots", "aria-label": PS.bots });
  for (const b of state.bots) {
    list.append(h("li", {},
      h("button", { type: "button", className: "bot", "aria-label": PS.call(b.name), onclick: () => void startCall(b) },
        stillAvatar(b.shape, b.color, 44),
        h("span", { className: "name" }, b.name),
        h("span", { className: "call-glyph" }, icon("phone")))));
  }
  const ringing = ring ? h("div", { className: "ringing", role: "alertdialog", "aria-label": PS.isCalling(ring.name) },
    stillAvatar(ring.shape, ring.color, 40),
    h("span", { className: "grow" }, PS.isCalling(ring.name)),
    h("button", { type: "button", className: "btn small", onclick: () => void listScreen() }, PS.decline),
    h("button", { type: "button", className: "btn small primary", onclick: () => void startCall(ring) }, PS.answer)) : null;
  const alerts = await alertsRow();
  render(h("section", { className: "screen list" },
    h("header", {}, h("h1", {}, PS.bots)),
    ringing,
    state.bots.length ? list : h("p", { className: "muted empty" }, PS.noBots),
    alerts));
}

function callScreen(): void {
  const b = state.calling!;
  avatar?.destroy();
  avatar = liveAvatar(b.shape, b.color, 148, b.id.length);
  const label = h("p", { className: "state", "data-testid": "call-state", "aria-live": "polite" });
  const timer = h("p", { className: "timer muted" });
  const caps = h("div", { className: "captions", "aria-live": "polite", "data-testid": "captions" });
  const muteBtn = h("button", { type: "button", className: "round", "aria-pressed": "false", "aria-label": PS.mute, onclick: () => toggleMute() }, icon("mic"));
  const hang = h("button", { type: "button", className: "round hang-up", "aria-label": PS.hangUp, onclick: () => void hangUp() }, icon("hang-up"));
  const halo = h("span", { className: "halo", "aria-hidden": "true" });
  render(h("section", { className: "screen call" },
    h("div", { className: "who" }, h("div", { className: "avatar-wrap" }, halo, avatar.svg), h("h1", {}, b.name), label, timer),
    caps,
    h("div", { className: "controls" }, muteBtn, hang)));
  const paint = () => {
    const speaking = audio.playing || performance.now() - state.lastAudioAt < 250;
    const text = state.phase === "ended" ? endedText() : state.phase === "connecting" ? PS.connecting : state.muted ? PS.muted : speaking ? PS.speaking : PS.listening;
    if (label.textContent !== text) label.textContent = text;
    const s = startedAt && state.phase !== "connecting" ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    timer.textContent = startedAt ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
    avatar?.speaking(speaking ? audio.level : null);
    halo.style.setProperty("--level", String(speaking ? 1 + audio.level / 3 : 1));
    halo.dataset.on = speaking ? "true" : "false";
    muteBtn.replaceChildren(icon(state.muted ? "mic-off" : "mic"));
    muteBtn.setAttribute("aria-pressed", String(state.muted));
    muteBtn.setAttribute("aria-label", state.muted ? PS.unmute : PS.mute);
    muteBtn.className = state.muted ? "round on" : "round";
    const lines = [...state.heard.slice(-2)];
    if (state.partial) lines.push({ who: PS.you, text: state.partial });
    const html = lines.slice(-2).map((l) => `${l.who}\u0000${l.text}`).join("\u0001");
    if (caps.dataset.key !== html) {
      caps.dataset.key = html;
      caps.replaceChildren(...lines.slice(-2).map((l) => h("p", {}, h("b", {}, l.who), " ", l.text)));
    }
  };
  if (ui) clearInterval(ui);
  ui = setInterval(paint, 100);
  paint();
}

function endedText(): string {
  return state.endedReason === "failed" ? PS.failed : state.endedReason === "elsewhere" ? PS.elsewhere : PS.ended;
}

// ---------------- the call ----------------

function wsUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

async function startCall(b: Bot): Promise<void> {
  if (state.calling) return;
  state.calling = b;
  state.phase = "connecting";
  state.muted = false;
  state.heard = [];
  state.partial = "";
  state.endedReason = "";
  startedAt = 0;
  callScreen();
  try {
    // Inside the tap: iOS only starts audio and the microphone from a gesture.
    await audio.start((pcm) => { if (ws?.readyState === WebSocket.OPEN && state.phase === "live") ws.send(pcm); });
  } catch (e) {
    console.warn("audio", e);
    state.endedReason = "mic";
    return finish(false, PS.micDenied);
  }
  const sock = new WebSocket(wsUrl());
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ type: "call", botId: b.id }));
  sock.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") { state.lastAudioAt = performance.now(); audio.play(e.data); return; }
    let m: Msg;
    try { m = JSON.parse(e.data) as Msg; } catch { return; }
    state.log.push(m);
    if (state.log.length > 200) state.log.shift();
    switch (m.type) {
      case "live": state.phase = "live"; startedAt = Date.now(); break;
      case "partial": state.partial = m.text; break;
      case "heard": state.partial = ""; state.heard.push({ who: PS.you, text: m.text }); break;
      case "line": state.heard.push({ who: b.name, text: m.text }); break;
      case "flush": audio.flush(); break;
      case "ended": state.endedReason = m.reason; void finish(true); break;
      default: break;
    }
  };
  sock.onclose = () => { if (ws === sock && state.calling) { state.endedReason = state.endedReason || "lost"; void finish(true); } };
}

function toggleMute(): void {
  state.muted = !state.muted;
  audio.mute(state.muted);
  ws?.send(JSON.stringify({ type: "mute", muted: state.muted }));
}

async function hangUp(): Promise<void> {
  if (!state.calling) return;
  try { ws?.send(JSON.stringify({ type: "hangup" })); } catch { /* closing anyway */ }
  state.endedReason = "you";
  await finish(true);
}

async function finish(tone: boolean, message?: string): Promise<void> {
  if (!state.calling || state.phase === "ended") return;
  const connected = state.phase === "live";
  state.phase = "ended";
  const sock = ws;
  ws = null;
  try { sock?.close(); } catch { /* already closed */ }
  await audio.hangUp(tone && connected);
  if (message) {
    const label = document.querySelector<HTMLElement>("[data-testid=call-state]");
    if (label) label.textContent = message;
  }
  await new Promise((r) => setTimeout(r, 900));
  if (ui) clearInterval(ui);
  ui = null;
  avatar?.destroy();
  avatar = null;
  state.calling = null;
  state.phase = "idle";
  void listScreen();
}

// ---------------- start ----------------

async function boot(): Promise<void> {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e: unknown) => console.warn("sw", e));
  const s = await api<{ paired: boolean }>("/api/session").catch(() => null);
  if (!s || s.status !== 200) return offline();
  if (!s.data?.paired) return pairScreen();
  // A notification tap: ?call=<botId> (the Bot's id is not a secret; the page still needs the cookie).
  const want = new URLSearchParams(location.search).get("call");
  if (want) history.replaceState(null, "", "/");
  await listScreen();
  const ring = want ? state.bots.find((b) => b.id === want) : undefined;
  if (ring) await listScreen(ring);
}

navigator.serviceWorker?.addEventListener("message", (e: MessageEvent<{ type?: string; botId?: string }>) => {
  if (e.data?.type !== "call" || state.calling) return;
  const b = state.bots.find((x) => x.id === e.data.botId);
  if (b) void listScreen(b);
});

void boot();
