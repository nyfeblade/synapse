import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

/**
 * The one place in the main process allowed to touch Electron's safeStorage (keychain-single-entry-point.test.ts),
 * and since the keychain was retired (bug-log 279, 2026-09-26) it is used for ONE thing only: the one-time
 * migration in sealing.ts, which reads a profile's keychain-sealed secrets once and re-seals them with the
 * profile's own key file. Only index.ts imports this module, and only on a launch without the
 * `keychain-retired.json` marker; every other launch never names safeStorage and runs Chromium with
 * `use-mock-keychain`.
 *
 * The rest is what that single read still needs from the old keychain story:
 *
 *  - IDENTITY. Builds sealed their secrets into a keychain item namespaced by code identity,
 *    `Bots <cdhash12 | certificate leaf12> Safe Storage` (bug 99), so the migration launch sets the same name
 *    before `ready` to read the same item. `codeIdentity` / `safeStorageName` compute it.
 *  - BOUNDS. With no readable identity the shared, un-namespaced item can stall the main thread inside
 *    SecItemCopyMatching, so that case asks a disposable copy of this binary (`probeKeychain`, same identity and
 *    therefore the same ACL answer) under a hard timeout. A keychain that doesn't answer becomes a verdict, and the
 *    migration keeps the old files and raises the re-enter state instead of hanging.
 *  - ORDERING. The gate in sealing.ts stays closed until the window is loaded, and the migration runs inside its
 *    open(), so a keychain prompt can never stop the first frame.
 */
import type { SafeStore } from "./file-key-store";
import type { LegacyKeychain, Verdict } from "./sealing";

export type { SafeStore, Verdict };

export const PROBE_ENV = "SYNAPSE_KEYCHAIN_PROBE";
export const PROBE_MARK = "SYNAPSE_KEYCHAIN_PROBE_RESULT";
/** Long enough for a cold Electron start, short enough that a stall is over before a user gives up. */
// Long enough for someone to read the Keychain prompt and type their password: a timeout counts as a
// failed attempt (of 3) at moving the secrets out of the Keychain.
export const PROBE_TIMEOUT_MS = 60_000;
const CODESIGN = "/usr/bin/codesign";
const ROUND_TRIP = "synapse-keychain-probe";


/** The cdhash out of `codesign -d -r-`. An ad-hoc designated requirement is exactly that and nothing else. */
export function parseCdhash(text: string): string | null {
  const m = /cdhash\s+H"([0-9a-fA-F]+)"/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Bug 99: the code identity the keychain item is namespaced by. Ad hoc: the cdhash (new every
 * build). Signed with the local "Synapse Local Signing" certificate (scripts/signing-identity.mjs):
 * the certificate's leaf hash, identical for every build — so one item, one ACL, no re-prompt.
 */
export function parseCodeIdentity(text: string): string | null {
  const leaf = /certificate leaf\s*=\s*H"([0-9a-fA-F]+)"/.exec(text);
  return parseCdhash(text) ?? (leaf ? leaf[1]!.toLowerCase() : null);
}

/** The safe-storage item name for a code identity. Unknown identity ⇒ the shared, un-namespaced item. */
export function safeStorageName(appName: string, identity: string | null): string {
  return identity ? `${appName} ${identity.slice(0, 12)}` : appName;
}

const defaultRun = (cmd: string, args: string[]): string => {
  const r = execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  return String(r);
};

/**
 * This bundle's ad-hoc cdhash, cached per binary in the profile so only the first launch of a given
 * build pays for the `codesign` call (it runs before the window exists, so it has to stay cheap).
 * Never throws: an unreadable or unsigned binary simply has no identity.
 */
export function codeIdentity(o: { exe: string; cacheFile: string; run?: (cmd: string, args: string[]) => string }): string | null {
  let stamp: { size: number; mtimeMs: number };
  try {
    const st = fs.statSync(o.exe);
    stamp = { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
  try {
    const c = JSON.parse(fs.readFileSync(o.cacheFile, "utf8")) as { exe: string; size: number; mtimeMs: number; cdhash: string };
    if (c.exe === o.exe && c.size === stamp.size && c.mtimeMs === stamp.mtimeMs && /^[0-9a-f]{8,}$/.test(c.cdhash)) return c.cdhash;
  } catch { /* no usable cache: read it again */ }
  let cdhash: string | null = null;
  try {
    cdhash = parseCodeIdentity((o.run ?? defaultRun)(CODESIGN, ["-d", "-r-", o.exe]));
  } catch { cdhash = null; }
  if (!cdhash) return null;
  try {
    fs.mkdirSync(path.dirname(o.cacheFile), { recursive: true });
    fs.writeFileSync(o.cacheFile, JSON.stringify({ exe: o.exe, ...stamp, cdhash }));
  } catch { /* the cache is an optimisation, not a requirement */ }
  return cdhash;
}

/** Safe only when the item is owned by this very binary (a known identity): then the ACL cannot ask anything. */
export function inProcessProbe(store: SafeStore): Verdict {
  try {
    if (!store.isEncryptionAvailable()) return "unavailable";
    return store.decryptString(store.encryptString(ROUND_TRIP)) === ROUND_TRIP ? "ok" : "blocked";
  } catch {
    return "blocked";
  }
}

function parseVerdict(stdout: string): Verdict {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PROBE_MARK)) continue;
    try {
      const v = (JSON.parse(line.slice(PROBE_MARK.length)) as { verdict?: string }).verdict;
      if (v === "ok" || v === "unavailable" || v === "blocked") return v;
    } catch { /* fall through to blocked */ }
  }
  return "blocked";
}

type Exec = typeof execFile;

/**
 * The bounded, same-identity canary. Spawns THIS binary with `SYNAPSE_KEYCHAIN_PROBE=1` and a hard
 * timeout; because it is the same binary it gets the same ACL answer, and because it is a separate
 * process a stall costs a SIGKILL instead of the app's main thread.
 */
export function probeKeychain(o: { exe: string; env: NodeJS.ProcessEnv; timeoutMs: number; exec?: Exec }): Promise<Verdict> {
  // We are the probe: a probe that forks probes would fork forever.
  if (o.env[PROBE_ENV] === "1") return Promise.resolve("blocked");
  const env = { ...o.env, [PROBE_ENV]: "1" };
  return new Promise<Verdict>((resolve) => {
    (o.exec ?? execFile)(o.exe, [], { env, timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (_e, stdout) => {
      resolve(parseVerdict(String(stdout ?? "")));
    });
  });
}

/** What this binary does when it IS the probe: answer on one line and get out. Never throws. */
export function runProbeMode(o: { store: SafeStore; write: (s: string) => void; exit: (code: number) => void }): void {
  let verdict: Verdict;
  try {
    verdict = inProcessProbe(o.store);
  } catch {
    verdict = "blocked";
  }
  o.write(`${PROBE_MARK} ${JSON.stringify({ verdict })}\n`);
  o.exit(0);
}

/**
 * Review M2: the keychain item that SEALED this profile's secrets, which the migration launch must name before
 * `ready`. Builds since bug 99 stamped it in keychain-namespace.json, and an older ad-hoc build's cdhash is not this
 * build's — its own item would be a fresh, empty one. So the stamp wins; with no usable stamp, this build's identity.
 */
export function legacySafeStorageName(profileDir: string, appName: string, identity: () => string | null): string {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(profileDir, "keychain-namespace.json"), "utf8")) as { namespace?: unknown }).namespace;
    if (typeof v === "string" && (v === appName || new RegExp(`^${appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [0-9a-f]{8,}$`).test(v))) return v;
  } catch { /* no stamp: this build's identity */ }
  return safeStorageName(appName, identity());
}

/**
 * Bug 285: the app was called Bots when its secrets were sealed into the keychain, so the item is "Bots <identity> Safe
 * Storage" (or the shared "Bots Safe Storage"). The app is Synapse now; an install that hasn't run the one-time migration
 * yet still has its secrets in the old item, so the migration keeps naming it by the old name.
 */
export const LEGACY_KEYCHAIN_APP_NAME = "Bots";

/** The keychain item the one-time migration reads: the stamped namespace, else this build's identity, under the old name. */
export function migrationItemName(profileDir: string, identity: () => string | null): string {
  return legacySafeStorageName(profileDir, LEGACY_KEYCHAIN_APP_NAME, identity);
}

/** safeStorage as a SafeStore. Named only here; used only by the one-time migration. */
export const electronStore = safeStorage as unknown as SafeStore;

/**
 * The migration's one keychain read, after the window is up: a verdict on whether the item answers, and the store
 * to read it with. Re-review 4: a synchronous safeStorage call can't be time-limited in process, and an unanswered
 * prompt would leave the gate pending forever with no attempt counted — so every read, named item or shared, is
 * asked first through the bounded probe child (this binary, same item name, SIGKILLed after PROBE_TIMEOUT_MS).
 * A timeout is "blocked", which the migration counts as a failed attempt.
 */
export async function openLegacyKeychain(o: { exe: string; env: NodeJS.ProcessEnv; exec?: Parameters<typeof probeKeychain>[0]["exec"] }): Promise<LegacyKeychain> {
  const verdict = await probeKeychain({ exe: o.exe, env: o.env, timeoutMs: PROBE_TIMEOUT_MS, exec: o.exec });
  return { verdict, store: electronStore };
}
