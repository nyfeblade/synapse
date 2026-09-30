import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * FUZZ/E2E and tests: an in-process stand-in for Composio's REST API, answered by a fetch function (no socket, no
 * real Composio). A key containing "bad" is rejected; "offline" can't be reached. A link's account goes
 * INITIATED → ACTIVE after `activateAfter` status reads.
 */
export interface FakeComposio {
  fetch: FetchLike;
  requests: { method: string; path: string; key: string | null; body: unknown }[];
  activate(accountId: string): void;
  fail(accountId: string): void;
}

/** 4.3b: `profileEmail` answers GMAIL_GET_PROFILE per connected account (the host labels a Gmail account by it). */
export function fakeComposio(o: { activateAfter?: number; profileEmail?: (accountId: string) => string | null } = {}): FakeComposio {
  const requests: FakeComposio["requests"] = [];
  const accounts = new Map<string, { status: string; reads: number }>();
  const configs = new Map<string, string>();
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    const key = headers.get("x-api-key");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname.replace(/^\/api\/v3\.1/, "");
    requests.push({ method, path: `${p}${url.search}`, key, body });
    if (key?.includes("offline")) throw new TypeError("fetch failed");
    if (!key || key.includes("bad")) return json(401, { message: "Invalid API key", code: 401 });
    if (method === "GET" && p === "/auth_configs") {
      const tk = url.searchParams.get("toolkit_slug");
      const id = tk ? configs.get(tk) : undefined;
      return json(200, { items: id ? [{ id, status: "ENABLED", is_composio_managed: true, toolkit: { slug: tk } }] : [] });
    }
    if (method === "POST" && p === "/auth_configs") {
      const tk = String(body?.toolkit?.slug ?? "");
      const id = `ac_${tk}${++n}`;
      configs.set(tk, id);
      return json(201, { toolkit: { slug: tk }, auth_config: { id, is_composio_managed: true } });
    }
    if (method === "POST" && p === "/connected_accounts/link") {
      const id = `ca_fake${++n}`;
      accounts.set(id, { status: "INITIATED", reads: 0 });
      return json(201, { link_token: "lt", redirect_url: `https://connect.composio.dev/link/${id}`, connected_account_id: id, expires_at: "2099-01-01T00:00:00Z" });
    }
    const acc = /^\/connected_accounts\/([^/]+)$/.exec(p);
    if (acc) {
      const a = accounts.get(decodeURIComponent(acc[1]!));
      if (!a) return json(404, { message: "Not found" });
      if (method === "DELETE") { accounts.delete(decodeURIComponent(acc[1]!)); return json(200, { success: true }); }
      a.reads++;
      if (a.status === "INITIATED" && o.activateAfter !== undefined && a.reads >= o.activateAfter) a.status = "ACTIVE";
      return json(200, { id: acc[1], status: a.status });
    }
    if (method === "GET" && p === "/tools") {
      const tk = (url.searchParams.get("toolkit_slug") ?? "").toUpperCase();
      const tool = (slug: string, description: string) => ({ slug: `${tk}_${slug}`, name: slug, description, input_parameters: { type: "object", properties: { query: { type: "string" } } } });
      return json(200, { items: tk === "GMAIL" ? [tool("FETCH_EMAILS", "Fetch emails"), tool("SEND_EMAIL", "Send an email")] : [tool("LIST_ITEMS", "List items"), tool("CREATE_ITEM", "Create an item")] });
    }
    const ex = /^\/tools\/execute\/([^/]+)$/.exec(p);
    if (method === "POST" && ex && ex[1] === "GMAIL_GET_PROFILE" && o.profileEmail) {
      const email = o.profileEmail(String(body?.connected_account_id ?? ""));
      return json(200, { successful: !!email, data: email ? { emailAddress: email } : null, error: email ? null : "no profile" });
    }
    if (method === "POST" && ex) return json(200, { successful: true, data: { ok: true, tool: ex[1], echo: body?.arguments ?? null }, error: null, log_id: "log_1" });
    return json(404, { message: "Not found" });
  };
  return {
    fetch, requests,
    activate: (id) => { const a = accounts.get(id); if (a) a.status = "ACTIVE"; },
    fail: (id) => { const a = accounts.get(id); if (a) a.status = "FAILED"; },
  };
}
