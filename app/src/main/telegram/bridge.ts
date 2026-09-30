import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BROWSER_PERMISSION_PREFIX, LIMITS, STR5, STRB, STR_HEALTH, STR_TELEGRAM, type BotSummary, type HealthState, type LocalAction, type LocalAskStatus, type LocalToolCardView, type SendMessageEntry, type SseEvent } from "@synapse/shared";
import type { Call } from "../gateway-call";
import { TelegramApi, TelegramApiError, type TelegramApiOpts, type TgCallback, type TgInlineKeyboard, type TgMessage, type TgUpdate } from "./api";
import type { TelegramStore } from "./store";
import { clip, outgoing, splitText, TG_MAX_CAPTION, TG_MAX_TEXT } from "./text";

const C = STR_TELEGRAM.chat;

/** What Settings → System → Telegram shows. Never the token. */
export interface TelegramStatusView {
  enabled: boolean;
  polling: boolean;
  hasToken: boolean;
  botUsername: string | null;
  owner: { name: string; pairedAt: number } | null;
  pairing: { code: string; link: string | null; expiresAt: number } | null;
  error: string | null;
}

export interface TelegramBridgeDeps {
  store: TelegramStore;
  /** Tests point this at a fake Bot API server. */
  api?: TelegramApiOpts;
  /** The host's gateway, or null while Synapse isn't connected to it. */
  call(): Call | null;
  /** Ask the coordinator to forward (or stop forwarding) the Bots' send-message events. */
  watch(on: boolean): void;
  changed(): void;
  log(line: string): void;
  now?(): number;
  pollTimeoutSec?: number;
  backoffMs?: { min: number; max: number };
  /** The gap between two messages to the owner's chat (Telegram throttles bursts; 429s are waited out). */
  sendGapMs?: number;
  pairingTtlMs?: number;
  limits?: { promptsPerMinute: number; pressesPerMinute: number };
  /** A Mac card's answer through the coordinator's gate (the in-app card's path). Absent = Mac cards stay app-only. */
  answerLocal?(a: LocalAnswer): Promise<{ status: LocalAskStatus }>;
  catchUpRetryMs?: number;
}

type CardRef = { kind: "auto"; approvalId: string } | { kind: "local"; askId: string; action: LocalAction; target: string };
interface Card { key: string; botId: string; ref: CardRef; nonce: string | null; messageId: number | null; text: string; approvable: boolean; outcome: string | null; sending: boolean }
/** A Mac card's answer, as the in-app card sends it (only once / deny from Telegram). */
export interface LocalAnswer { id: string; askId: string; choice: "once" | "deny"; action: LocalAction; target: string }
interface Pairing { code: string; expiresAt: number; tries: number; timer: NodeJS.Timeout }

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_TRIES = 5;
/** A message older than this when first seen (sent while the Mac was off) is not run as a prompt. */
export const STALE_MESSAGE_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_CARDS = 200;
const MAX_QUEUE = 100;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** A card longer than this (header, description and exact text) is cut, and then offers only Deny. */
export const CARD_MAX = 3500;
const CATCH_UP_TRIES = 60;

/** Control, zero-width and direction-changing characters, shown as \u{…} so a command reads as what it is. */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`);
}
const CALLBACK = /^a:([A-Za-z0-9_-]{22}):([yn])$/;
const COMMAND = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

/** A sliding one-minute window. */
class PerMinute {
  private hits: number[] = [];
  private warned = false;
  constructor(private max: number, private now: () => number) {}
  /** "ok", "warn" (first refusal: tell the owner once) or "drop". */
  take(): "ok" | "warn" | "drop" {
    const t = this.now();
    this.hits = this.hits.filter((x) => t - x < 60_000);
    if (this.hits.length < this.max) { this.hits.push(t); this.warned = false; return "ok"; }
    if (this.warned) return "drop";
    this.warned = true;
    return "warn";
  }
}

function makeCode(): string {
  const b = randomBytes(8);
  return [...b].map((x) => CODE_ALPHABET[x & 31]).join("");
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a.toUpperCase());
  const y = Buffer.from(b.toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

const isForwarded = (m: TgMessage): boolean =>
  m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_from_chat !== undefined || m.forward_date !== undefined || m.via_bot !== undefined || m.is_automatic_forward === true;

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Wave 4.1: the owner's Telegram ↔ their Bots. Long-polls the Bot API from this Mac (no Synapse server), accepts
 * only the paired owner's private chat, turns their text into owner messages, sends the chosen Bot's replies
 * back, and every pending approval card as Approve / Deny buttons settled through the host's gate.
 * Off = no poll, no timer, no events. See docs/superpowers/specs/2026-09-30-telegram-bridge-design.md.
 */
export class TelegramBridge {
  private api: TelegramApi | null = null;
  private token: string | null = null;
  private ac: AbortController | null = null;
  private gen = 0;
  private error: string | null = null;
  private pairing: Pairing | null = null;
  private cards = new Map<string, Card>();
  private nonces = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private prompts: PerMinute;
  private presses: PerMinute;
  private botsCache: { at: number; bots: BotSummary[] } | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;

  constructor(private d: TelegramBridgeDeps) {
    const now = () => this.now();
    this.prompts = new PerMinute(d.limits?.promptsPerMinute ?? 20, now);
    this.presses = new PerMinute(d.limits?.pressesPerMinute ?? 30, now);
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  get polling(): boolean { return this.ac !== null; }

  status(): TelegramStatusView {
    const s = this.d.store.read();
    const p = this.pairing && this.pairing.expiresAt > this.now() ? this.pairing : null;
    return {
      enabled: s.enabled,
      polling: this.polling,
      hasToken: s.sealedToken !== null,
      botUsername: s.botUsername,
      owner: s.owner ? { name: s.owner.name, pairedAt: s.owner.pairedAt } : null,
      pairing: p ? { code: p.code, link: s.botUsername ? `https://t.me/${s.botUsername}?start=${p.code}` : null, expiresAt: p.expiresAt } : null,
      error: this.error,
    };
  }

  /**
   * 4.4: this connection's health for Settings → Connections (null: not set up, or turned off). A dropped network
   * is only a blip until connector health's grace period says otherwise; a rejected token needs the owner.
   */
  health(): { state: HealthState | null; reason: string | null; network: boolean } {
    const s = this.d.store.read();
    if (!s.sealedToken || !s.enabled) return { state: null, reason: null, network: false };
    switch (this.error) {
      case "token-rejected": return { state: "needs-sign-in", reason: STR_HEALTH.reasons.tokenRejected, network: false };
      case "conflict": return { state: "broken", reason: STR_HEALTH.reasons.conflict, network: false };
      case "network": return { state: "broken", reason: STR_HEALTH.reasons.unreachable, network: true };
      default: return { state: this.polling && !this.error ? "ok" : "checking", reason: null, network: false };
    }
  }

  /**
   * 4.4: "<Bot> finished: …" to the owner's chat, when paired and on. Not for the Bot the chat is talking to: its
   * reply already came here.
   */
  notifyOwner(botId: string, text: string): void {
    const s = this.d.store.read();
    if (!s.enabled || !this.polling || !s.owner || s.activeBotId === botId || !text.trim()) return;
    this.say(text);
  }

  // ---------- settings ----------

  /** Checks the token with getMe, then keeps it sealed. A new token is a new bot: pairing starts over. */
  async setToken(raw: string): Promise<TelegramStatusView> {
    const token = String(raw ?? "").trim();
    if (!/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(token)) throw new Error(STR_TELEGRAM.errors["bad-token"]);
    const api = new TelegramApi(token, this.d.api);
    let me: { username?: string; is_bot?: boolean };
    try { me = await api.call("getMe"); } catch { throw new Error(STR_TELEGRAM.errors["bad-token"]); }
    if (!me?.is_bot || typeof me.username !== "string") throw new Error(STR_TELEGRAM.errors["bad-token"]);
    const wasOn = this.d.store.read().enabled;
    this.stop();
    try { this.d.store.setToken(token, me.username.slice(0, 64)); } catch { throw new Error(STR_TELEGRAM.errors["no-secrets"]); }
    this.error = null;
    if (wasOn) this.start();
    this.d.changed();
    return this.status();
  }

  async enable(): Promise<TelegramStatusView> {
    const s = this.d.store.read();
    if (!s.sealedToken) throw new Error(STR_TELEGRAM.errors["no-token"]);
    this.d.store.write({ enabled: true });
    this.start();
    this.d.changed();
    return this.status();
  }

  disable(): TelegramStatusView {
    this.d.store.write({ enabled: false });
    this.stop();
    this.error = null;
    this.d.changed();
    return this.status();
  }

  /** Forget the token (and so the owner). The bot itself is the owner's to delete in @BotFather. */
  remove(): TelegramStatusView {
    this.stop();
    this.d.store.forgetToken();
    this.error = null;
    this.d.changed();
    return this.status();
  }

  startPairing(): TelegramStatusView {
    const s = this.d.store.read();
    if (!s.enabled || !this.polling) throw new Error(STR_TELEGRAM.errors["no-token"]);
    this.cancelPairing(false);
    const ttl = this.d.pairingTtlMs ?? PAIRING_TTL_MS;
    const timer = setTimeout(() => { this.pairing = null; this.d.changed(); }, ttl);
    timer.unref?.();
    this.pairing = { code: makeCode(), expiresAt: this.now() + ttl, tries: 0, timer };
    this.d.changed();
    return this.status();
  }

  cancelPairing(notify = true): TelegramStatusView {
    if (this.pairing) { clearTimeout(this.pairing.timer); this.pairing = null; }
    if (notify) this.d.changed();
    return this.status();
  }

  /** Forget the owner: nothing from Telegram is accepted until the next pairing, and every button stops working. */
  unpair(): TelegramStatusView {
    this.d.store.write({ owner: null, activeBotId: null });
    this.dropCards();
    this.d.changed();
    return this.status();
  }

  // ---------- life ----------

  /** At launch, and again once the app's secrets open: poll only if the owner turned it on. */
  resume(): void {
    if (this.d.store.read().enabled && !this.polling) this.start();
  }

  private start(): void {
    this.stop();
    const token = this.d.store.token();
    if (!token) { this.error = this.d.store.read().sealedToken ? "no-secrets" : "no-token"; return; }
    this.token = token;
    this.error = null;
    this.api = new TelegramApi(token, this.d.api);
    this.ac = new AbortController();
    const gen = ++this.gen;
    this.d.watch(true);
    void this.api.call("setMyCommands", { commands: [
      { command: "bots", description: "List your Bots" },
      { command: "bot", description: "Pick a Bot" },
      { command: "stop", description: "Stop the Bot" },
    ] }).catch(() => {});
    void this.loop(gen, this.ac.signal);
    void this.catchUp(gen);
  }

  private stop(): void {
    this.gen++;
    this.ac?.abort();
    this.ac = null;
    if (this.api) this.d.watch(false);
    this.api = null;
    this.token = null;
    this.cancelPairing(false);
    this.dropCards();
    this.botsCache = null;
    if (this.catchUpTimer) { clearTimeout(this.catchUpTimer); this.catchUpTimer = null; }
  }

  dispose(): void { this.stop(); }

  private async loop(gen: number, signal: AbortSignal): Promise<void> {
    const back = this.d.backoffMs ?? { min: 1000, max: 60_000 };
    let delay = back.min;
    while (gen === this.gen && !signal.aborted) {
      const api = this.api!;
      try {
        const offset = this.d.store.read().offset;
        const timeout = this.d.pollTimeoutSec ?? 50;
        // A connection that hangs past the long poll's own end counts as a network failure (and backs off).
        const updates = await api.call<TgUpdate[]>("getUpdates", {
          offset, timeout, allowed_updates: ["message", "callback_query", "my_chat_member"],
        }, AbortSignal.any([signal, AbortSignal.timeout((timeout + 15) * 1000)]));
        if (gen !== this.gen) return;
        if (this.error) { this.error = null; this.d.changed(); }
        delay = back.min;
        const list = Array.isArray(updates) ? updates : [];
        if (list.length) {
          // At most once: the offset moves past the batch before it is handled, so a crash never runs a prompt twice.
          this.d.store.write({ offset: Math.max(offset, ...list.map((u) => u.update_id + 1)) });
          for (const u of list) {
            try { await this.handle(u); } catch (e) { this.d.log(`telegram: an update failed: ${e instanceof Error ? e.message : String(e)}`); }
            if (gen !== this.gen) return;
          }
        }
      } catch (e) {
        if (signal.aborted || gen !== this.gen) return;
        const code = e instanceof TelegramApiError ? e.code : 0;
        if (code === 401 || code === 404) {
          // The token was revoked in @BotFather (or the bot deleted): stop until the owner fixes it.
          this.error = "token-rejected";
          this.d.log("telegram: the token was rejected; polling stopped");
          this.gen++;
          this.ac = null;
          this.api = null;
          this.d.watch(false);
          this.d.changed();
          return;
        }
        const err = code === 409 ? "conflict" : "network";
        if (this.error !== err) { this.error = err; this.d.log(`telegram: poll failed (${err}); retrying`); this.d.changed(); }
        const wait = code === 429 && e instanceof TelegramApiError && e.retryAfter ? e.retryAfter * 1000 : delay;
        await sleep(wait, signal);
        delay = Math.min(back.max, delay * 2);
      }
    }
  }

  // ---------- incoming ----------

  private async handle(u: TgUpdate): Promise<void> {
    if (u.my_chat_member) {
      const chat = u.my_chat_member.chat;
      const status = u.my_chat_member.new_chat_member?.status;
      if (chat.type !== "private" && (status === "member" || status === "administrator")) {
        this.d.log("telegram: refused a group chat; left it");
        await this.api?.call("leaveChat", { chat_id: chat.id }).catch(() => {});
      }
      return;
    }
    if (u.callback_query) return this.onPress(u.callback_query);
    if (u.message) return this.onMessage(u.message);
  }

  private async onMessage(m: TgMessage): Promise<void> {
    if (m.chat?.type !== "private") {
      this.d.log("telegram: refused a group chat message; left it");
      await this.api?.call("leaveChat", { chat_id: m.chat.id }).catch(() => {});
      return;
    }
    const from = m.from;
    if (!from || from.is_bot || from.id !== m.chat.id) { this.d.log("telegram: ignored a message from another user"); return; }
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const owner = this.d.store.read().owner;
    const isOwner = owner !== null && owner.userId === from.id && owner.chatId === m.chat.id;

    if (this.pairing && this.pairing.expiresAt > this.now() && !isForwarded(m)) {
      const candidate = text.replace(/^\/start\s*/i, "").trim();
      if (candidate && sameCode(candidate, this.pairing.code)) return this.paired(m);
      if (!isOwner && candidate) {
        if (++this.pairing.tries >= PAIRING_MAX_TRIES) { this.cancelPairing(false); this.d.changed(); }
      }
    }
    if (!isOwner) { this.d.log("telegram: ignored a message from another user"); return; }
    if (isForwarded(m)) { this.d.log("telegram: refused a forwarded message"); this.say(C.forwarded); return; }
    if (this.now() - m.date * 1000 > STALE_MESSAGE_MS) { this.d.log("telegram: skipped a message sent while Synapse was off"); return; }
    if (!text) { this.say(C.textOnly); return; }

    const cmd = COMMAND.exec(text);
    if (cmd) {
      const name = cmd[1]!.toLowerCase();
      const arg = (cmd[2] ?? "").trim();
      if (name === "start" || name === "help") { this.say(C.help); return; }
      if (name === "bots") { await this.listBots(); return; }
      if (name === "bot") { await this.pickBot(arg); return; }
      if (name === "stop") { await this.stopBot(); return; }
    }
    const rate = this.prompts.take();
    if (rate !== "ok") { if (rate === "warn") this.say(C.slowDown); return; }
    const call = this.d.call();
    if (!call) { this.say(C.notConnected); return; }
    const bot = await this.currentBot(call);
    if (!bot) return;
    try {
      await call("sendPrompt", { id: bot.id, text, clientNonce: randomUUID() });
      void this.api?.call("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => {});
    } catch (e) {
      this.d.log(`telegram: couldn't send to the Bot: ${e instanceof Error ? e.message : String(e)}`);
      this.say(C.couldntSend);
    }
  }

  private paired(m: TgMessage): void {
    const from = m.from!;
    const name = [from.first_name, from.username ? `@${from.username}` : ""].filter(Boolean).join(" ").slice(0, 64) || "Telegram";
    this.d.store.write({ owner: { userId: from.id, chatId: m.chat.id, name, pairedAt: this.now() }, activeBotId: null });
    this.cancelPairing(false);
    this.dropCards();
    this.d.log("telegram: paired");
    this.say(`${C.paired}\n\n${C.help}`);
    this.d.changed();
    void this.catchUp(this.gen);
  }

  private async bots(call: Call): Promise<BotSummary[]> {
    if (this.botsCache && this.now() - this.botsCache.at < 15_000) return this.botsCache.bots;
    const r = await call("listAgents", {} as never);
    const bots = r.agents.filter((b) => !b.archived && !b.settings.hiddenFromSidebar && !b.group);
    this.botsCache = { at: this.now(), bots };
    return bots;
  }

  private async botName(botId: string): Promise<string> {
    const call = this.d.call();
    if (!call) return "Bot";
    try { return (await this.bots(call)).find((b) => b.id === botId)?.profile.name ?? "Bot"; } catch { return "Bot"; }
  }

  /** The chosen Bot; with exactly one Bot it is chosen for the owner. Otherwise asks them to pick. */
  private async currentBot(call: Call): Promise<BotSummary | null> {
    let bots: BotSummary[];
    try { bots = await this.bots(call); } catch { this.say(C.notConnected); return null; }
    const id = this.d.store.read().activeBotId;
    const cur = bots.find((b) => b.id === id);
    if (cur) return cur;
    if (bots.length === 1) { this.d.store.write({ activeBotId: bots[0]!.id }); return bots[0]!; }
    this.say(bots.length ? `${C.choose}\n\n${C.bots(bots.map((b) => b.profile.name), null)}` : C.noBots);
    return null;
  }

  private async listBots(): Promise<void> {
    const call = this.d.call();
    if (!call) { this.say(C.notConnected); return; }
    try {
      const bots = await this.bots(call);
      const cur = bots.find((b) => b.id === this.d.store.read().activeBotId)?.profile.name ?? null;
      this.say(bots.length ? C.bots(bots.map((b) => b.profile.name), cur) : C.noBots);
    } catch { this.say(C.notConnected); }
  }

  private async pickBot(name: string): Promise<void> {
    if (!name) { await this.listBots(); return; }
    const call = this.d.call();
    if (!call) { this.say(C.notConnected); return; }
    let bots: BotSummary[];
    try { bots = await this.bots(call); } catch { this.say(C.notConnected); return; }
    const q = name.toLowerCase();
    const exact = bots.filter((b) => b.profile.name.toLowerCase() === q);
    const prefix = bots.filter((b) => b.profile.name.toLowerCase().startsWith(q));
    const hit = exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : undefined;
    if (!hit) { this.say(C.notFound(clip(name, 60))); return; }
    this.d.store.write({ activeBotId: hit.id });
    this.say(C.chosen(hit.profile.name));
  }

  private async stopBot(): Promise<void> {
    const call = this.d.call();
    if (!call) { this.say(C.notConnected); return; }
    const bot = await this.currentBot(call);
    if (!bot) return;
    try { await call("interruptAgent", { id: bot.id }); this.say(C.stopped(bot.profile.name)); } catch { this.say(C.couldntSend); }
  }

  private async onPress(q: TgCallback): Promise<void> {
    const api = this.api;
    if (!api) return;
    const answer = (text?: string) => void this.enqueue((a) => a.call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }));
    const owner = this.d.store.read().owner;
    const chat = q.message?.chat;
    if (!owner || q.from?.id !== owner.userId || !chat || chat.type !== "private" || chat.id !== owner.chatId) {
      this.d.log("telegram: ignored a button press from another user");
      answer();
      return;
    }
    const m = CALLBACK.exec(q.data ?? "");
    const key = m ? this.nonces.get(m[1]!) : undefined;
    const card = key ? this.cards.get(key) : undefined;
    if (!m || !card || card.nonce !== m[1] || card.messageId !== q.message!.message_id || (m[2] === "y" && !card.approvable)) {
      this.d.log("telegram: refused an expired or unknown button");
      answer(C.expired);
      return;
    }
    const rate = this.presses.take();
    if (rate !== "ok") { answer(C.slowDown); return; }
    // Single use: the nonce is gone before the gate is asked, so a replay (or a double tap) finds nothing.
    this.nonces.delete(card.nonce);
    card.nonce = null;
    const yes = m[2] === "y";
    let status = "expired";
    try {
      if (card.ref.kind === "auto") {
        const call = this.d.call();
        if (call) status = (await call("resolveAutoReviewApproval", { id: card.botId, approvalId: card.ref.approvalId, choice: yes ? "once" : "deny" })).status;
      } else if (this.d.answerLocal) {
        // The Mac card's own path (the coordinator's gate), with the card's exact action and target: never Always/Never.
        status = (await this.d.answerLocal({ id: card.botId, askId: card.ref.askId, choice: yes ? "once" : "deny", action: card.ref.action, target: card.ref.target })).status;
      }
    } catch (e) {
      this.d.log(`telegram: the gate refused the answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    answer(C.outcome[status] ?? C.expired);
    this.settleCard(card, status);
  }

  // ---------- outgoing ----------

  /** The coordinator's forwarded transcript events (send-message entries only). */
  onEvent(ev: SseEvent): void {
    if (!this.api || ev.channel !== "transcript") return;
    const p = ev.payload;
    if (p.op !== "append" && p.op !== "update") return;
    if (p.entry.kind !== "send-message") return;
    const s = this.d.store.read();
    if (!s.owner) return;
    const entry = p.entry as SendMessageEntry;
    const msg = entry.message;
    if (msg.type === "auto-review-approval") {
      const a = msg.approval;
      void this.onCard(p.botId, `auto:${a.approvalId}`, { kind: "auto", approvalId: a.approvalId }, a.status,
        (name) => ({ head: `${name} · ${a.title}`, lines: [a.summary], exact: a.command ?? "" }));
      return;
    }
    if (msg.type === "card" && (msg.card as { kind?: string }).kind === "local-tool-permission") {
      const c = msg.card as LocalToolCardView;
      // The adoption card changes a Bot's mode on this Mac: app only.
      if (c.adopt) return;
      const title = c.action === "browser" ? (c.target.startsWith(BROWSER_PERMISSION_PREFIX) ? STRB.cardTitlePermission : STRB.cardTitle) : STR5.localCardTitle;
      void this.onCard(p.botId, `local:${c.askId}`, { kind: "local", askId: c.askId, action: c.action, target: c.target }, c.status,
        (name) => ({ head: `${name} · ${title}`, lines: c.description ? [c.description] : [], exact: c.target }));
      return;
    }
    if (p.op !== "append" || p.botId !== s.activeBotId) return;
    if (msg.type === "text") { this.sendText(msg.content); return; }
    if (msg.type === "attachment") { void this.sendAttachment(msg); return; }
    if (msg.type === "widget") this.sendText(msg.widget.question);
  }

  /**
   * One pending card as a Telegram message. The exact text (a command, a path) is shown in full, with invisible and
   * direction-changing characters made visible. When it can't be shown in full (too long, or redaction hid part of it)
   * the message says so and offers only Deny: Approve is never offered on anything the owner can't read here.
   */
  private async onCard(botId: string, key: string, ref: CardRef, status: string, build: (name: string) => { head: string; lines: string[]; exact: string }): Promise<void> {
    const known = this.cards.get(key);
    if (status !== "pending") { if (known) this.settleCard(known, status); return; }
    if (known) return;
    const nonce = randomBytes(16).toString("base64url");
    const card: Card = { key, botId, ref, nonce, messageId: null, text: "", approvable: false, outcome: null, sending: true };
    this.cards.set(key, card);
    this.nonces.set(nonce, key);
    this.trimCards();
    const b = build(await this.botName(botId));
    const lines = b.lines.map((l) => visible(l)).filter(Boolean).join("\n\n");
    const exact = visible(b.exact);
    const full = [b.head, lines, exact].filter(Boolean).join("\n\n");
    const cleaned = this.clean(full);
    let text: string;
    if (cleaned === full && full.length <= CARD_MAX) {
      text = full;
      card.approvable = true;
    } else {
      const shown = cleaned.length > CARD_MAX ? `${cleaned.slice(0, CARD_MAX)}\n${C.truncated(cleaned.length - CARD_MAX)}` : cleaned;
      text = `${shown}\n\n${cleaned === full ? "" : `${C.partHidden}\n`}${C.openInSynapse}`;
    }
    card.text = text;
    const buttons = [...(card.approvable ? [{ text: C.approve, callback_data: `a:${nonce}:y` }] : []), { text: C.deny, callback_data: `a:${nonce}:n` }];
    const keyboard: TgInlineKeyboard = { inline_keyboard: [buttons] };
    const sent = await this.enqueue((api, chatId) => api.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: card.text, reply_markup: keyboard }));
    card.sending = false;
    card.messageId = sent?.message_id ?? null;
    if (card.messageId !== null) this.remember(card.messageId);
    if (card.outcome) this.settleCard(card, card.outcome, true);
  }

  /** The card was answered (here or anywhere else): its button dies and the message shows the outcome. */
  private settleCard(card: Card, status: string, force = false): void {
    if (card.outcome && !force) return;
    card.outcome = status;
    if (card.nonce) { this.nonces.delete(card.nonce); card.nonce = null; }
    if (card.sending || card.messageId === null) return;
    const messageId = card.messageId;
    const text = `${card.text}\n\n${C.outcome[status] ?? C.expired}`;
    this.forget(messageId);
    void this.enqueue((api, chatId) => api.call("editMessageText", { chat_id: chatId, message_id: messageId, text }));
  }

  /** Card messages with live buttons, kept so a restart can take their buttons away. */
  private remember(messageId: number): void {
    const ids = this.d.store.read().cardMessages;
    this.d.store.write({ cardMessages: [...ids.filter((x) => x !== messageId), messageId].slice(-MAX_CARDS) });
  }

  private forget(messageId: number): void {
    const ids = this.d.store.read().cardMessages;
    if (ids.includes(messageId)) this.d.store.write({ cardMessages: ids.filter((x) => x !== messageId) });
  }

  /**
   * At start: the buttons on card messages from before (their nonces died with the last run) are removed, then every
   * card still pending is sent again with fresh nonces. The host may not be connected yet: it tries again for a while.
   */
  private async catchUp(gen: number, tries = 0): Promise<void> {
    if (gen !== this.gen || !this.api) return;
    const s = this.d.store.read();
    if (!s.owner) return;
    if (s.cardMessages.length) {
      this.d.store.write({ cardMessages: [] });
      for (const id of s.cardMessages) void this.enqueue((api, chatId) => api.call("editMessageReplyMarkup", { chat_id: chatId, message_id: id, reply_markup: { inline_keyboard: [] } }));
    }
    const call = this.d.call();
    let bots: BotSummary[] | null = null;
    if (call) { this.botsCache = null; bots = await this.bots(call).catch(() => null); }
    if (!call || !bots) {
      if (tries >= CATCH_UP_TRIES) return;
      this.catchUpTimer = setTimeout(() => { this.catchUpTimer = null; void this.catchUp(gen, tries + 1); }, this.d.catchUpRetryMs ?? 5_000);
      this.catchUpTimer.unref?.();
      return;
    }
    for (const b of bots.slice(0, 50)) {
      if (gen !== this.gen) return;
      const tail = await call("getAgentTranscriptTail", { id: b.id, limit: 40 }).catch(() => null);
      for (const entry of tail?.entries ?? []) {
        if (entry.kind === "send-message") this.onEvent({ channel: "transcript", payload: { botId: b.id, op: "update", entry } });
      }
    }
  }

  private trimCards(): void {
    while (this.cards.size > MAX_CARDS) {
      const [id, c] = this.cards.entries().next().value as [string, Card];
      if (c.nonce) this.nonces.delete(c.nonce);
      this.cards.delete(id);
    }
  }

  private dropCards(): void {
    this.cards.clear();
    this.nonces.clear();
  }

  private clean(text: string): string {
    return outgoing(text, [this.token]);
  }

  private say(text: string): void {
    const t = this.clean(text);
    void this.enqueue((api, chatId) => api.call("sendMessage", { chat_id: chatId, text: t }));
  }

  private sendText(content: string): void {
    for (const part of splitText(this.clean(content), TG_MAX_TEXT, undefined, C.moreInApp)) {
      void this.enqueue((api, chatId) => api.call("sendMessage", { chat_id: chatId, text: part }));
    }
  }

  private async sendAttachment(m: { url: string; name: string; size: number | null; mime: string; caption: string | null }): Promise<void> {
    const name = clip(m.name, 200);
    const caption = m.caption ? clip(this.clean(m.caption), TG_MAX_CAPTION) : undefined;
    const local = m.url.startsWith("file:///workspace/") ? decodeURIComponent(m.url.slice("file://".length)) : null;
    const call = this.d.call();
    if (local && call && /^image\/(png|jpeg|gif|webp)$/i.test(m.mime) && (m.size ?? 0) <= MAX_PHOTO_BYTES) {
      try {
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const r = await call("readWorkspaceFile", { path: local, offset, length: LIMITS.fileReadChunkBytes });
          const b = Buffer.from(r.chunkBase64, "base64");
          chunks.push(b);
          offset += b.length;
          if (offset > MAX_PHOTO_BYTES) throw new Error("too big");
          if (r.eof || b.length === 0) break;
        }
        const bytes = Buffer.concat(chunks);
        const sent = await this.enqueue((api, chatId) => api.sendPhoto(chatId, bytes, name, m.mime, caption));
        if (sent) return;
      } catch (e) {
        this.d.log(`telegram: couldn't send an image: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const link = /^https:\/\//i.test(m.url) ? `\n${m.url}` : "";
    this.sendText([name + link, caption ?? ""].filter(Boolean).join("\n"));
  }

  /**
   * One queue for everything sent to the owner's chat: a gap between messages, Telegram's retry_after honoured on
   * 429, a cap on what waits. Returns null when it couldn't be sent (logged, never with the text).
   */
  private enqueue<T>(fn: (api: TelegramApi, chatId: number) => Promise<T>): Promise<T | null> {
    if (this.queued >= MAX_QUEUE) { this.d.log("telegram: the send queue is full; dropped a message"); return Promise.resolve(null); }
    this.queued++;
    const gen = this.gen;
    const gap = this.d.sendGapMs ?? 400;
    const run = async (): Promise<T | null> => {
      try {
        for (let attempt = 0; ; attempt++) {
          const api = this.api;
          const owner = this.d.store.read().owner;
          if (!api || gen !== this.gen || !owner) return null;
          try {
            return await fn(api, owner.chatId);
          } catch (e) {
            if (e instanceof TelegramApiError && e.code === 429 && attempt < 3) {
              await new Promise((r) => setTimeout(r, Math.min(30, e.retryAfter ?? 1) * 1000));
              continue;
            }
            this.d.log(`telegram: send failed (${e instanceof TelegramApiError ? e.code : "network"})`);
            return null;
          }
        }
      } finally {
        this.queued--;
      }
    };
    const p = this.chain.then(run);
    this.chain = p.then((r) => (r === null || gap <= 0 ? undefined : new Promise<void>((res) => setTimeout(res, gap))), () => undefined);
    return p;
  }

  /** Tests: resolves once everything queued so far was sent. */
  flush(): Promise<void> { return this.chain; }
}
