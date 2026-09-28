import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { completeOnboarding } from "./onboarding";
import { step, watchPageErrors, type PageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Direct gateway/API call, bypassing the renderer, so journeys assert host state (the fuzzing skill's rule).
 *  Reads {baseUrl, token} off the FUZZ-only globalThis hook the Electron main process sets after each connect. */
export type Api = <T>(cmd: string, args?: unknown) => Promise<T>;
export function gatewayApi(app: ElectronApplication): Api {
  const read = () => app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  return async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    let gw = await read();
    const deadline = Date.now() + 5000;
    while (!gw && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); gw = await read(); }
    if (!gw) throw new Error("expected the FUZZ local host's {baseUrl, token} on globalThis.__fuzzGateway after connect");
    // Read on every call: a reconnect after a host restart changes the port and token.
    const r = await fetch(`${gw.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${gw.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
}

/** Launch the app on a throwaway FUZZ profile.
 *
 *  It no longer returns an `errors` array. It used to, and four Phase 1 journeys plus the a11y sweep
 *  took it and never looked at it (bug 14). The window is registered with the page-error guard
 *  instead, which returns its verdict in fixture teardown — so a journey cannot opt out by
 *  forgetting, and a journey that dies early still reports the error that killed it. A journey that
 *  provokes an error on purpose says so with `.expect(pattern, why)` on the handle returned here. */
export async function launch(profile: string, opts: { onboard?: boolean } = {}): Promise<{ app: ElectronApplication; win: Page; api: Api; errors: PageErrors }> {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: profile } });
  const win = await app.firstWindow();
  const errors = watchPageErrors(app, win, `launch(${profile})`);
  await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  // Phase 5: a fresh FUZZ profile opens on onboarding; walk it so journeys start from the main window.
  if (opts.onboard !== false) await completeOnboarding(win);
  return { app, win, api: gatewayApi(app), errors };
}

/** Wrapped in `step()` so a renderer error raised while a Bot is being created names THAT, rather
 *  than naming the sixty-step journey it happened somewhere inside. */
export async function createBot(win: Page, name: string): Promise<void> {
  await step(`create the Bot "${name}"`, async () => {
    await win.getByRole("button", { name: "New chat", exact: true }).click();
    await win.getByLabel("To:").fill(name);
    await win.getByRole("option", { name: `Create "${name}" Bot` }).click();
    const transcript = win.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript.getByText("Hi! Tell me what you'd like help with")).toBeVisible({ timeout: 10_000 });
  });
}

/**
 * The alerts a SURFACE itself owns.
 *
 * Bug 46 moved the app-wide announcement — `actionError`, the box lifecycle banner — ONTO whichever
 * surface is on top, so that a failed action is not announced behind the cover that is correlated
 * with it failing. A consequence: `surface.getByRole("alert")` now resolves two different claims at
 * once, the surface's own error and the app-wide one passing through. Every app-wide announcement
 * carries `data-announcement` (announcer-outlets.test.tsx fails if a future one forgets), so this is
 * the surface's own and `announcement()` below is the app's.
 */
export const surfaceAlerts = (scope: Page | Locator) => scope.locator('[role="alert"]:not([data-announcement])');

/** The app-wide announcement, wherever bug 46's outlet has currently put it. */
export const announcement = (win: Page) => win.locator("[data-announcement]");

/**
 * A Bot's row in the sidebar, matched from the START of its accessible name.
 *
 * THE ANCHOR IS THE POINT. It is the only thing separating "Planner" from the group row
 * "Planner, Scout & Ledger", whose own status line can contain "Planner:" — so a merely
 * whole-word match resolves to two rows in Phase 4 and clicks the wrong one.
 *
 * Bug 39 (5) is why the anchor could not be used: commit 0bcbb93 put the blocked/unread/working
 * marker's `aria-label` AHEAD of the Bot's name in a row's accessible name ("Needs attention
 * Scout …"), so `{ name: /^Scout/ }` stopped resolving at exactly the moment a journey provoked the
 * state it was about — Phase 3's computer journey timed out at 30 s the instant Scout's box-help
 * card went pending — and the workaround was an unanchored whole-word match. Bug 43 moved the
 * marker to the END of the row, so the name now begins with the Bot's name in every marker state
 * and the anchor is safe. `(?![\w,])` keeps "Planner" off "Planner, Scout & Ledger" and off a
 * longer Bot name that merely starts with it.
 */
export const sidebarRow = (win: Page, name: string) =>
  win.getByRole("navigation", { name: "Bots" }).getByRole("link", { name: new RegExp(`^${name}(?![\\w,])`) }).first();

/** SIGKILL this app's own FUZZ local host: the `host.mjs serve` child of this Electron main process only, so a
 *  sibling app (another spec, another worktree's fuzz run) is never touched. */
export function killLocalHost(app: ElectronApplication): void {
  const mainPid = app.process().pid;
  const rows = execSync("ps -eo pid,ppid,command", { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/));
  const host = rows.find((c) => c[1] === String(mainPid) && c.slice(2).join(" ").includes("host.mjs serve"));
  if (!host) throw new Error(`no FUZZ local host child of Electron main ${mainPid}`);
  execSync(`kill -9 ${host[0]}`);
}

/** Kill the local host, wait for the Reconnecting/Unreachable screen, press Retry and wait until connected again. */
export async function restartLocalHost(app: ElectronApplication, win: Page): Promise<void> {
  await step("kill the local host and Retry back to connected", async () => {
    killLocalHost(app);
    await expect(win.locator(".connection")).toBeVisible({ timeout: 20_000 });
    await win.waitForFunction(() => (document.querySelector(".connection")?.textContent ?? "").includes("Reach"), { timeout: 30_000 });
    await win.getByRole("button", { name: "Retry" }).click();
    await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 });
  });
}

export const noHorizontalOverflow = (win: Page) => win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Phase 2's private-skills manager, reached from Phase 5's Marketplace: Your plugins → Private skills → Edit private skills. */
export async function openPrivateSkills(win: Page): Promise<void> {
  await step("open Marketplace → Your plugins → Private skills", async () => {
    await win.getByRole("button", { name: "Marketplace", exact: true }).click();
    await win.getByRole("link", { name: /^Your plugins/ }).click();
    await win.getByRole("tab", { name: "Private skills" }).click();
    await win.getByRole("button", { name: "Edit private skills" }).click();
  });
}
