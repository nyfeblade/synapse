/**
 * The key user journeys (battle plan 5.9), scripted against the real Electron app in FUZZ mode: the fake brain and
 * stub reviewer (never real Claude), an isolated app-data folder and a temp HOME. FUZZ has no model, so what is
 * measured is the app's OWN latency: renderer, main process, IPC and the local host.
 */
import fs from "node:fs";
import path from "node:path";
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from "@playwright/test";
import { longTasksSinceLoad, step, threadTimeMs, type Sample } from "./measure.ts";
export { JOURNEYS } from "./budgets.ts";

const APP_DIR = path.resolve(import.meta.dirname, "..", "..", "app");
/** A stand-in key: key-shaped, never valid, never sent anywhere (the fake brain). Same as app/e2e/onboarding.ts. */
const FAKE_KEY = "sk-ant-api03-" + "e2eFakeKeyNeverValid".repeat(3);
export const FIRST_BOT = "Onboarded";
export const SECOND_BOT = "Scout";
/** A Bot whose chat is preloaded with LONG_TURNS demo turns: the long-chat journeys run on it. */
export const LONG_BOT = "Archive";
export const LONG_TURNS = 100;


export interface Launched { app: ElectronApplication; win: Page; cdp: CDPSession; errors: string[] }

/** Launch the FUZZ app on `dataDir` with `home` as HOME. Audio is muted: a call journey never makes a sound. */
export async function launch(dataDir: string, home: string): Promise<Launched & { launchMs: number }> {
  // The app's own temp files (an updater stage folder per launch, among others) land inside the run's temp root and
  // go with it, instead of piling up in the real temp folder.
  const tmpdir = path.join(path.dirname(home), "tmp");
  fs.mkdirSync(tmpdir, { recursive: true });
  const t0 = performance.now();
  const app = await electron.launch({
    args: [APP_DIR, "--mute-audio"],
    // The FUZZ host's store lives beside the app data and outlives the app (SYNAPSE_FUZZ_HOST_ROOT), so a relaunch
    // finds its Bots and finished onboarding: a returning user's cold start, not a first run.
    env: { ...process.env, FUZZ: "1", APP_PROFILE: "journeys", SYNAPSE_APP_DATA: dataDir, SYNAPSE_FUZZ_HOST_ROOT: path.join(dataDir, "fuzz-host"), HOME: home, TMPDIR: tmpdir },
  });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(e.message));
  const cdp = await win.context().newCDPSession(win);
  await cdp.send("Performance.enable");
  return { app, win, cdp, errors, launchMs: performance.now() - t0 };
}

const composer = (win: Page, bot: string) => win.getByPlaceholder(`Message ${bot}`, { exact: true });
const TRANSCRIPT = '[role="log"][aria-label="Conversation transcript"]';
/** The main window is ready: connected, a Bot open, its composer on screen. */
const readySel = (bot: string) => `textarea[placeholder="Message ${bot}"]`;

async function waitReady(win: Page, bot: string): Promise<void> {
  await win.locator(readySel(bot)).first().waitFor({ state: "visible", timeout: 60_000 });
  await win.locator(".connection").waitFor({ state: "detached", timeout: 60_000 });
}

/** Onboarding with a stand-in key and a first Bot (as app/e2e/onboarding.ts does). */
async function walkOnboarding(win: Page): Promise<void> {
  await win.getByRole("button", { name: "Add API key" }).click({ timeout: 60_000 });
  await win.getByLabel("Anthropic API key").fill(FAKE_KEY);
  await win.getByRole("button", { name: "Save key" }).click();
  await win.getByRole("heading", { name: "Meet Synapse" }).waitFor();
  for (let i = 0; i < 4; i++) await win.getByRole("button", { name: "Next" }).click();
  await win.getByLabel("Name").fill(FIRST_BOT);
  await win.getByRole("button", { name: "Get started" }).click();
}

const ms = (x: number) => Math.round(x * 10) / 10;

/**
 * first-launch: a brand-new profile. Launch, walk onboarding, send the first message, see the first reply. The
 * whole path is timed from the launch call (it includes the scripted clicks, a constant). CPU is the renderer's.
 * Leaves the profile onboarded for cold-start and the session journeys.
 */
export async function firstLaunch(dataDir: string, home: string): Promise<Sample> {
  const t0 = performance.now();
  const l = await launch(dataDir, home);
  try {
    await walkOnboarding(l.win);
    await waitReady(l.win, FIRST_BOT);
    const box = composer(l.win, FIRST_BOT);
    await box.fill("hello");
    await box.press("Enter");
    await l.win.locator(TRANSCRIPT).getByText("On it.").first().waitFor({ timeout: 30_000 });
    const wallMs = performance.now() - t0;
    const lt = await longTasksSinceLoad(l.win);
    // Let the demo turn finish so the profile is quiet for the next launch.
    await l.win.locator(TRANSCRIPT).getByText("Done: ls -la /workspace").first().waitFor({ timeout: 30_000 });
    return { wallMs: ms(wallMs), cpuMs: ms(await threadTimeMs(l.cdp)), longTasks: lt.longTasks, longTaskMs: ms(lt.longTaskMs) };
  } finally {
    await l.app.close();
  }
}

/** cold-start: an onboarded profile. Launch to the Bot's composer on screen and connected to the local host. */
export async function coldStart(dataDir: string, home: string): Promise<Sample> {
  const t0 = performance.now();
  const l = await launch(dataDir, home);
  try {
    await waitReady(l.win, FIRST_BOT);
    const wallMs = performance.now() - t0;
    const lt = await longTasksSinceLoad(l.win);
    return { wallMs: ms(wallMs), cpuMs: ms(await threadTimeMs(l.cdp)), longTasks: lt.longTasks, longTaskMs: ms(lt.longTaskMs) };
  } finally {
    await l.app.close();
  }
}

/** A running app with two Bots, for the click-level journeys. */
export async function openSession(dataDir: string, home: string, opts: { longChat?: boolean } = {}): Promise<Launched> {
  const l = await launch(dataDir, home);
  await waitReady(l.win, FIRST_BOT);
  const gw = await l.app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  if (!gw) throw new Error("the FUZZ app exposes no local host on globalThis.__fuzzGateway");
  const list = await gwCall<{ agents?: { profile: { name: string } }[] } | { profile: { name: string } }[]>(gw, "listAgents", {}).catch(() => null);
  const names = (Array.isArray(list) ? list : list?.agents ?? []).map((a) => a.profile.name);
  if (!names.includes(SECOND_BOT)) await gwCall(gw, "createAgent", { name: SECOND_BOT });
  await l.win.getByRole("navigation", { name: "Bots" }).getByRole("link", { name: new RegExp(`^${SECOND_BOT}(?![\\w,])`) }).first().waitFor({ timeout: 30_000 });
  if (opts.longChat && !names.includes(LONG_BOT)) await preloadLongChat(gw);
  return l;
}

/**
 * A long chat, built through the host exactly as a user would: LONG_TURNS demo turns (message, "On it.", a
 * command, "Done: …"), each waited out before the next is sent. The app loads its last 300 entries on open.
 */
async function preloadLongChat(gw: { baseUrl: string; token: string }): Promise<void> {
  const created = await gwCall<{ agent?: { id: string }; id?: string }>(gw, "createAgent", { name: LONG_BOT });
  const id = created.agent?.id ?? created.id;
  if (!id) throw new Error("createAgent returned no id");
  const lastDone = async () => {
    const { entries } = await gwCall<{ entries: { kind: string; content?: string; input?: { content?: string } }[] }>(gw, "getAgentTranscriptTail", { id, limit: 6 });
    return JSON.stringify(entries);
  };
  for (let i = 0; i < LONG_TURNS; i++) {
    await gwCall(gw, "sendPrompt", { id, text: `turn ${i}: here is a line of **markdown** with \`code\` and a [link](https://example.com)`, clientNonce: `long-${i}-${Date.now()}` });
    const deadline = Date.now() + 30_000;
    while (!(await lastDone()).includes(`Done: ls -la /workspace`) || !(await lastDone()).includes(`turn ${i}:`)) {
      if (Date.now() > deadline) throw new Error(`long chat: turn ${i} never finished`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function gwCall<T>(gw: { baseUrl: string; token: string }, cmd: string, args: unknown): Promise<T> {
  const r = await fetch(`${gw.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${gw.token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const j = (await r.json()) as { ok: boolean; result?: T; error?: { message: string } };
  if (!j.ok) throw new Error(`${cmd}: ${j.error?.message}`);
  return j.result as T;
}

/** In-page: after the last child of `sel` containing `anchor`, a child contains `text`. */
const followsIn = ({ sel, anchor, text }: { sel: string; anchor: string; text: string }) => {
  const kids = [...(document.querySelector(sel)?.children ?? [])];
  let at = -1;
  for (let i = kids.length - 1; i >= 0; i--) if ((kids[i]!.textContent ?? "").includes(anchor)) { at = i; break; }
  return at >= 0 && kids.slice(at + 1).some((k) => (k.textContent ?? "").includes(text));
};
const sidebarRow = (win: Page, name: string) => win.getByRole("navigation", { name: "Bots" }).getByRole("link", { name: new RegExp(`^${name}(?![\\w,])`) }).first();
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const SEARCH = '[role="dialog"][aria-label="Search"]';

/** Close whatever overlay is up and wait until it is gone. */
async function escape(win: Page, sel: string): Promise<void> {
  for (let i = 0; i < 3 && (await win.locator(sel).count()) > 0; i++) {
    await win.keyboard.press("Escape");
    await win.locator(sel).first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  }
}

/** Go to a Bot's chat (unmeasured setup). */
async function openBot(win: Page, bot: string): Promise<void> {
  if (await win.locator(readySel(bot)).isVisible()) return;
  await sidebarRow(win, bot).click();
  await win.locator(readySel(bot)).first().waitFor({ state: "visible" });
  // Let the switch's own work (the chat's entrance, avatars settling) finish, so the next step's CPU is its own.
  await win.waitForTimeout(500);
}

/** One run of a session journey. `round` varies the input so every run is a real change. */
export async function sessionJourney(id: string, l: Launched, round: number): Promise<Sample> {
  const { win, cdp } = l;
  switch (id) {
    case "first-reply":
    case "long-reply": {
      const bot = id === "long-reply" ? LONG_BOT : FIRST_BOT;
      await openBot(win, bot);
      const text = `hello ${round} ${Date.now()}`;
      const box = composer(win, bot);
      await box.fill(text);
      const s = await step(win, cdp, () => box.press("Enter"), { follows: { sel: TRANSCRIPT, anchor: text, text: "On it." } });
      // Let the demo turn finish (unmeasured) so the next journey starts from a quiet Bot.
      await win.waitForFunction(followsIn, { sel: TRANSCRIPT, anchor: text, text: "Done: ls -la /workspace" }, { timeout: 30_000 });
      return s;
    }
    case "switch-bot": {
      const [from, to] = round % 2 === 0 ? [FIRST_BOT, SECOND_BOT] : [SECOND_BOT, FIRST_BOT];
      await openBot(win, from);
      const row = sidebarRow(win, to);
      await row.waitFor();
      return step(win, cdp, () => row.click(), { visible: readySel(to) });
    }
    case "open-settings": {
      await openBot(win, FIRST_BOT);
      const s = await step(win, cdp, () => win.keyboard.press("Meta+Comma"), { visible: SETTINGS });
      await escape(win, SETTINGS);
      return s;
    }
    case "search": {
      await openBot(win, FIRST_BOT);
      const s = await step(win, cdp, () => win.keyboard.press("Meta+k"), { visible: `${SEARCH} input` });
      await escape(win, SEARCH);
      return s;
    }
    case "search-query": {
      await openBot(win, FIRST_BOT);
      await win.keyboard.press("Meta+k");
      const input = win.locator(`${SEARCH} input`);
      await input.waitFor();
      // The first message every profile has: "hello" (first-launch). Results are the palette's options.
      // A message hit (its snippet quotes the match) exists only once the typed search has answered.
      const s = await step(win, cdp, () => input.fill("hello"), { count: { sel: `${SEARCH} [role="option"] .palette-sub`, text: "hello", min: 1 } });
      await escape(win, SEARCH);
      return s;
    }
    case "approve-card":
    case "long-approve": {
      const bot = id === "long-approve" ? LONG_BOT : FIRST_BOT;
      await openBot(win, bot);
      const cmd = `rm -rf /workspace/tmp/j${round}-${Date.now()}`;
      const box = composer(win, bot);
      await box.fill(`please run: ${cmd}`);
      await box.press("Enter");
      const allow = win.getByRole("region", { name: "Approval needed" }).getByRole("button", { name: "Allow once" });
      await allow.waitFor({ timeout: 30_000 });
      // The card's entrance (spring + the turn's live step) settles first, so the step times the approval, not it.
      await win.waitForTimeout(800);
      const s = await step(win, cdp, () => allow.click(), { follows: { sel: TRANSCRIPT, anchor: `please run: ${cmd}`, match: 'section[aria-label="Approved action"]' } });
      await win.waitForFunction(followsIn, { sel: TRANSCRIPT, anchor: `please run: ${cmd}`, text: `Done: ${cmd}` }, { timeout: 30_000 });
      return s;
    }
    case "activity":
    case "usage": {
      await openBot(win, FIRST_BOT);
      await win.keyboard.press("Meta+Comma");
      await win.locator(SETTINGS).waitFor();
      const btn = win.locator(SETTINGS).getByRole("button", { name: id === "activity" ? "Activity" : "Usage", exact: true });
      const s = await step(win, cdp, () => btn.click(), { visible: id === "activity" ? `${SETTINGS} [data-setting="activity"]` : `${SETTINGS} .usage-card` });
      await escape(win, SETTINGS);
      return s;
    }
    case "call-ui": {
      await openBot(win, FIRST_BOT);
      const btn = win.getByRole("button", { name: "Start a voice call" }).first();
      const s = await step(win, cdp, () => btn.click(), { visible: ".voice-overlay" });
      await win.getByRole("button", { name: "Close voice chat" }).click();
      await win.locator(".voice-overlay").waitFor({ state: "detached", timeout: 10_000 });
      return s;
    }
    case "model-picker": {
      await openBot(win, FIRST_BOT);
      const pill = win.locator("button.composer-pill").first();
      const s = await step(win, cdp, () => pill.click(), { visible: '[role="menu"][aria-label="Model"]' });
      await escape(win, '[role="menu"][aria-label="Model"]');
      return s;
    }
    default:
      throw new Error(`unknown journey ${id}`);
  }
}

/** Copy an onboarded profile so each cold start begins from the same state. */
export function cloneDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}
