import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { STRX } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { createComposioModule, createComposioServices, runComposioToolForFake } from "../../composio/module";
import { fakeComposio } from "../../composio/fake-composio";
import { SseHub } from "../../gateway/sse-hub";
import { isReservedMcpId } from "../../mcp/reserved";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const KEY = "ak_test_Zq81xYt4Lm0pRw2vK";

function setup(o: { fetch?: FetchLike; activateAfter?: number; waitMs?: number } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const hub = new SseHub();
  const events: unknown[] = [];
  hub.subscribe((e) => events.push(e));
  const bots = new BotService({ cfg, hub, settings });
  const a = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const b = bots.create({ origin: "user", kickstart: false, name: "Pilot" });
  const fake = fakeComposio({ activateAfter: o.activateAfter ?? 2 });
  const storeKey = randomBytes(32);
  let t = 1_000;
  const ctx = { cfg, hub, bots, now: () => t };
  const make = () => createComposioServices(ctx, { fetch: o.fetch ?? fake.fetch, pollMs: 60_000, waitMs: o.waitMs ?? 600_000, storeKey });
  const c = make();
  return { cfg, c, make, fake, a, b, events, advance: (ms: number) => { t += ms; } };
}

let live: { stop(): void }[] = [];
afterEach(() => { for (const s of live) s.stop(); live = []; vi.restoreAllMocks(); });
const track = <T extends { c: { stop(): void } }>(s: T): T => { live.push(s.c); return s; };

describe("Composio key walkthrough: validation", () => {
  it("refuses an empty paste, a non-key, a rejected key and an unreachable Composio with calm errors", async () => {
    const s = track(setup());
    await expect(s.c.setKey("")).rejects.toThrow(STRX.clipboardEmpty);
    await expect(s.c.setKey("two words here")).rejects.toThrow(STRX.notAKey);
    await expect(s.c.setKey("ak_bad_key_000000")).rejects.toThrow(STRX.keyRejected);
    await expect(s.c.setKey("ak_offline_00000000")).rejects.toThrow(STRX.unreachable);
    expect(s.c.status().keySet).toBe(false);
  });

  it("a 5xx or 429 reads as Can't reach Composio; a 403 as Key rejected", async () => {
    for (const [status, msg] of [[503, STRX.unreachable], [429, STRX.unreachable], [403, STRX.keyRejected]] as const) {
      const s = track(setup({ fetch: async () => new Response("{}", { status }) }));
      await expect(s.c.setKey(KEY)).rejects.toThrow(msg);
    }
  });

  it("checks the key against Composio with the x-api-key header, then saves it sealed", async () => {
    const s = track(setup());
    const st = await s.c.setKey(`  ${KEY}\n`);
    expect(st.keySet).toBe(true);
    expect(s.fake.requests[0]).toMatchObject({ method: "GET", path: "/auth_configs?limit=1", key: KEY });
    const file = path.join(s.cfg.hostPrivate, "composio", "account.json");
    expect(fs.readFileSync(file, "utf8")).not.toContain(KEY);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    // A second instance with the same vault key reads it back (no Keychain anywhere).
    expect(s.make().status().keySet).toBe(true);
  });
});

describe("the key is never in transcripts, events or logs", () => {
  it("status views, published events and tool results never carry it, even when Composio quotes it back", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { writes.push(String(c)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { writes.push(String(c)); return true; });
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { writes.push(a.map(String).join(" ")); });
    const base = fakeComposio({ activateAfter: 1 });
    // A Composio that echoes the key in a tool result and in an error body.
    const echo: FetchLike = async (input, init) => {
      const u = String(input);
      if (u.includes("/tools/execute/GMAIL_SEND_EMAIL")) return new Response(JSON.stringify({ message: `bad request for key ${KEY}` }), { status: 400 });
      if (u.includes("/tools/execute/")) return new Response(JSON.stringify({ successful: true, data: { note: `your key is ${KEY}` }, error: null }), { status: 200 });
      return base.fetch(input, init);
    };
    const s = track(setup({ fetch: echo }));
    await s.c.setKey(KEY);
    s.c.acceptDisclosure();
    await s.c.connect("gmail");
    await s.c.poll("gmail");
    s.c.setGrant("gmail", s.a, true);
    const read = await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_FETCH_EMAILS", {});
    const send = await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { recipient_email: "friend@example.com" });
    expect(read).toContain("[redacted]");
    expect(send).toContain("[redacted]");
    const everything = [read, send, JSON.stringify(s.c.status()), JSON.stringify(s.events), ...writes].join("\n");
    expect(everything).not.toContain(KEY);
  });
});

describe("one-click Connect (stubbed Composio)", () => {
  it("asks for the data note once, then link → pending → active", async () => {
    const s = track(setup({ activateAfter: 2 }));
    await s.c.setKey(KEY);
    expect(s.c.status().disclosureAccepted).toBe(false);
    await expect(s.c.connect("gmail")).rejects.toThrow(STRX.needsDisclosure);
    s.c.acceptDisclosure();
    expect(s.make().status().disclosureAccepted).toBe(true); // remembered: shown once

    const { redirectUrl, status } = await s.c.connect("gmail");
    expect(redirectUrl).toMatch(/^https:\/\//);
    expect(status.apps.find((x) => x.toolkit === "gmail")!.state).toBe("waiting");
    // Composio-managed auth config created automatically, then the hosted link.
    const create = s.fake.requests.find((r) => r.method === "POST" && r.path === "/auth_configs");
    expect(create?.body).toEqual({ toolkit: { slug: "gmail" }, auth_config: { type: "use_composio_managed_auth" } });
    const link = s.fake.requests.find((r) => r.path === "/connected_accounts/link");
    expect(link?.body).toMatchObject({ auth_config_id: expect.stringMatching(/^ac_/), user_id: expect.stringMatching(/^synapse-[0-9a-f]{18}$/) });

    expect((await s.c.poll("gmail")).apps.find((x) => x.toolkit === "gmail")!.state).toBe("waiting");
    expect((await s.c.poll("gmail")).apps.find((x) => x.toolkit === "gmail")!.state).toBe("connected");
    // A second app reuses nothing it shouldn't; an existing auth config is reused on reconnect.
    await s.c.disconnect("gmail");
    await s.c.connect("gmail");
    expect(s.fake.requests.filter((r) => r.method === "POST" && r.path === "/auth_configs")).toHaveLength(1);
  });

  it("a failed or abandoned sign-in ends as failed, and Connect again works", async () => {
    const s = track(setup({ activateAfter: 99, waitMs: 5_000 }));
    await s.c.setKey(KEY);
    s.c.acceptDisclosure();
    await s.c.connect("slack");
    s.advance(6_000);
    const st = await s.c.poll("slack");
    expect(st.apps.find((x) => x.toolkit === "slack")).toMatchObject({ state: "failed", error: STRX.timedOut });
    await s.c.connect("slack");
    const id = String((s.fake.requests.filter((r) => r.path === "/connected_accounts/link").length));
    expect(id).toBe("2");
  });

  it("refuses without a key and for an unknown app", async () => {
    const s = track(setup());
    await expect(s.c.connect("gmail")).rejects.toThrow(STRX.needsKey);
    await s.c.setKey(KEY);
    s.c.acceptDisclosure();
    await expect(s.c.connect("../etc")).rejects.toThrow("Unknown app.");
  });
});

describe("per-Bot grants", () => {
  async function connected() {
    const s = track(setup({ activateAfter: 1 }));
    await s.c.setKey(KEY);
    s.c.acceptDisclosure();
    await s.c.connect("gmail");
    await s.c.poll("gmail");
    return s;
  }

  it("default is none: no Bot gets the server or the tools until the user allows it", async () => {
    const s = await connected();
    expect(s.c.grantedApps(s.a)).toEqual([]);
    expect(s.c.server(s.a)).toBeNull();
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_FETCH_EMAILS", {})).toBe(STRX.toolNotGranted("Gmail"));
  });

  it("a granted Bot lists and calls the tools; another Bot can't, even by name", async () => {
    const s = await connected();
    s.c.setGrant("gmail", s.a, true);
    expect(s.c.status().apps.find((x) => x.toolkit === "gmail")!.bots).toEqual([s.a]);
    const mod = createComposioModule({} as never, s.c);
    expect(Object.keys(mod.mcpServers!(s.a))).toEqual(["composio_apps"]);
    expect(mod.mcpServers!(s.b)).toEqual({});
    expect(mod.systemAppendExtra!(s.a)).toContain("Gmail");
    expect(mod.systemAppendExtra!(s.b)).toBe("");
    const tools = await s.c.listTools(s.a);
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([["GMAIL_FETCH_EMAILS", true], ["GMAIL_SEND_EMAIL", false]]);
    expect(await s.c.listTools(s.b)).toEqual([]);
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_FETCH_EMAILS", { query: "x" })).toContain("\"ok\":true");
    expect(await runComposioToolForFake(s.c, s.b, "mcp__composio_apps__GMAIL_FETCH_EMAILS", {})).toBe(STRX.toolNotGranted("Gmail"));
    const exec = s.fake.requests.find((r) => r.path.startsWith("/tools/execute/"));
    expect(exec?.body).toMatchObject({ connected_account_id: expect.stringMatching(/^ca_/), arguments: { query: "x" } });
  });

  it("revoking a grant or disconnecting the app takes effect at the next call", async () => {
    const s = await connected();
    s.c.setGrant("gmail", s.a, true);
    s.c.setGrant("gmail", s.a, false);
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_FETCH_EMAILS", {})).toBe(STRX.toolNotGranted("Gmail"));
    s.c.setGrant("gmail", s.a, true);
    await s.c.disconnect("gmail");
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_FETCH_EMAILS", {})).toBe(STRX.toolNotConnected("Gmail"));
    expect(s.c.status().apps.find((x) => x.toolkit === "gmail")!.bots).toEqual([]);
  });

  it("the built-in id is reserved, so a custom server can't stand in for it", () => {
    expect(isReservedMcpId("composio_apps")).toBe(true);
    expect(isReservedMcpId("Composio Apps")).toBe(true);
    expect(isReservedMcpId("composio")).toBe(false); // an existing custom "Composio" server keeps working
  });
});
