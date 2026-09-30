/**
 * Wave 4.1: the few Telegram Bot API calls the bridge makes, over plain HTTPS to api.telegram.org (tests point
 * `base` at a fake server). Nothing here ever puts the token in an error message or a log line.
 */

export interface TgUser { id: number; is_bot?: boolean; first_name?: string; username?: string }
export interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel" | string }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_date?: number;
  via_bot?: unknown;
  is_automatic_forward?: boolean;
}
export interface TgCallback { id: string; from: TgUser; message?: { message_id: number; chat: TgChat }; data?: string }
export interface TgMemberUpdate { chat: TgChat; from: TgUser; new_chat_member?: { status?: string } }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; my_chat_member?: TgMemberUpdate }
export interface TgInlineKeyboard { inline_keyboard: { text: string; callback_data: string }[][] }

/** A Bot API answer that wasn't ok (or no answer). `code` 0 = the network. */
export class TelegramApiError extends Error {
  constructor(readonly code: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export interface TelegramApiOpts { base?: string; fetch?: typeof fetch }

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export class TelegramApi {
  private f: typeof fetch;
  private base: string;
  constructor(private token: string, o: TelegramApiOpts = {}) {
    this.f = o.fetch ?? fetch;
    this.base = (o.base ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
  }

  private async send<T>(method: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}/bot${this.token}/${method}`, init);
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new TelegramApiError(0, "network");
    }
    const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
    if (j?.ok === true) return j.result as T;
    const code = typeof j?.error_code === "number" ? j.error_code : res.status;
    // The description is Telegram's own words (never the token); kept short for the log.
    throw new TelegramApiError(code, String(j?.description ?? `HTTP ${res.status}`).slice(0, 200), j?.parameters?.retry_after);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return this.send<T>(method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), ...(signal ? { signal } : {}) });
  }

  sendPhoto(chatId: number, bytes: Buffer, name: string, mime: string, caption?: string): Promise<{ message_id: number }> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("photo", new Blob([new Uint8Array(bytes)], { type: mime }), name);
    return this.send("sendPhoto", { method: "POST", body: form });
  }
}
