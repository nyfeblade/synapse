import { execFile, spawnSync } from "node:child_process";
import { macQuietHandoff, type MacHandoffContext } from "@synapse/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fix round (review of bug 258): the "allowed app" check the Full-auto hand-off split uses for `open -a <app>` and
 * `tell application "<app>" to activate|quit|open location`. An app may run quietly only when it existed before the
 * Bot ran and the Bot can't have written it: under /System/Applications (or /System/Library), or under /Applications
 * with a root-owned or Apple/Developer-ID-signed bundle, a verified codesign, and no user write. Anything the Bot
 * could have planted — ~/Applications, a user-writable bundle, an unknown third-party bundle id — is refused (asks).
 *
 * The result is cached per input for the life of the process (apps don't change mid-run), so the codesign spawn is
 * paid at most once per app.
 *
 * 0.1.4 first-run (code audit 3.4): the coordinator's policy check is synchronous, and a codesign of a big app took
 * seconds there, freezing every stream the coordinator carries (the chat froze while a Bot worked on the Mac). The
 * daemon now calls `warmAllowedApps` first, which runs codesign asynchronously and fills the cache, so the sync
 * check only reads it. The sync spawn is left only as the fallback for a name the warm-up didn't see.
 */
const cache = new Map<string, boolean>();

const APP_DIRS = (home: string) => [
  { dir: "/System/Applications", system: true },
  { dir: "/System/Library/CoreServices", system: true },
  { dir: "/Applications", system: false },
  { dir: path.join(home, "Applications"), system: false }, // user-writable: never allowed
];

/** Resolve the app the Bot named to a real bundle path, or null. The `.app` on disk (symlinks followed, so Safari's
 *  /Applications link resolves to its real /System location). */
function resolveBundle(nameOrPath: string, home: string): string | null {
  const s = nameOrPath.trim();
  if (!s) return null;
  const real = (p: string): string | null => {
    try { if (!fs.statSync(p).isDirectory() || !/\.app$/i.test(p.replace(/\/$/, ""))) return null; return fs.realpathSync.native(p); } catch { return null; }
  };
  if (s.startsWith("/") || s.startsWith("~/") || s === "~") {
    const abs = (s === "~" ? home : s.startsWith("~/") ? path.join(home, s.slice(2)) : s).replace(/\/$/, "");
    return real(abs);
  }
  // A bundle id (has dots, no slash): only Apple's own are trusted without resolving; others ask.
  if (/^[a-z0-9.-]+$/i.test(s) && s.includes(".") && !/\.app$/i.test(s)) {
    return /^com\.apple\./i.test(s) ? "/System/Applications" : null;
  }
  // A plain name: look in the app folders, in order (system first).
  for (const { dir } of APP_DIRS(home)) {
    for (const cand of [path.join(dir, `${s}.app`), path.join(dir, "Utilities", `${s}.app`)]) {
      const r = real(cand);
      if (r) return r;
    }
  }
  return null;
}

/** The bundle, and none of its enclosing app folders up to /Applications, is writable by this user. */
function notUserWritable(bundle: string): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  try {
    const st = fs.statSync(bundle);
    // Owned by the current user, or group/world writable: the Bot (or something it can reach) could have written it.
    if (st.uid === uid && uid !== 0) return false;
    if ((st.mode & 0o022) !== 0) return false;
    return true;
  } catch { return false; }
}

function codesignTrusted(bundle: string): boolean {
  try {
    // Valid signature AND chains to an Apple root (Apple-signed or Developer-ID).
    const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "-R=anchor apple generic", bundle], { timeout: 8_000, stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

export function macAllowedApp(nameOrPath: string, home: string = os.homedir()): boolean {
  const key = `${home}\0${nameOrPath}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ok = compute(nameOrPath, home);
  cache.set(key, ok);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return ok;
}

function compute(nameOrPath: string, home: string): boolean {
  const bundle = resolveBundle(nameOrPath, home);
  if (!bundle) return false;
  const f = bundle.toLowerCase();
  if (f.startsWith("/system/")) return true; // SIP-protected: the Bot can't have written it
  if (!f.startsWith("/applications/")) return false; // ~/Applications and anywhere else the Bot could reach: ask
  if (!notUserWritable(bundle)) return false;
  let rootOwned = false;
  try { rootOwned = fs.statSync(bundle).uid === 0; } catch { return false; }
  return (rootOwned || codesignTrusted(bundle)) && codesignValid(bundle);
}

function codesignValid(bundle: string): boolean {
  try { return spawnSync("/usr/bin/codesign", ["--verify", "--strict", bundle], { timeout: 8_000, stdio: "ignore" }).status === 0; }
  catch { return false; }
}

type Run = (file: string, args: string[], timeoutMs: number) => Promise<"ok" | "fail" | "timeout">;
const runAsync: Run = (file, args, timeoutMs) => new Promise((resolve) => {
  try {
    execFile(file, args, { timeout: timeoutMs }, (err) => {
      if (!err) return resolve("ok");
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      resolve(e.killed || e.signal === "SIGTERM" ? "timeout" : "fail");
    });
  } catch { resolve("fail"); }
});

/** The same decision as `compute`, with codesign run off the thread. A codesign that timed out is not cached, so a
 *  big app is checked again next time instead of being remembered as untrusted. */
async function computeAsync(nameOrPath: string, home: string, run: Run): Promise<boolean | "timeout"> {
  const bundle = resolveBundle(nameOrPath, home);
  if (!bundle) return false;
  const f = bundle.toLowerCase();
  if (f.startsWith("/system/")) return true;
  if (!f.startsWith("/applications/")) return false;
  if (!notUserWritable(bundle)) return false;
  let rootOwned = false;
  try { rootOwned = fs.statSync(bundle).uid === 0; } catch { return false; }
  const limit = 30_000; // off the thread now, so a big bundle gets the time it needs
  if (!rootOwned) {
    const anchored = await run("/usr/bin/codesign", ["--verify", "--strict", "-R=anchor apple generic", bundle], limit);
    if (anchored !== "ok") return anchored === "timeout" ? "timeout" : false;
  }
  const valid = await run("/usr/bin/codesign", ["--verify", "--strict", bundle], limit);
  return valid === "timeout" ? "timeout" : valid === "ok";
}

/** Check one app off the thread and cache the answer (what `macAllowedApp` then returns without a spawn). */
export async function warmAllowedApp(nameOrPath: string, home: string = os.homedir(), run: Run = runAsync): Promise<boolean | null> {
  const key = `${home}\0${nameOrPath}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ok = await computeAsync(nameOrPath, home, run);
  if (ok === "timeout") return null;
  cache.set(key, ok);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return ok;
}

/** Every app a command's Full-auto hand-off check would ask about, checked off the thread before the (sync) check. */
export async function warmAllowedApps(command: string, ctx: MacHandoffContext, run: Run = runAsync): Promise<string[]> {
  const names = new Set<string>();
  try { macQuietHandoff(command, { ...ctx, isAllowedApp: (n) => { names.add(n); return true; } }); } catch { /* the real check decides */ }
  await Promise.all([...names].map((n) => warmAllowedApp(n, ctx.home, run)));
  return [...names];
}

/** Tests only: forget the cache. */
export function _clearAppTrustCache(): void { cache.clear(); }
