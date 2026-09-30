import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { STRX, isComposioLink } from "@synapse/shared";

/**
 * Composio's REST API (v3.1, https://docs.composio.dev/reference). The host calls it directly with the user's OWN
 * project API key in the `x-api-key` header; there is no Synapse server in between. Every request goes through the
 * fetch it is given, which in production is the host's guarded fetch (net/guarded-fetch.ts, bugs 362-368), so a
 * redirect or a DNS answer can never send it to the Mac or the LAN.
 */
export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

export type ComposioErrorKind = "rejected" | "unreachable" | "api";

export class ComposioError extends Error {
  constructor(public readonly kind: ComposioErrorKind, message: string, public readonly status = 0) { super(message); }
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Connected-account statuses Composio documents (INITIALIZING, INITIATED, ACTIVE, …) folded to three. */
export type AccountPhase = "pending" | "active" | "failed";
export function accountPhase(status: unknown): AccountPhase {
  const s = String(status ?? "").toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "INITIALIZING" || s === "INITIATED" || s === "PENDING" || s === "") return "pending";
  return "failed"; // FAILED, EXPIRED, INACTIVE, DELETED and anything newer we don't know
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,120}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Replace the key (and anything else secret) wherever a string quotes it back. */
export function scrubKey(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const v of secrets) if (v && v.length >= 6) out = out.split(v).join("[redacted]");
  return out;
}

export class ComposioApi {
  constructor(private d: { fetch: FetchLike; key(): string | null; base?: string; timeoutMs?: number }) {}

  private get base(): string { return this.d.base ?? COMPOSIO_API_BASE; }

  private async req<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, keyOverride?: string): Promise<T> {
    const key = keyOverride ?? this.d.key();
    if (!key) throw new ComposioError("rejected", STRX.needsKey);
    let r: Response;
    try {
      r = await this.d.fetch(`${this.base}${path}`, {
        method,
        headers: { "x-api-key": key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.d.timeoutMs ?? 20_000),
      });
    } catch {
      // Never the underlying error text: an HTTP client may quote the request (and its header) back.
      throw new ComposioError("unreachable", STRX.unreachable);
    }
    if (r.status === 401 || r.status === 403) throw new ComposioError("rejected", STRX.keyRejected, r.status);
    if (r.status >= 500 || r.status === 429) throw new ComposioError("unreachable", STRX.unreachable, r.status);
    const j = (await r.json().catch(() => null)) as (T & { message?: unknown; error?: { message?: unknown } }) | null;
    if (!r.ok) {
      const msg = typeof j?.message === "string" ? j.message : typeof j?.error?.message === "string" ? j.error.message : `Composio returned ${r.status}`;
      throw new ComposioError("api", scrubKey(String(msg).slice(0, 300), [key]), r.status);
    }
    if (j === null) throw new ComposioError("api", "Composio sent an answer Synapse couldn't read.", r.status);
    return j;
  }

  /** Checks a key before it is saved: a project-scoped list that fails with 401 for a bad key. */
  async validate(key: string): Promise<void> {
    await this.req("GET", "/auth_configs?limit=1", undefined, key);
  }

  /** The toolkit's Composio-managed auth config, created on first use (no OAuth app of the user's own needed). */
  async ensureAuthConfig(toolkit: string): Promise<string> {
    if (!SLUG_RE.test(toolkit)) throw new ComposioError("api", "Unknown app.");
    const list = await this.req<{ items?: { id?: string; status?: string; is_composio_managed?: boolean; toolkit?: { slug?: string } }[] }>(
      "GET", `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=20`);
    const found = (list.items ?? []).find((i) => typeof i.id === "string" && i.is_composio_managed !== false && (i.toolkit?.slug ?? toolkit) === toolkit && String(i.status ?? "ENABLED").toUpperCase() !== "DISABLED");
    if (found?.id) return found.id;
    const made = await this.req<{ auth_config?: { id?: string } }>("POST", "/auth_configs", {
      toolkit: { slug: toolkit },
      auth_config: { type: "use_composio_managed_auth" },
    });
    if (!made.auth_config?.id) throw new ComposioError("api", "Composio didn't return an auth config.");
    return made.auth_config.id;
  }

  /** Composio's hosted sign-in link for one account of this toolkit. */
  async link(authConfigId: string, userId: string): Promise<{ redirectUrl: string; accountId: string }> {
    const j = await this.req<{ redirect_url?: string; connected_account_id?: string }>("POST", "/connected_accounts/link", { auth_config_id: authConfigId, user_id: userId });
    const redirectUrl = String(j.redirect_url ?? "");
    const accountId = String(j.connected_account_id ?? "");
    // Bug 401: only an https link on a Composio host is ever handed to the browser.
    if (!isComposioLink(redirectUrl) || !ID_RE.test(accountId)) throw new ComposioError("api", "Composio didn't return a sign-in link.");
    return { redirectUrl, accountId };
  }

  async accountStatus(accountId: string): Promise<AccountPhase> {
    if (!ID_RE.test(accountId)) throw new ComposioError("api", "Unknown account.");
    const j = await this.req<{ status?: string }>("GET", `/connected_accounts/${encodeURIComponent(accountId)}`);
    return accountPhase(j.status);
  }

  async removeAccount(accountId: string): Promise<void> {
    if (!ID_RE.test(accountId)) return;
    await this.req("DELETE", `/connected_accounts/${encodeURIComponent(accountId)}`);
  }

  /** The toolkit's tools: the featured ones first (a toolkit like GitHub has hundreds), else the first page. */
  async tools(toolkit: string): Promise<ComposioTool[]> {
    if (!SLUG_RE.test(toolkit)) return [];
    type Item = { slug?: string; name?: string; description?: string; input_parameters?: Record<string, unknown>; deprecated?: unknown };
    const q = (extra: string) => this.req<{ items?: Item[] }>("GET", `/tools?toolkit_slug=${encodeURIComponent(toolkit)}${extra}`);
    let items = (await q("&important=true&limit=100")).items ?? [];
    if (!items.length) items = (await q("&limit=60")).items ?? [];
    return items
      .filter((i): i is Item & { slug: string } => typeof i.slug === "string" && SLUG_RE.test(i.slug) && i.deprecated !== true)
      .map((i) => ({
        slug: i.slug,
        name: String(i.name ?? i.slug),
        description: String(i.description ?? "").slice(0, 1000),
        inputSchema: i.input_parameters && typeof i.input_parameters === "object" ? { type: "object", ...i.input_parameters } : { type: "object", properties: {} },
      }));
  }

  async execute(slug: string, o: { accountId: string; userId: string; args: Record<string, unknown> }): Promise<{ successful: boolean; data: unknown; error: string | null }> {
    if (!SLUG_RE.test(slug)) throw new ComposioError("api", "Unknown tool.");
    const j = await this.req<{ successful?: boolean; data?: unknown; error?: unknown }>("POST", `/tools/execute/${encodeURIComponent(slug)}`, {
      connected_account_id: o.accountId, user_id: o.userId, arguments: o.args,
    });
    return { successful: j.successful !== false && !j.error, data: j.data ?? null, error: j.error ? String(typeof j.error === "string" ? j.error : JSON.stringify(j.error)).slice(0, 1000) : null };
  }
}
