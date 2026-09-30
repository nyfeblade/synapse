import type { GoogleEndpoints } from "./endpoints";
import type { GoogleAuth } from "./oauth";

/** Hard caps on what one call pulls from Google (bytes read off the wire, before any text formatting). */
export const GOOGLE_LIMITS = {
  responseMaxBytes: 2 * 1024 * 1024,
  downloadMaxBytes: 5 * 1024 * 1024,
  uploadMaxBytes: 25 * 1024 * 1024,
  readMaxChars: 40_000,
  bodyMaxChars: 20_000,
  searchMax: 25,
  listMax: 100,
  timeoutMs: 30_000,
};

export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: Buffer;
  contentType?: string;
  /** Return the body as text (exports, media) instead of parsing JSON. */
  text?: boolean;
  maxBytes?: number;
}

/** Replaces every stored token value and the client secret with [redacted]. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out.replace(/\b(ya29\.[\w.-]+|1\/\/[\w.-]{20,}|GOCSPX-[\w-]+)/g, "[redacted]");
}

async function readCapped(r: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!r.body) return { text: "", truncated: false };
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) {
      parts.push(value.subarray(0, max - n));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    parts.push(value);
    n += value.byteLength;
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated };
}

/** Google REST over fetch: Bearer from GoogleAuth (host-side only), one forced refresh on 401, capped reads. */
export class GoogleApi {
  constructor(private d: { auth: GoogleAuth; endpoints(): GoogleEndpoints; fetch?: typeof fetch; accountId?: string }) {}

  get endpoints(): GoogleEndpoints { return this.d.endpoints(); }
  /** 4.3b: the account these calls use (undefined: the first one). */
  get accountId(): string | undefined { return this.d.accountId; }
  /** 4.3b: the same API, signed in as another connected account. */
  as(accountId: string): GoogleApi { return new GoogleApi({ ...this.d, accountId }); }

  async call<T = unknown>(url: string, req: ApiRequest = {}): Promise<T> {
    const r = await this.raw(url, req);
    return r.value as T;
  }

  async raw(url: string, req: ApiRequest = {}): Promise<{ value: unknown; truncated: boolean }> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    const send = async (force: boolean) => {
      const token = await this.d.auth.accessToken(force, this.d.accountId);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      let body: string | Buffer | undefined;
      if (req.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(req.json); }
      else if (req.body) { headers["content-type"] = req.contentType ?? "application/octet-stream"; body = req.body; }
      return (this.d.fetch ?? fetch)(u, { method: req.method ?? "GET", headers, body: body as unknown as RequestInit["body"], signal: AbortSignal.timeout(GOOGLE_LIMITS.timeoutMs) });
    };
    let r = await send(false);
    if (r.status === 401) { await r.body?.cancel().catch(() => {}); r = await send(true); }
    const { text, truncated } = await readCapped(r, req.maxBytes ?? GOOGLE_LIMITS.responseMaxBytes);
    if (!r.ok) {
      let msg = text;
      try {
        const e = (JSON.parse(text) as { error?: unknown }).error;
        msg = String(typeof e === "object" && e !== null ? (e as { message?: unknown }).message : e);
      } catch { /* not JSON */ }
      throw new GoogleApiError(r.status, scrub(`Google returned ${r.status}: ${String(msg).slice(0, 300)}`, this.d.auth.secrets()));
    }
    if (req.text) return { value: text, truncated };
    if (r.status === 204 || !text) return { value: {}, truncated };
    try { return { value: JSON.parse(text) as unknown, truncated }; } catch { throw new GoogleApiError(r.status, "Google's response was too large or not JSON."); }
  }
}
