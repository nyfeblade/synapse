import { OAUTH_REDIRECT } from "../mcp/oauth";
import type { RemoteConnection, Connector } from "../mcp/proxy";
import type { ChildFactory } from "../coding/coding-agents";
import type { DreamLlm } from "../memory/dreaming/dreamer";
import { AsyncQueue } from "../util/async-queue";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

/** FUZZ/E2E: every curated remote server is "needs-auth" until the fake OAuth completes, then serves three demo tools. */
export const fakeConnector: Connector = async (s) => {
  const authorized = !!(globalThis as { __fakeAuthorized?: Set<string> }).__fakeAuthorized?.has(s.id);
  if (!authorized) throw new Error("401 Unauthorized");
  const conn: RemoteConnection = {
    listTools: async () => ["list_items", "create_item", "delete_item"].map((name) => ({ name, description: `${name} (demo)`, inputSchema: { type: "object" as const, properties: {} } })),
    callTool: async (name) => ({ content: [{ type: "text", text: `${s.name} ${name}: ok (demo)` }] }),
    close: async () => {},
  };
  return conn;
};

export async function fakeAuth(p: OAuthClientProvider, o: { serverUrl: string | URL; authorizationCode?: string }): Promise<"AUTHORIZED" | "REDIRECT"> {
  if (!o.authorizationCode) {
    await p.saveCodeVerifier("fuzz-verifier");
    await p.redirectToAuthorization(new URL(`https://example.com/authorize?redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&state=${await p.state!()}`));
    return "REDIRECT";
  }
  await p.saveTokens({ access_token: "fuzz-token", token_type: "bearer" });
  const g = globalThis as { __fakeAuthorized?: Set<string> };
  g.__fakeAuthorized ??= new Set();
  g.__fakeAuthorized.add(String((p as { serverId?: string }).serverId));
  return "AUTHORIZED";
}

export const fakeCodingChild: ChildFactory = () => {
  const q = new AsyncQueue<{ type: string; [k: string]: unknown }>();
  const t = setTimeout(() => {
    if (q.isClosed) return;
    q.push({ type: "assistant", message: { content: [{ type: "text", text: "Working (demo)." }] } });
    q.push({ type: "result", subtype: "success", result: "Done (demo). No pull request in FUZZ mode." });
  }, 50);
  return { push: () => {}, interrupt: async () => {}, close: () => { clearTimeout(t); q.end(); }, messages: q };
};

export class StubDreamLlm implements DreamLlm {
  async synthesize(): Promise<unknown> { return { changes: [] }; }
  async verify(): Promise<unknown> { return { approved: true }; }
}
