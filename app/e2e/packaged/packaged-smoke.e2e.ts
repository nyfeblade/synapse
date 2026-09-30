import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { bundleRoot, findPackagedApp } from "./artifact";
import { E2E_TEST_API_KEY } from "../onboarding";
import { test, watchPageErrors } from "../page-errors";

/**
 * The only test in this repo that runs the artefact a user would double-click.
 *
 * It exists because `/Applications/Synapse.app` shipped a launch that created no renderer and no
 * window, forever, behind 3373 green tests — and because the smoke check that was supposed to catch
 * it only asked "is the process still alive after 12s?". A hung process is alive. That check was
 * worse than nothing: it manufactured confidence. So the first assertion here is a WINDOW, under a
 * bounded timeout, and the run fails on the timeout rather than waiting.
 *
 * Two rules keep it honest:
 *  - It never passes `--use-mock-keychain` itself. That flag is what let the audit walk past the hang; a
 *    smoke test that quietly set it would rebuild the exact blind spot this exists to close. (Since bug-log 279
 *    the APP appends it once the profile's keychain-retired marker exists — that is the behaviour under test.)
 *  - It never sets SYNAPSE_HOST_BUNDLE. The bundle has to find its own host, from inside itself.
 */

const WINDOW_TIMEOUT_MS = 45_000;
const exe = findPackagedApp();
const bundle = bundleRoot(exe);
const profile = `pkgsmoke${process.pid}${Date.now().toString(36)}`;
const profileDir = path.join(process.env.SYNAPSE_APP_DATA ?? path.join(os.homedir(), "Library", "Application Support"), "Synapse", "profiles", profile);

let app: ElectronApplication;
let win: Page;
const mainStderr: string[] = [];
const mainStdout: string[] = [];
let botId = "";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  // Never leave a packaged app or a throwaway profile behind; `close()` can itself hang on a hung
  // main process, so it is bounded and then killed outright.
  if (app) {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
    try { app.process().kill("SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test("a window appears within a bounded timeout — the assertion that catches a headless hang", async () => {
  // FUZZ=1 forces the fake brain and the stub reviewer and strips the OAuth token (local-host.ts),
  // and APP_PROFILE is a throwaway, so this can never touch the real profile or a real Claude.
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]);
  env.FUZZ = "1";
  env.APP_PROFILE = profile;
  delete env.SYNAPSE_HOST_BUNDLE;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;

  const t0 = Date.now();
  app = await electron.launch({ executablePath: exe, env, timeout: WINDOW_TIMEOUT_MS });
  app.process().stderr?.on("data", (d: Buffer) => mainStderr.push(d.toString()));
  app.process().stdout?.on("data", (d: Buffer) => mainStdout.push(d.toString()));

  win = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  // Verified in teardown after EVERY test in this serial file, not once at the end: a serial suite
  // skips the rest of the file after a failure, so the old last-test assertion was the first thing a
  // failure threw away.
  watchPageErrors(app, win, "packaged smoke", { console: true });

  expect(await win.title()).toBeTruthy();
  await expect(win.locator("#root")).toBeVisible({ timeout: WINDOW_TIMEOUT_MS });
  expect(Date.now() - t0).toBeLessThan(WINDOW_TIMEOUT_MS);
});

test("it is the packaged bundle running, not the dev tree", async () => {
  const facts = await app.evaluate(({ app: a }) => ({
    isPackaged: a.isPackaged, appPath: a.getAppPath(), resourcesPath: process.resourcesPath, exe: a.getPath("exe"), userData: a.getPath("userData"),
  }));
  expect(facts.isPackaged).toBe(true);
  expect(facts.appPath).toBe(path.join(bundle, "Contents", "Resources", "app.asar"));
  expect(facts.exe).toBe(exe);
  expect(facts.userData).toBe(profileDir);
});

test("the bundled host launched from the bundled path", async () => {
  // __fuzzGateway is set only once resolveGateway() has a live local host, so it is the honest
  // "connected" signal — waiting for `.connection` to be detached passes instantly before it renders.
  await expect
    .poll(async () => app.evaluate(() => ((globalThis as unknown as { __fuzzGateway?: unknown }).__fuzzGateway ? "up" : "down")), { timeout: 60_000 })
    .toBe("up");
  await expect(win.locator(".connection")).toHaveCount(0);
  const mainPid = app.process().pid!;
  const children = execSync("ps -eo pid,ppid,command", { encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter((l) => l.split(/\s+/)[1] === String(mainPid));
  const host = children.find((l) => l.includes("host.mjs"));
  expect(host, `no host.mjs child of the packaged main process:\n${children.join("\n")}`).toBeTruthy();
  // Defect 2: this resolved to …/Contents/Resources/host/dist/host.mjs, which was never shipped.
  expect(host).toContain(path.join(bundle, "Contents", "Resources", "host", "dist", "host.mjs"));
  expect(process.env.SYNAPSE_HOST_BUNDLE ?? "").toBe("");
});

test("onboarding → first Bot → a message → a fake-brain reply", async () => {
  await win.getByRole("button", { name: "Add API key" }).click({ timeout: 40_000 });
  // synapse-public: the Anthropic API key is the only sign-in (a stand-in key; the fake brain never calls out).
  await win.getByLabel("Anthropic API key").fill(E2E_TEST_API_KEY);
  await win.getByRole("button", { name: "Save key" }).click();
  await expect(win.getByRole("heading", { name: "Meet Synapse" })).toBeVisible({ timeout: 40_000 });
  for (let i = 0; i < 4; i++) await win.getByRole("button", { name: "Next" }).click();
  await win.getByLabel("Name").fill("Smoke");
  await win.getByRole("button", { name: "Get started" }).click();
  await expect(win.getByRole("link", { name: /Smoke/ }).first()).toBeVisible({ timeout: 40_000 });

  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  const composer = win.getByPlaceholder("Message Smoke");
  await composer.fill("hello from the packaged smoke test");
  await composer.press("Enter");
  await expect(transcript).toContainText("hello from the packaged smoke test", { timeout: 20_000 });
  // The fake brain always answers; an empty transcript here means the host never round-tripped.
  await expect
    .poll(async () => (await transcript.innerText()).length, { timeout: 40_000 })
    .toBeGreaterThan("hello from the packaged smoke test".length + 10);

  const reply = await win.evaluate(() => (window as never as { synapse: { call(c: string, a: unknown): Promise<unknown> } }).synapse.call("listAgents", {}));
  const r = reply as { agents?: { id: string }[]; result?: { agents?: { id: string }[] } };
  botId = String(r.result?.agents?.[0]?.id ?? r.agents?.[0]?.id ?? "");
  expect(botId, `listAgents answered ${JSON.stringify(reply).slice(0, 300)}`).not.toBe("");
});

test("secrets.save() returns a valueHash — the libsodium-inside-asar canary", async () => {
  // secret-sync.ts require()s libsodium-wrappers at runtime, so esbuild never inlines it and the
  // package has to physically ship inside app.asar. It once did not, and only a packaged run says so.
  // This also exercises the profile's key file: it seals the vault entry and the HMAC key (bug-log 279).
  const status = await win.evaluate(
    (id) => (window as never as { synapse: { secrets: { save(a: string, b: string, c: string, d: string): Promise<unknown> } } }).synapse
      .secrets.save(id, "SMOKE_KEY", "packaged smoke", "value-for-the-smoke-test"),
    botId,
  );
  const entry = (status as { name: string; valueHash?: string }[]).find((e) => e.name === "SMOKE_KEY");
  expect(entry, `setBotSecrets returned ${JSON.stringify(status)}`).toBeTruthy();
  expect(entry!.valueHash).toMatch(/^[0-9a-f]{64}$/);
  await win.evaluate(
    (id) => (window as never as { synapse: { secrets: { remove(a: string, b: string): Promise<unknown> } } }).synapse.secrets.remove(id, "SMOKE_KEY"),
    botId,
  );
});

test("secrets opened on the profile's key file, with no keychain involved", async () => {
  const reply = await win.evaluate(() => (window as never as { synapse: { native: { invoke(n: string, a: unknown): Promise<unknown> } } }).synapse.native.invoke("seal.get", {}));
  const st = (reply as { result?: unknown }).result ?? reply;
  // Bug-log 279: a fresh profile writes keychain-retired.json before `ready` and never asks the keychain.
  expect(st).toMatchObject({ status: "ready", relocked: false, message: null });
  expect(fs.existsSync(path.join(profileDir, "keychain-retired.json"))).toBe(true);
  expect((fs.statSync(path.join(profileDir, "keys", "seal.key")).mode & 0o777)).toBe(0o600);
});

test("native.invoke('dictation.start') yields {type:'ready'} — the app.asar.unpacked spawn canary", async () => {
  // Electron cannot spawn() an executable inside app.asar; the helper has to be unpacked next to it
  // AND still executable, or this answers nothing at all.
  const ev = win.evaluate(() => new Promise((resolve) => {
    const bots = (window as never as { synapse: { native: { on(c: string, f: (p: unknown) => void): () => void } } }).synapse;
    const off = bots.native.on("dictation", (p) => { off(); resolve(p); });
    setTimeout(() => resolve({ type: "timeout" }), 20_000);
  }));
  await win.evaluate(() => (window as never as { synapse: { native: { invoke(n: string, a: unknown): Promise<unknown> } } }).synapse.native.invoke("dictation.start", {}));
  expect(await ev).toMatchObject({ type: "ready" });
});

test("the main process logged nothing broken", async () => {
  const stderr = mainStderr.join("");
  for (const bad of ["Cannot find module", "ENOENT", "EACCES"]) {
    expect(stderr, `main stderr contained ${bad}:\n${stderr.slice(0, 4000)}`).not.toContain(bad);
  }
  expect(mainStdout.join("")).not.toContain("SYNAPSE_KEYCHAIN_PROBE_RESULT");
});
