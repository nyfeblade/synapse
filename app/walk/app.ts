import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { LIMITSC } from "@synapse/shared";
import type { Gateway } from "./gateway";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WALK_PREFIX = "walk-";
const OAUTH_DEFAULT_PORT = 47823;

/**
 * Refuses to launch when the walk could damage the user's state:
 *  - a fresh profile has an EMPTY Mac secret vault, and main's SecretSync.resync() on connect turns
 *    "the Mac has nothing" into `removes` for every secret the box holds (secret-sync.ts:78). So any
 *    box-side secret on any Bot means: do not launch a second profile at all.
 *  - MAX_SCREENS: the walk Bot's ensureDisplay would reclaim an idle user Bot's screen when none is
 *    free (displays.ts indexFor → lruIdleVictim). No free seat means abort, never take one.
 */
export async function preflight(g: Gateway): Promise<{ userBots: number; seatsUsed: number }> {
  const { agents } = await g.call("listAgents", {});
  const users = agents.filter((a) => !a.profile.name.startsWith(WALK_PREFIX));
  for (const a of users) {
    const { status } = await g.call("getBotSecretsStatus", { botId: a.id });
    if (status.length) throw new Error(`walk refused: Bot "${a.profile.name}" has ${status.length} box secret(s); a fresh app profile's empty vault would resync them away`);
  }
  const { displays } = await g.call("getDisplays", {});
  if (displays.length >= LIMITSC.maxScreens) throw new Error(`walk aborted: all ${LIMITSC.maxScreens} screens are assigned (${displays.map((d) => d.botId).join(", ")}); a walk Bot would take one from the user`);
  return { userBots: users.length, seatsUsed: displays.length };
}

export interface DevApp { app: ElectronApplication; win: Page; profile: string; profileDir: string; stderr: string[] }

/** The DEV build (`electron app/`), as the e2e harness launches it, on a throwaway APP_PROFILE: its own
 *  userData dir, so its own single-instance lock — the installed Synapse.app is left alone. */
export async function launchDev(profile: string): Promise<DevApp> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FUZZ" && !k.startsWith("WALK_") && k !== "SYNAPSE_LOCAL_HOST") env[k] = v;
  env.APP_PROFILE = profile;
  const profileDir = path.join(os.homedir(), "Library", "Application Support", "Synapse", "profiles", profile);
  const app = await electron.launch({ args: [appDir], env });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  try {
    const win = await app.firstWindow({ timeout: 45_000 });
    return { app, win, profile, profileDir, stderr };
  } catch (e) {
    // Playwright's loader holds app.whenReady() until its CDP handshake runs; if that never lands the
    // app is still alive and, once released, connects to the REAL box. Never leave it running.
    await closeDev({ app, win: null as never, profile, profileDir, stderr });
    throw new Error(`${(e as Error).message.split("\n")[0]} — dev app killed; stderr tail: ${stderr.join("").slice(-800) || "(empty)"}`);
  }
}

export async function closeDev(d: DevApp | null): Promise<void> {
  if (!d) return;
  await Promise.race([d.app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8_000))]);
  try { d.app.process().kill("SIGKILL"); } catch { /* gone */ }
  fs.rmSync(d.profileDir, { recursive: true, force: true });
}

/** The dev app's coordinator tells the host its OAuth loopback port (47824 while the installed app
 *  holds 47823). Once it quits, hand the host back to whoever holds the default port. */
export async function restoreOAuthPort(g: Gateway): Promise<string> {
  let holder = "";
  try { holder = execFileSync("lsof", ["-nP", `-iTCP:${OAUTH_DEFAULT_PORT}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8" }); } catch { /* nobody */ }
  if (!holder) return "no listener on 47823; left as is";
  await g.call("setOAuthLoopbackPort", { port: OAUTH_DEFAULT_PORT });
  return `restored to ${OAUTH_DEFAULT_PORT} (${holder.split("\n").find((l) => l.startsWith("c"))?.slice(1) ?? "?"})`;
}

/** Opens a Bot in the dev window by its sidebar link. */
export async function openBot(win: Page, name: string): Promise<void> {
  const link = win.getByRole("link", { name: new RegExp(name) }).first();
  await link.waitFor({ state: "visible", timeout: 90_000 });
  await link.click();
}
