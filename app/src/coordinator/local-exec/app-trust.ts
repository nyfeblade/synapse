import { spawnSync } from "node:child_process";
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

/** Tests only: forget the cache. */
export function _clearAppTrustCache(): void { cache.clear(); }
