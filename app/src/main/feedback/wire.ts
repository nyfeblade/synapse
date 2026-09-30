import { execFile } from "node:child_process";
import path from "node:path";
import { FEEDBACK_ISSUE_PREFIX, FEEDBACK_LIMITS, FEEDBACK_MAX_ISSUE_URL, FEEDBACK_TYPES, type FeedbackPayload } from "@synapse/shared";
import { tail } from "../crash/store";
import { RatingsStore, type Rating, type RatingKind } from "./ratings";
import { ThreadStore, startThreadPolling, type ThreadMessage } from "./threads";
import { scrubLines, scrubText } from "./scrub";

/**
 * Send feedback (account menu, ⌘K, Help menu, and "Send a report" after a problem). The renderer
 * shows the user exactly what goes; main gathers the parts only main can reach (scrubbed logs, the
 * window's own screenshot, the Mac's version and model) and does the one network call, to the
 * website's /api/feedback. Ratings are here too: local only.
 */
export const FEEDBACK_URL = "https://synapse-site-virid.vercel.app/api/feedback";
const ISSUE_PREFIX = FEEDBACK_ISSUE_PREFIX;
const TYPES = FEEDBACK_TYPES;
const LIMITS = FEEDBACK_LIMITS;

/** The smallest image interface capture needs: Electron's NativeImage fits it. */
export interface ImageLike { getSize(): { width: number; height: number }; resize(o: { width: number }): ImageLike; toPNG(): Buffer }

/** A PNG of the window, scaled down until its base64 fits the endpoint's limit. Null if it never fits. */
export function fitPng(img: ImageLike, maxChars = LIMITS.screenshotChars): string | null {
  const w = img.getSize().width;
  for (const width of [Math.min(w, 1440), 1200, 1000, 800, 640]) {
    if (width > w) continue;
    const png = (width === w ? img : img.resize({ width })).toPNG();
    const b64 = png.toString("base64");
    if (b64.length <= maxChars) return b64;
  }
  return null;
}

export function checkPayload(p: unknown): FeedbackPayload {
  const x = (p ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  if (!TYPES.includes(x.type as FeedbackPayload["type"])) throw new Error("Choose a type.");
  const message = typeof x.message === "string" ? x.message.trim() : "";
  if (!message) throw new Error("Write a message first.");
  if (message.length > LIMITS.message) throw new Error(`Keep it under ${LIMITS.message} characters.`);
  const logs = typeof x.logs === "string" && x.logs ? x.logs : undefined;
  if (logs && Buffer.byteLength(logs) > LIMITS.logsBytes) throw new Error("The logs are too long.");
  const shot = typeof x.screenshot === "string" && x.screenshot ? x.screenshot : undefined;
  if (shot && (shot.length > LIMITS.screenshotChars || !/^[A-Za-z0-9+/]+=*$/.test(shot))) throw new Error("The screenshot is too big.");
  return {
    source: "app", type: x.type as FeedbackPayload["type"], message,
    appVersion: str(x.appVersion, 40), macos: str(x.macos, 40), model: str(x.model, 60),
    ...(logs ? { logs } : {}), ...(shot ? { screenshot: shot } : {}),
  };
}

let modelCache: Promise<string> | null = null;
function macModel(): Promise<string> {
  modelCache ??= new Promise((resolve) => execFile("/usr/sbin/sysctl", ["-n", "hw.model"], { timeout: 3000 }, (e, out) => resolve(e ? "Mac" : String(out).trim() || "Mac")));
  return modelCache;
}

export function installFeedback(o: {
  reg(name: string, fn: (a: any) => unknown): void;
  userData: string; home: string; appVersion: string; macos: string;
  logFiles(): string[]; secrets(): string[];
  /** A crash report's text, or the newest one's for "latest"; null when there is none. */
  crashText(id: string): string | null;
  capture(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch; model?: () => Promise<string>; offline?: boolean;
  /** Where Send privately posts; FEEDBACK_URL unless a development build overrides it. */
  endpoint?: string;
  /** The Mac's account name, scrubbed from the logs wherever it appears. */
  username?: string;
  /** A reply arrived (count of unread replies): the in-app notice and, if allowed, a macOS notification. */
  onReply?(unread: number): void;
  /** Tests: when the first background check runs. */
  firstPollMs?: number;
  /** Writes to the system clipboard (Electron's clipboard.writeText). */
  copyText?(text: string): void;
}) {
  const secrets = () => { try { return o.secrets(); } catch { return []; } };
  const scrubOpts = () => ({ home: o.home, knownValues: secrets(), username: o.username });
  const ratings = new RatingsStore(path.join(o.userData, "feedback-ratings.json"));
  const endpoint = o.endpoint || FEEDBACK_URL;
  const threads = new ThreadStore(path.join(o.userData, "feedback-threads.json"));
  const doFetch = (url: string, init: RequestInit) => (o.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(20_000) });
  /** One thread from the server; the code goes only in the header. */
  async function refreshOne(code: string): Promise<number> {
    const r = await doFetch(`${endpoint}/thread`, { method: "GET", headers: { accept: "application/json", "x-feedback-code": code } });
    if (r.status === 404) { threads.notFound(code); return 0; }
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: "open" | "closed"; messages?: ThreadMessage[] };
    if (!r.ok || !j.ok || !Array.isArray(j.messages)) throw new Error("Couldn't load replies.");
    return threads.update(code, { status: j.status === "closed" ? "closed" : "open", messages: j.messages });
  }
  async function checkAll(): Promise<void> {
    if (o.offline) return;
    let fresh = 0;
    for (const t of threads.active()) fresh += await refreshOne(t.code).catch(() => 0);
    if (fresh > 0) o.onReply?.(threads.unread());
  }
  const poller = startThreadPolling({ store: threads, check: checkAll, firstDelayMs: o.firstPollMs });

  o.reg("feedback.context", async (a: { crash?: unknown }) => {
    const crash = typeof a?.crash === "string" && a.crash ? o.crashText(a.crash) : null;
    const logs = crash
      ? scrubLines(crash.split("\n"), { ...scrubOpts(), max: 400, maxBytes: 60 * 1024 })
      : scrubLines(tail(o.logFiles(), 300), { ...scrubOpts(), max: 300, maxBytes: 60 * 1024 });
    return { appVersion: o.appVersion, macos: `macOS ${o.macos}`, model: await (o.model ?? macModel)(), logs };
  });
  o.reg("feedback.screenshot", async () => ({ png: await o.capture().catch(() => null) }));
  o.reg("feedback.send", async (a: unknown) => {
    const p = checkPayload(a);
    // Logs only ever come from feedback.context; scrubbing again is a no-op for them and a guard for anything else.
    if (p.logs) p.logs = scrubText(p.logs, scrubOpts());
    // Test mode (FUZZ) never sends; the sheet says so instead of claiming it went.
    if (o.offline) return { ok: true, testMode: true };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await (o.fetch ?? fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(p), signal: ctl.signal });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; thread?: unknown };
      if (!r.ok || !j.ok) throw new Error(j.error || "Couldn't send it. Try again later.");
      if (typeof j.thread === "string") { threads.add(j.thread, p.message); poller.kick(); }
      return { ok: true };
    } catch (e) {
      throw new Error(e instanceof Error && e.name !== "AbortError" && !/fetch failed/i.test(e.message) ? e.message : "Couldn't send it. Check your connection and try again.");
    } finally { clearTimeout(timer); }
  });
  o.reg("feedback.openIssue", async (a: { url?: unknown }) => {
    const url = typeof a?.url === "string" ? a.url : "";
    if (!url.startsWith(ISSUE_PREFIX) || url.length > FEEDBACK_MAX_ISSUE_URL) throw new Error("That link can't be opened.");
    if (!o.offline) await o.openExternal(url);
    return {};
  });
  o.reg("feedback.threads.list", () => ({ threads: threads.list(), unread: threads.unread() }));
  o.reg("feedback.threads.refresh", async () => { await checkAll(); return { threads: threads.list(), unread: threads.unread() }; });
  o.reg("feedback.threads.markSeen", () => { threads.markSeen(); return {}; });
  o.reg("feedback.threads.reply", async (a: { id?: unknown; message?: unknown }) => {
    const code = threads.codeFor(String(a?.id ?? ""));
    if (!code) throw new Error("That conversation is gone.");
    const message = typeof a?.message === "string" ? a.message.trim() : "";
    if (!message) throw new Error("Write a message first.");
    if (o.offline) return { threads: threads.list() };
    let r: Response;
    try {
      r = await doFetch(`${endpoint}/thread`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-feedback-code": code }, body: JSON.stringify({ message: message.slice(0, 5000) }) });
    } catch { throw new Error("Couldn't send it. Check your connection and try again."); }
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) throw new Error(j.error || "Couldn't send it. Try again later.");
    await refreshOne(code).catch(() => 0);
    return { threads: threads.list(), unread: threads.unread() };
  });
  // Copy link: the website's private page for this thread, written straight to the clipboard so the code
  // never reaches the renderer. Works in test mode too (nothing is sent). Never logged.
  o.reg("feedback.threads.link", (a: { id?: unknown }) => {
    const code = threads.codeFor(String(a?.id ?? ""));
    if (!code) throw new Error("That conversation is gone.");
    if (!o.copyText) throw new Error("Couldn't copy the link.");
    o.copyText(`${new URL(endpoint).origin}/feedback/thread#${code}`);
    return { ok: true };
  });
  o.reg("ratings.get", (a: { botId?: unknown }) => ratings.get(String(a?.botId ?? "")));
  o.reg("ratings.set", (a: { botId?: unknown; entryId?: unknown; kind?: unknown; value?: unknown }) =>
    ratings.set(String(a?.botId ?? ""), String(a?.entryId ?? ""), (a?.kind === "task" ? "task" : "reply") as RatingKind, (a?.value === 1 || a?.value === -1 ? a.value : 0) as Rating | 0));
  return { ratings, threads, checkThreads: checkAll, stopPolling: () => poller.stop() };
}
