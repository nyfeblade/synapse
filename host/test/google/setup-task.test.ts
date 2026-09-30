import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_CLIENT_ID_PLACEHOLDER, GOOGLE_SECRET_PLACEHOLDER, STRGS, type BrowserReply, type GoogleStatusView, type LocalExecRequest, type TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { GoogleSetupTasks, SAVE_GOOGLE_CLIENT, scrubGoogleClientSecrets } from "../../google/setup-task";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { createLocalTools } from "../../local/local-tools";
import { tmpConfig } from "../helpers";
import { SecretScanner } from "../../secrets/scanner";

// Fake Google client values are assembled at run time, so no test file holds a string GitHub push protection reads as a real secret.
const GU = "apps.google" + "usercontent.com";
const GX = "GOC" + "SPX-";

// Made-up values in Google's shapes.
const CLIENT_ID = ("123456789012-abcdefghijklmnop0123456789abcdef." + GU);
const SECRET = (GX + "Fake0nlyForTests_abcdefghijk");
const DIALOG = `Page: Clients — https://console.cloud.google.com/auth/clients?project=synapse-1\ndialog "OAuth client created"\n"Client ID" "${CLIENT_ID}"\n"Client secret" "${SECRET}"\n[e40] button "OK"`;

const computer = { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex", home: "/Users/alex" };

describe("SaveGoogleClient and the host-side capture (unit)", () => {
  let now = 1_000;
  let ws: string;
  let published: LocalExecRequest[];
  let saved: { id: string; secret: string }[];
  let prompts: { botId: string; text: string }[];
  beforeEach(() => { now = 1_000; ws = fs.mkdtempSync(path.join(os.tmpdir(), "gsetup-")); published = []; saved = []; prompts = []; });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  function rig() {
    const tasks = new GoogleSetupTasks({
      now: () => now, botName: (id) => (id === "b1" || id === "b2" ? (id === "b1" ? "Ava" : "Max") : null),
      sendPrompt: (botId, text) => { prompts.push({ botId, text }); }, setClient: (id, secret) => { saved.push({ id, secret }); }, onChange: () => {},
    });
    const bridge = new LocalBridge({ hub: { publish: (e: { payload: LocalExecRequest }) => published.push(e.payload) } as never, now: () => now, workspace: ws, idleMs: 50 });
    bridge.register(computer);
    bridge.heartbeat("mac");
    const asks = new LocalAsks({ bots: { has: () => true } as never, now: () => now });
    const browserFor = (botId: string) => createLocalTools({
      botId, slot: () => ({ turnNo: 1, nextSendK: 0, requestId: "r1", segment: 0, source: "user" }) as never, bridge, asks, now: () => now, permMode: () => "ask",
      autoReviewOn: () => true, botName: () => "Ava", lastUserMessage: () => "",
      browserFilter: { refuse: (a) => tasks.refuseBrowser(botId, a), text: (t, url, editable) => tasks.browserText(botId, t, url, editable) },
    }).find((t) => t.name === "Browser")!;
    const page = async (botId: string, text: string, url = "https://console.cloud.google.com/auth/clients?project=synapse-1", editable: string[] | null = []) => {
      const run = browserFor(botId).handler({ action: "snapshot" });
      await new Promise((r) => setTimeout(r, 0));
      const req = published[published.length - 1]!;
      const rep: BrowserReply = { text, title: "Clients", url, ...(editable ? { editable } : {}), session: "w1", steps: 1, status: "active" };
      bridge.done(req.execId, { exitCode: 0, result: JSON.stringify(rep) });
      return run;
    };
    return { tasks, browserFor, page };
  }

  it("the Bot's page shows placeholders; SaveGoogleClient stores the captured values and echoes neither", async () => {
    const { tasks, page } = rig();
    tasks.start("b1", "setup", { projectId: "synapse-1" });
    expect(prompts[0]!.text).toContain("never type a password");
    expect(prompts[0]!.text).toContain("project=synapse-1");
    const seen = await page("b1", DIALOG);
    expect(seen.text).not.toContain(SECRET);
    expect(seen.text).not.toContain(CLIENT_ID);
    expect(seen.text).toContain(GOOGLE_SECRET_PLACEHOLDER);
    expect(seen.text).toContain(GOOGLE_CLIENT_ID_PLACEHOLDER);
    expect(tasks.secrets()).toEqual([{ name: "GOOGLE_CLIENT_SECRET", value: SECRET }]);

    const tool = tasks.toolsFor("b1").find((t) => t.name === SAVE_GOOGLE_CLIENT)!;
    expect(Object.keys(tool.schema)).toEqual([]); // no input can carry a value
    const r = await tool.handler({ clientId: "ignored", clientSecret: "ignored" });
    expect(r).toEqual({ text: STRGS.saveDone });
    expect(saved).toEqual([{ id: CLIENT_ID, secret: SECRET }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(tasks.view()).toMatchObject({ botId: "b1", clientSaved: true });
  });

  it("security fix 1: captures only off the console's client pages, and only an ID and a secret from the same read", async () => {
    const { tasks, page } = rig();
    tasks.start("b1", "setup");
    // A page anywhere else, with both shapes on it: scrubbed for the Bot, but nothing is captured.
    for (const url of ["https://evil.example/auth/clients", "https://console.cloud.google.com.evil.example/auth/clients", "https://console.cloud.google.com/apis/library", "http://console.cloud.google.com/auth/clients"]) {
      const seen = await page("b1", DIALOG, url);
      expect(seen.text).not.toContain(SECRET);
    }
    expect(tasks.secrets()).toEqual([]);
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveNoClient, isError: true });
    // The ID on one read and the secret on another: not a pair.
    await page("b1", `"Client ID" "${CLIENT_ID}"`);
    await page("b1", `"Client secret" "${SECRET}"`, "https://console.cloud.google.com/apis/credentials?project=synapse-1");
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveNoClient, isError: true });
    expect(saved).toEqual([]);
    // Both on one read of a client page: captured.
    await page("b1", DIALOG, "https://console.cloud.google.com/apis/credentials/oauthclient/1?project=synapse-1");
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveDone });
    expect(saved).toEqual([{ id: CLIENT_ID, secret: SECRET }]);
  });

  it("security fix 1 + re-review: a Bot-captured client always needs a card naming the client ID only", async () => {
    const { tasks, page } = rig();
    tasks.start("b1", "setup");
    expect(tasks.cardFor("b1", true)).toBeNull(); // nothing captured yet: the tool refuses on its own
    await page("b1", DIALOG);
    // First-time save too: the user checks the ID against the console.
    expect(tasks.cardFor("b1", false)).toEqual({ clientId: CLIENT_ID, replace: false });
    expect(tasks.cardFor("b1", true)).toEqual({ clientId: CLIENT_ID, replace: true });
    expect(JSON.stringify(tasks.cardFor("b1", true))).not.toContain(SECRET);
    expect(tasks.cardFor("b2", true)).toBeNull();
  });

  it("re-review 1: a pair typed into a field on the console page is never captured; an unknown field list fails closed", async () => {
    const { tasks, page } = rig();
    tasks.start("b1", "setup");
    // The Mac reports both values as sitting in editable fields (an input the Bot typed into).
    await page("b1", DIALOG, undefined, [CLIENT_ID, SECRET]);
    expect(tasks.secrets()).toEqual([]);
    // Only the secret typed: the pair is incomplete, still nothing.
    await page("b1", DIALOG, undefined, [SECRET]);
    expect(tasks.secrets()).toEqual([]);
    // A reply with no field report (an older Mac, a failed read): no capture.
    await page("b1", DIALOG, undefined, null);
    expect(tasks.secrets()).toEqual([]);
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveNoClient, isError: true });
  });

  it("final hardening: a read with more than one client ID or secret captures nothing and says why", async () => {
    const { tasks, page } = rig();
    tasks.start("b1", "setup");
    const ID2 = ("210987654321-zyxwvutsrqponmlk0123456789abcdef." + GU);
    const SECRET2 = (GX + "Planted0nlyForTests_zyxwvutsrq");
    // The real dialog plus a client whose planted name (page text, not a field) carries a second pair.
    const seen = await page("b1", `${DIALOG}\n[e50] link "Synapse ${ID2} ${SECRET2}"`);
    expect(seen.text).toContain(STRGS.multiClient);
    expect(seen.text).not.toContain(SECRET);
    expect(seen.text).not.toContain(SECRET2);
    expect(tasks.secrets()).toEqual([]);
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.multiClient, isError: true });
    // Two IDs alone (a client list) is ambiguous too.
    await page("b1", `"Client ID" "${CLIENT_ID}"\n"${ID2}"\n"Client secret" "${SECRET}"`);
    expect(tasks.secrets()).toEqual([]);
    // The client's own page, one pair: captured.
    await page("b1", DIALOG, "https://console.cloud.google.com/auth/clients/123456789012?project=synapse-1");
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveDone });
    expect(saved).toEqual([{ id: CLIENT_ID, secret: SECRET }]);
  });

  it("with nothing captured the tool says what to open, and names no value", async () => {
    const { tasks } = rig();
    tasks.start("b1", "setup");
    expect(await tasks.toolsFor("b1")[0]!.handler({})).toEqual({ text: STRGS.saveNoClient, isError: true });
    expect(saved).toEqual([]);
  });

  it("is unavailable outside the setup task: no task, another Bot, the reconnect task, after Stop or expiry", async () => {
    const { tasks } = rig();
    expect(tasks.toolsFor("b1")).toEqual([]);
    tasks.start("b1", "reconnect");
    expect(tasks.toolsFor("b1")).toEqual([]);
    tasks.start("b1", "setup");
    expect(tasks.toolsFor("b2")).toEqual([]);
    const tool = tasks.toolsFor("b1")[0]!;
    tasks.end();
    expect(tasks.toolsFor("b1")).toEqual([]);
    // A warm session that still lists the tool gets a refusal.
    expect(await tool.handler({})).toEqual({ text: STRGS.saveNotTask, isError: true });
    tasks.start("b1", "setup");
    now += 3 * 3_600_000;
    expect(tasks.toolsFor("b1")).toEqual([]);
    expect(tasks.view()).toBeNull();
  });

  it("screenshots are refused during the task; any other Bot's pages lose the secret too (nothing captured)", async () => {
    const { tasks, browserFor, page } = rig();
    tasks.start("b1", "setup");
    expect(await browserFor("b1").handler({ action: "screenshot" })).toEqual({ text: STRGS.noScreenshots, isError: true });
    const other = await page("b2", DIALOG);
    expect(other.text).not.toContain(SECRET);
    expect(tasks.secrets()).toEqual([]);
    expect(scrubGoogleClientSecrets(`x ${SECRET} y`)).toBe(`x ${GOOGLE_SECRET_PLACEHOLDER} y`);
    // Any tool output, by shape (a downloaded client JSON read with a Mac tool): the scanner redacts it too.
    const sc = new SecretScanner([]);
    expect(sc.redact(`{"client_secret":"${SECRET}"}`)).toBe(`{"client_secret":"[secret:GOOGLE_CLIENT_SECRET]"}`);
    expect(sc.firstMatch(`send ${SECRET}`)).toBe("GOOGLE_CLIENT_SECRET");
  });
});

describe("the setup task through the host (gateway, FUZZ fake Google)", () => {
  let app: HostApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const fuzz0 = process.env.FUZZ;
  beforeAll(() => { process.env.FUZZ = "1"; });
  afterAll(() => { if (fuzz0 === undefined) delete process.env.FUZZ; else process.env.FUZZ = fuzz0; });

  it("stores the client, never writes the secret to the transcript, the mirror or the log, and ends when connected", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result as T;
    };
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { logged.push(String(c)); return true; });
    try {
      const { id } = await api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
      const { id: other } = await api<{ id: string }>("createAgent", { name: "Nova", isKickstartRequested: false });
      const p5 = app.services.phase5;
      const st = await api<GoogleStatusView>("startGoogleSetupTask", { botId: id, mode: "setup" });
      expect(st.setupTask).toMatchObject({ botId: id, botName: "Scout", mode: "setup", clientSaved: false });
      const tools = (b: string) => p5.botTools(b, () => null, []).map((t) => t.name);
      expect(tools(id)).toContain(SAVE_GOOGLE_CLIENT);
      expect(tools(other)).not.toContain(SAVE_GOOGLE_CLIENT);

      // What the Bot's Browser tool would hand it (the local module runs this same filter on every page).
      const seen = p5.google.setup.browserText(id, DIALOG, "https://console.cloud.google.com/auth/clients?project=synapse-1", []);
      expect(seen).not.toContain(SECRET);
      // From the moment it is captured, the secret scanner redacts it everywhere (transcript, mirror, memory).
      expect(app.services.phase3.scanners.redact(id, `leak ${SECRET}`)).toBe("leak [secret:GOOGLE_CLIENT_SECRET]");
      expect(app.services.phase3.scanners.redact(other, `leak ${SECRET}`)).toBe("leak [secret:GOOGLE_CLIENT_SECRET]");

      const save = p5.botTools(id, () => null, []).find((t) => t.name === SAVE_GOOGLE_CLIENT)!;
      expect(await save.handler({})).toEqual({ text: STRGS.saveDone });
      const after = await api<GoogleStatusView>("getGoogleStatus");
      expect(after).toMatchObject({ state: "disconnected", clientId: CLIENT_ID, setupTask: { clientSaved: true } });
      expect(JSON.stringify(after)).not.toContain(SECRET);

      // The user clicks Connect and Allow; the task ends with it, and the tool is gone.
      const { authorizationUrl } = await api<{ authorizationUrl: string }>("startGoogleAuth");
      await api("completeMcpOAuth", { state: new URL(authorizationUrl).searchParams.get("state")!, code: "fuzz" });
      expect((await api<GoogleStatusView>("getGoogleStatus")).setupTask).toBeNull();
      expect(tools(id)).not.toContain(SAVE_GOOGLE_CLIENT);
      // The saved secret stays a scanner value after the task.
      expect(app.services.phase3.scanners.redact(id, SECRET)).toBe("[secret:GOOGLE_CLIENT_SECRET]");

      const tail = (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
      expect(JSON.stringify(tail)).not.toContain(SECRET);
      const files = fs.readdirSync(cfg.dataRoot, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
      for (const f of files) expect(fs.readFileSync(path.join(f.parentPath, f.name), "utf8").includes(SECRET)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("")).not.toContain(SECRET);
    expect(logged.join("")).toContain("google-setup: client saved");
  });

  it("security fix 1: with Google connected, SaveGoogleClient raises a card naming the client ID, even with Auto-review off", async () => {
    app = await createHostApp(tmpConfig());
    const h = app.handlers;
    const g = app.services.phase5.google;
    const { id } = (await h.createAgent!({ name: "Scout", isKickstartRequested: false } as never)) as { id: string };
    await h.setGoogleClient!({ clientId: ("123-abc." + GU), clientSecret: (GX + "e2e-secret") } as never);
    const { authorizationUrl } = (await h.startGoogleAuth!({} as never)) as { authorizationUrl: string };
    await h.completeMcpOAuth!({ state: new URL(authorizationUrl).searchParams.get("state")!, code: "fuzz" } as never);
    expect(g.status().state).toBe("connected");
    await h.setHostSettings!({ autoReviewEnabled: false } as never);
    g.setup.start(id, "setup");
    g.setup.browserText(id, DIALOG, "https://console.cloud.google.com/auth/clients?project=synapse-1", []);
    const call = { toolName: "mcp__bot__SaveGoogleClient", input: {}, toolUseId: "tu1" };
    expect((await app.services.gate.preToolUse(id, call)).decision).toBe("ask");
    const perm = app.services.gate.canUseTool(id, call, new AbortController().signal);
    await vi.waitFor(() => expect(app!.services.gate.pending(id)).toHaveLength(1));
    const card = app.services.gate.pending(id)[0]!;
    expect(card.summary).toContain(CLIENT_ID);
    expect(JSON.stringify(card)).not.toContain(SECRET);
    app.services.gate.resolve(id, card.approvalId, "deny");
    expect(await perm).toMatchObject({ behavior: "deny" });
    // Not connected (a first setup): still a card, so the user checks the ID the Bot read against the console.
    await h.disconnectGoogle!({} as never);
    const call2 = { toolName: "mcp__bot__SaveGoogleClient", input: {}, toolUseId: "tu2" };
    expect((await app.services.gate.preToolUse(id, call2)).decision).toBe("ask");
    const perm2 = app.services.gate.canUseTool(id, call2, new AbortController().signal);
    await vi.waitFor(() => expect(app!.services.gate.pending(id)).toHaveLength(1));
    const first = app.services.gate.pending(id)[0]!;
    expect(first.summary).toContain(CLIENT_ID);
    expect(first.summary).not.toContain("Replace");
    app.services.gate.resolve(id, first.approvalId, "deny");
    await perm2;
  });

  it("refuses an unknown Bot, and Stop ends the task", async () => {
    app = await createHostApp(tmpConfig());
    const h = app.handlers;
    await expect(Promise.resolve().then(() => h.startGoogleSetupTask!({ botId: "nope", mode: "setup" } as never))).rejects.toThrow(/doesn't exist/);
    const { id } = (await h.createAgent!({ name: "Scout", isKickstartRequested: false } as never)) as { id: string };
    await h.startGoogleSetupTask!({ botId: id, mode: "reconnect" } as never);
    expect(app.services.phase5.google.status().setupTask).toMatchObject({ mode: "reconnect" });
    await h.cancelGoogleSetupTask!({} as never);
    expect(app.services.phase5.google.status().setupTask).toBeNull();
  });
});
