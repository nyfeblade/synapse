import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import type { BotSummary, CodingAgentView, McpServerView, PluginMarketplaceView, TranscriptEntry } from "@synapse/shared";
import { surfaceAlerts } from "./fuzz-helpers";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors, type PageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Task 34 (Phase 5 fuzz pass), Layer 2 of .claude/skills/fuzzing-the-app: the Phase 5 journeys
// (K1-K9, U1-U10, T8-T12, N10/N13/N14, B5-B7/B9, P5/P6) driven with the brief's abuse cases.
// Engine state is asserted through the gateway, not only pixels.

type Api = <T>(cmd: string, args?: unknown) => Promise<T>;
async function gatewayApi(app: ElectronApplication): Promise<Api> {
  const read = () => app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  let gw = await read();
  const deadline = Date.now() + 10_000;
  while (!gw && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); gw = await read(); }
  if (!gw) throw new Error("expected globalThis.__fuzzGateway in the FUZZ main process");
  return async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    const r = await fetch(`${gw.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${gw.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
}

interface Launched { app: ElectronApplication; win: Page; api: Api; errors: PageErrors; saveDir: string }
async function launch(tag: string, env: Record<string, string> = {}): Promise<Launched> {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), `p5fuzz-${tag}-`));
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `p5fuzz-${tag}-${Date.now()}`, E2E_SAVE_DIR: saveDir, ...env } });
  const win = await app.firstWindow();
  const errors = watchPageErrors(app, win, `p5:${tag}`, { console: true });
  await completeOnboarding(win, "Scout");
  return { app, win, api: await gatewayApi(app), errors, saveDir };
}
const botId = async (api: Api, name = "Scout") => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === name)!.id;
const tail = async (api: Api, id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id, limit: 300 })).entries;
const texts = (entries: TranscriptEntry[]) => entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));

/** Counts the FUZZ fake-OAuth "browser tabs" (loopback callbacks) and can drop the first one (the user closed the tab). */
async function watchOAuthTabs(app: ElectronApplication, o: { dropFirst: boolean }): Promise<() => Promise<number>> {
  await app.evaluate((_e, dropFirst) => {
    const g = globalThis as unknown as { fetch: typeof fetch; __oauthTabs?: number };
    const real = g.fetch;
    g.__oauthTabs = 0;
    g.fetch = ((u: string | URL | Request, init?: RequestInit) => {
      if (String(u).includes("/mcp/oauth/callback")) {
        g.__oauthTabs! += 1;
        if (dropFirst && g.__oauthTabs === 1) return Promise.reject(new Error("tab closed"));
      }
      return real(u, init);
    }) as typeof fetch;
  }, o.dropFirst);
  return () => app.evaluate(() => (globalThis as unknown as { __oauthTabs?: number }).__oauthTabs ?? 0);
}

async function openMarketplace(win: Page) {
  await win.getByRole("button", { name: "Marketplace", exact: true }).click();
  const dlg = win.getByRole("dialog", { name: "Marketplace" });
  await expect(dlg.getByRole("button", { name: "Add Linear" }).or(dlg.getByRole("button", { name: /^Linear: / }))).toBeVisible();
  return dlg;
}

test("K2/K3 speed + order: double-click Add → one registry entry and one OAuth tab; cancel the tab, then Reopen", async () => {
  const { app, win, api } = await launch("add");
  const tabs = await watchOAuthTabs(app, { dropFirst: false });
  const dlg = await openMarketplace(win);
  await dlg.getByRole("button", { name: "Add Sentry" }).dblclick();
  await expect(dlg.getByRole("button", { name: /Sentry: ✓ (Added|Connected)/ })).toBeVisible();
  await win.waitForTimeout(500);
  const sentry = (await api<{ servers: McpServerView[] }>("listMcpServers")).servers.filter((s) => s.catalogId === "curated:sentry");
  expect(sentry).toHaveLength(1);
  expect(sentry[0]!.status).toBe("connected");
  expect(await tabs()).toBe(1);

  // Order: the user closes the OAuth tab without authorizing, then clicks Reopen.
  await app.close();
  const b = await launch("oauth-cancel");
  const tabs2 = await watchOAuthTabs(b.app, { dropFirst: true });
  const dlg2 = await openMarketplace(b.win);
  await dlg2.getByRole("button", { name: "Add Linear" }).click();
  await expect(dlg2.getByText("Waiting for authorization")).toBeVisible();
  expect((await b.api<{ servers: McpServerView[] }>("listMcpServers")).servers.find((s) => s.catalogId === "curated:linear")!.status).toBe("waiting-auth");
  await dlg2.getByRole("button", { name: "Reopen" }).click();
  await expect(dlg2.getByRole("button", { name: /Linear: ✓ (Added|Connected)/ })).toBeVisible();
  await expect.poll(async () => (await b.api<{ servers: McpServerView[] }>("listMcpServers")).servers.find((s) => s.catalogId === "curated:linear")!.status).toBe("connected");
  expect(await tabs2()).toBe(2);
  await b.app.close();
});

test("K8/PLG-08 input: custom MCP server over http:// and a file:/// marketplace source are rejected with a visible error", async () => {
  const { app, win, api } = await launch("inputs");
  const dlg = await openMarketplace(win);
  await dlg.getByRole("link", { name: /Your plugins, \d+ installed/ }).click();
  await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
  await dlg.getByLabel("Name", { exact: true }).fill("Plain");
  await dlg.getByLabel("Server URL").fill("http://example.com/mcp");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  // `surfaceAlerts`, not `getByRole("alert")`: bug 46 puts the app-wide announcement on whichever
  // surface is on top, and `call()` reports this very rejection into it by default, so the plain
  // locator resolves two nodes — the Add-server form's own error and the app's — and strict mode
  // fails. This is the form's own, which is what the journey is about.
  await expect(surfaceAlerts(dlg)).toContainText("https");
  expect((await api<{ servers: McpServerView[] }>("listMcpServers")).servers.filter((s) => s.name === "Plain")).toHaveLength(0);

  await dlg.getByLabel("GitHub owner/repo or git URL").fill("file:///etc");
  await dlg.getByRole("button", { name: "Add marketplace" }).click();
  await expect(surfaceAlerts(dlg).filter({ hasText: "Use a GitHub owner/repo or an https git URL." })).toBeVisible();
  await win.waitForTimeout(300);
  expect((await api<{ marketplaces: PluginMarketplaceView[] }>("listPluginMarketplaces")).marketplaces).toHaveLength(0);
  await app.close();
});

test("TPL-01/02 speed + input: triple-click Save template → one file and one template; a .botpack with ../ paths is rejected", async () => {
  const evil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5fuzz-evil-")), "evil.botpack");
  fs.writeFileSync(evil, zipSync({ "template.json": strToU8("{}"), "../../outside.txt": strToU8("x") }));
  const { app, win, api, saveDir } = await launch("template", { E2E_OPEN_FILE: evil });
  await win.getByRole("button", { name: "Template actions" }).click();
  await win.getByRole("menuitem", { name: "Export Bot…" }).click();
  const save = win.getByRole("button", { name: "Save template" });
  await expect(save).toBeEnabled();
  await save.click({ clickCount: 3, delay: 20 });
  await expect(win.getByText(/Saved to .*scout\.botpack/)).toBeVisible();
  await win.waitForTimeout(500);
  expect(fs.readdirSync(saveDir).filter((f) => f.endsWith(".botpack"))).toEqual(["scout.botpack"]);
  const found = await api<{ bots: { id: string }[] }>("searchCatalog", { query: "Scout", limit: 20 });
  expect(found.bots.filter((e) => e.id.startsWith("tpl:"))).toHaveLength(1);
  await win.getByRole("button", { name: "Close", exact: true }).click();

  // File → Import Bot… with a hostile archive
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("native-event", { channel: "import-bot", payload: {} }));
  await expect(win.getByRole("alert").filter({ hasText: "unsafe file names" })).toBeVisible();
  expect(fs.existsSync(path.join(path.dirname(evil), "..", "outside.txt"))).toBe(false);
  expect((await api<{ agents: BotSummary[] }>("listAgents")).agents).toHaveLength(1);
  await app.close();
});

test("N13/N14 input: a 5,000-character avatar description is capped at 300; an SVG with <script> is rejected", async () => {
  const svg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5fuzz-svg-")), "evil.svg");
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>');
  const { app, win, api } = await launch("avatar");
  const id = await botId(api);
  if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
  await win.getByRole("button", { name: "Bot settings" }).click();
  await win.getByRole("button", { name: "Edit avatar" }).click();
  await win.getByRole("tab", { name: "Generate" }).click();
  const desc = win.getByRole("textbox", { name: "Describe your avatar" });
  await desc.fill("d".repeat(5000));
  expect((await desc.inputValue()).length).toBe(300);
  await win.getByRole("button", { name: "Generate" }).click();
  await expect(win.locator(".avatar-editor img, .avatar-editor svg").first()).toBeVisible();

  await win.getByRole("tab", { name: "Upload" }).click();
  await win.locator(".avatar-editor input[type=file]").setInputFiles(svg);
  await win.getByRole("button", { name: "Set avatar" }).click();
  await expect(surfaceAlerts(win.locator(".avatar-editor"))).toContainText("This SVG is not allowed: <script> is not allowed.");
  expect(await api<{ mime: string | null }>("getAgentAvatar", { id })).toMatchObject({ mime: null });
  expect(await win.evaluate(() => (window as unknown as { __xss?: boolean }).__xss ?? false)).toBe(false);
  await app.close();
});

test("LOC-04 speed + order: double-click Allow once runs exactly once; Deny then ask again gets a fresh card", async () => {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5fuzz-loc-")), "count.txt");
  const { app, win, api } = await launch("local");
  const id = await botId(api);
  const composer = win.getByRole("textbox", { name: "Message Scout" });
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  const card = win.getByRole("region", { name: "Local computer request" });

  await composer.fill(`local: echo run >> ${counter}`);
  await composer.press("Enter");
  await expect(card.last().getByRole("button", { name: "Allow once" })).toBeVisible();
  await card.last().getByRole("button", { name: "Allow once" }).dblclick();
  await expect(transcript.getByText("Done on your Mac.")).toBeVisible();
  await win.waitForTimeout(1500);
  expect(fs.readFileSync(counter, "utf8")).toBe("run\n");

  // Order: deny, then the Bot asks again → a fresh pending card, which can be allowed.
  await composer.fill(`local: echo second >> ${counter}`);
  await composer.press("Enter");
  await expect(card.last().getByRole("button", { name: "Deny once" })).toBeVisible();
  await card.last().getByRole("button", { name: "Deny once" }).click();
  await expect(card.last().getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await composer.fill(`local: echo third >> ${counter}`);
  await composer.press("Enter");
  await expect(card.last().getByRole("button", { name: "Allow once" })).toBeVisible();
  await card.last().getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => fs.readFileSync(counter, "utf8"), { timeout: 15_000 }).toBe("run\nthird\n");
  expect(texts(await tail(api, id)).filter((t) => t === "Done on your Mac.").length).toBeGreaterThanOrEqual(3);
  await app.close();
});

test("CHAT-08 order: start voice mode, then close the chat — the mic stops and voice doesn't come back on its own", async () => {
  const { app, win } = await launch("voice");
  await win.getByRole("button", { name: "Start voice chat" }).click();
  const overlay = win.getByRole("dialog", { name: "Start voice chat" });
  await expect(overlay).toBeVisible();
  await win.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await win.waitForTimeout(300);
  expect(execSync("ps -eo command", { encoding: "utf8" }).split("\n").filter((l) => l.includes("fake-dictation.sh") && l.includes(app.process().pid!.toString())).length).toBe(0);
  await win.getByRole("link", { name: /Scout/ }).first().click();
  await expect(win.getByRole("textbox", { name: "Message Scout" })).toBeVisible();
  await win.waitForTimeout(300);
  await expect(overlay).toHaveCount(0);
  await app.close();
});

/**
 * Bug 39 (6) — STALE SPEC. This journey used to end on `STR5.localUnavailable(label)` ("Your computer
 * … can't be reached — it seems to be offline."), and it reproduced red twice under no load at all, so it
 * is not one of this repo's load artefacts. What changed is the meaning of the kill.
 *
 * Commit 82927eb put the coordinator utility process under supervision (`main/coordinator-host.ts`),
 * because an unhandled rejection used to kill it and mute the whole app for the rest of its life. Main
 * now re-forks it after a 500 ms backoff and replays the connection. So a SIGKILL no longer means "the
 * Mac went away" — the Mac comes BACK, well inside the bridge's 30 s liveness window, and the LOC-06
 * idle watchdog (`local/bridge.ts` `watch()`) correctly never fires, because its precondition
 * `!available()` is never true. The journey was asserting an outcome the app is right not to produce.
 *
 * The scenario the kill DOES provoke is its own lifecycle claim, and the more dangerous one: the exec
 * was already marked delivered in the persisted policy store, so the re-forked daemon must not re-run
 * it (a shell command is not idempotent) and must not stay silent about it either — silence would hang
 * the Bot's tool call for the host's lifetime, since `run-command` is deliberately outside the bridge's
 * BOUNDED stuck-watchdog. That is what is asserted here.
 *
 * The LOC-06 watchdog claim this journey can no longer make has not been dropped: it moved DOWN to
 * `host/test/local/unavailable-watchdog.test.ts`, which drives the bridge and the real ExternalShell
 * tool with a clock it owns, and asserts the exact `STR5.localUnavailable` text. That is a stronger
 * home for it — it no longer depends on a 120 s wall-clock wait that a loaded machine can fake.
 */
test("LOC-06 lifecycle: SIGKILL the coordinator mid local command → the Bot is told, and its tool call never hangs", async () => {
  test.setTimeout(180_000);
  const { app, win, api } = await launch("loc06");
  const id = await botId(api);
  const composer = win.getByRole("textbox", { name: "Message Scout" });
  await composer.fill("local-wait: sleep 90");
  await composer.press("Enter");
  const card = win.getByRole("region", { name: "Local computer request" });
  await card.last().getByRole("button", { name: "Allow once" }).click();
  await expect(card.last().getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await win.waitForTimeout(3000); // the coordinator has picked up the exec (`sleep` is running on the Mac)
  const coord = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === "Utility" && /Coordinator/i.test(m.name ?? m.serviceName ?? "")).map((m) => m.pid));
  expect(coord).toHaveLength(1);
  process.kill(coord[0]!, "SIGKILL");
  // The whole array is polled rather than a `.find(...) ?? null`, so a failure prints what the Bot WAS
  // told instead of the word "null" — the one thing the previous 120 s timeout never revealed.
  await expect
    .poll(async () => texts(await tail(api, id)), { timeout: 60_000, intervals: [1000] })
    .toEqual(expect.arrayContaining([expect.stringContaining("This computer restarted while the request was running.")]));
  // …and it is told ONCE: `sleep 90` must not have been started a second time by the fresh daemon.
  expect(texts(await tail(api, id)).filter((t) => t.includes("This computer restarted while the request was running.")).length).toBe(1);
  await app.close();
});

test("TOOL-20 lifecycle: the coding-agent card survives the app, and the agent list is reachable through the gateway", async () => {
  // Restart-while-running is asserted at host level (host/test/phase5-fuzz-journeys.test.ts): the FUZZ
  // store is disposable per launch, so an Electron restart can't keep the agent registry.
  const { app, api } = await launch("coding");
  const id = await botId(api);
  expect((await api<{ agents: CodingAgentView[] }>("listCodingAgents", { id })).agents).toEqual([]);
  await app.close();
});

test("K1/U1 environment: 1024×680 in dark and light — the Marketplace modal and Usage table don't clip or scroll sideways", async () => {
  const { app, win } = await launch("env");
  await win.getByRole("textbox", { name: "Message Scout" }).fill("hello");
  await win.getByRole("textbox", { name: "Message Scout" }).press("Enter");
  await win.setViewportSize({ width: 1024, height: 680 });
  for (const scheme of ["dark", "light"] as const) {
    await win.emulateMedia({ colorScheme: scheme });
    const dlg = await openMarketplace(win);
    const overflow = () => win.evaluate(() => {
      const bad: string[] = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page ${document.documentElement.scrollWidth}>${innerWidth}`);
      for (const el of document.querySelectorAll<HTMLElement>(".mkt-dialog, .mkt-dialog *, .settings-dialog, .settings-dialog *")) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > innerWidth + 1 || r.left < -1) bad.push(`offscreen ${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
        const clips = ["hidden", "clip"].includes(cs.overflowX);
        if (clips && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && el.children.length <= 3 && el.innerText) bad.push(`clipped "${el.innerText.slice(0, 40)}"`);
      }
      return bad.slice(0, 10);
    });
    expect(await overflow(), `Marketplace @ ${scheme}`).toEqual([]);
    await dlg.getByRole("button", { name: "Close Marketplace" }).click();
    await win.getByRole("button", { name: "Open account menu" }).click();
    await win.getByRole("menuitem", { name: "Settings" }).click();
    await win.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Usage & Billing" }).click();
    await expect(win.getByRole("table").first()).toBeVisible();
    expect(await overflow(), `Usage & Billing @ ${scheme}`).toEqual([]);
    await win.getByRole("button", { name: "Close settings" }).click();
  }
  await app.close();
});
