import { HELPER_MODEL, STR_AUTH, classifyAnthropicError, type AuthTestResult } from "@synapse/shared";

export const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * Settings → Account → "Test connection": ONE Messages request, max_tokens 1, on the cheapest model. A bad key
 * is answered 401 authentication_error before any model runs, which costs nothing; a good key costs a
 * fraction of a cent. Straight HTTPS from the host (no CLI), so the answer is exactly what Anthropic said.
 * The key is sent as x-api-key and appears in nothing this returns.
 */
export async function testAnthropicConnection(key: string, o: { baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<AuthTestResult> {
  const f = o.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await f(`${(o.baseUrl ?? ANTHROPIC_API).replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: HELPER_MODEL, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch {
    const c = classifyAnthropicError(null);
    return { ok: false, reached: false, kind: c.kind, status: null, title: c.title, detail: c.detail };
  }
  if (res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: true, reached: true, kind: "ok", status: res.status, title: STR_AUTH.ok, detail: "" };
  }
  let type: string | undefined;
  let message: string | undefined;
  try {
    const j = (await res.json()) as { error?: { type?: string; message?: string } };
    type = j.error?.type;
    message = j.error?.message;
  } catch { /* not the documented body */ }
  const ra = Number(res.headers.get("retry-after"));
  const c = classifyAnthropicError(res.status, type, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined, message);
  return { ok: false, reached: true, kind: c.kind, status: res.status, title: c.title, detail: c.detail, ...(c.retryAfterSec ? { retryAfterSec: c.retryAfterSec } : {}) };
}
