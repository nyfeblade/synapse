import { log } from "../util/log";
import type { TriggerEvent } from "./types";
import { obj, str, type O } from "./util";

export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message" | "close" | "error" | "open", cb: (e: { data?: unknown }) => void): void;
}

/** Events API / Socket Mode payload → TriggerEvent (RTN-10 Slack). */
export function mapSlackEvent(payload: O, botUserId: string, selfUserId?: string): TriggerEvent | null {
  const ev = obj(payload.event);
  const eventId = str(payload.event_id);
  if (!eventId) return null;
  const type = str(ev.type);
  const occurredAt = Number(payload.event_time) > 0 ? Number(payload.event_time) * 1000 : Date.now();
  const chId = str(ev.channel) || str(obj(ev.item).channel);
  const channel = str(ev.channel_type) === "im" ? "@dm" : `#${str(ev.channel_name) || chId}`;
  const base = { source: "slack" as const, eventId, occurredAt, actor: str(ev.user), channel };
  const thread = typeof ev.thread_ts === "string" ? { thread_ts: ev.thread_ts } : {};
  if (type === "app_mention") return { ...base, kind: "mention", text: str(ev.text), raw: { ts: str(ev.ts), channel: chId, ...thread } };
  if (type === "message") {
    if ((ev.subtype && ev.subtype !== "thread_broadcast") || ev.bot_id || str(ev.user) === botUserId) return null;
    return { ...base, kind: "message", text: str(ev.text), raw: { ts: str(ev.ts), channel: chId, ...thread } };
  }
  if (type === "reaction_added") {
    const item = obj(ev.item);
    return { ...base, kind: "reaction", selfAuthored: !!selfUserId && str(ev.user) === selfUserId, text: `:${str(ev.reaction)}: on message ${str(item.ts)}`, raw: { reaction: str(ev.reaction), itemTs: str(item.ts), channel: chId } };
  }
  return null;
}

/** Socket Mode (ORIG-04 §04.3 default): no public URL; every envelope is acked. */
export class SlackSocket {
  private ws: WsLike | null = null;
  private stopped = false;
  private attempt = 0;
  private botUserId = "";
  private names = new Map<string, string>();
  private fails = 0;
  private retry: unknown = null;

  constructor(private d: { appToken(): string | null; botToken(): string | null; selfUserId?(): string | undefined; fetch?: typeof fetch; ws?(url: string): WsLike; onEvent(ev: TriggerEvent): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void; onFailures?(n: number): void }) {}

  /** Bug 51's sibling: consecutive failed opens, so a revoked app token stops reading as connected. */
  consecutiveFailures(): number { return this.fails; }

  /** New credentials were entered: they get a fresh start rather than inheriting the old ones' failures. */
  resetFailures(): void { this.fails = 0; }

  private noteFails(n: number): void {
    if (this.fails === n) return;
    this.fails = n;
    this.d.onFailures?.(n);
  }

  private api = async (method: string, token: string, qs = ""): Promise<O> => {
    const res = await (this.d.fetch ?? fetch)(`https://slack.com/api/${method}${qs}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" } });
    return obj(await res.json());
  };

  async start(): Promise<void> {
    this.stopped = false;
    const app = this.d.appToken();
    const bot = this.d.botToken();
    if (!app || !bot) return;
    try {
      this.botUserId = str((await this.api("auth.test", bot)).user_id);
      const open = await this.api("apps.connections.open", app);
      if (open.ok !== true || !str(open.url)) throw new Error(str(open.error) || "apps.connections.open failed");
      const ws = (this.d.ws ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(str(open.url));
      this.ws = ws;
      this.attempt = 0;
      this.noteFails(0);
      ws.addEventListener("message", (e) => void this.onFrame(ws, String(e.data)).catch((err) => log.warn("slack frame failed", { error: String(err) })));
      ws.addEventListener("close", () => this.reconnect(ws));
    } catch (e) {
      if (this.stopped) return;
      this.noteFails(this.fails + 1);
      log.warn("slack socket failed to start", { error: String(e) });
      this.reconnect(null);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) this.d.clearTimer(this.retry); // a pending reconnect would otherwise start() a removed socket again
    this.retry = null;
    this.ws?.close();
    this.ws = null;
  }

  private reconnect(ws: WsLike | null): void {
    if (this.stopped || (ws && this.ws !== ws)) return;
    this.ws = null;
    this.retry = this.d.setTimer(() => { this.retry = null; void this.start(); }, Math.min(5000 * 2 ** this.attempt++, 300_000));
  }

  private async onFrame(ws: WsLike, data: string): Promise<void> {
    const env = obj(JSON.parse(data));
    if (str(env.envelope_id)) ws.send(JSON.stringify({ envelope_id: str(env.envelope_id) }));
    if (env.type === "disconnect") { ws.close(); return; }
    if (env.type !== "events_api") return;
    const payload = obj(env.payload);
    const inner = obj(payload.event);
    const ch = str(inner.channel) || str(obj(inner.item).channel);
    if (ch && str(inner.channel_type) !== "im" && !inner.channel_name) inner.channel_name = await this.channelName(ch);
    const ev = mapSlackEvent(payload, this.botUserId, this.d.selfUserId?.());
    if (ev) this.d.onEvent(ev);
  }

  private async channelName(id: string): Promise<string> {
    const hit = this.names.get(id);
    if (hit) return hit;
    const bot = this.d.botToken();
    const name = bot ? str(obj((await this.api("conversations.info", bot, `?channel=${encodeURIComponent(id)}`)).channel).name) : "";
    this.names.set(id, name || id);
    return name || id;
  }
}
