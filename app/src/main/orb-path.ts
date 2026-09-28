import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the OrbStack CLI lives, best first (controller ruling 2026-09-19): /usr/local/bin/orb can be a
 * symlink into a mounted OrbStack installer DMG that dangles once it's ejected, so OrbStack.app's own
 * CLI comes first. Portable install: the app may be in ~/Applications, the CLI may come from Homebrew or
 * OrbStack's per-user bin. box/orb.sh keeps the same list for the box scripts (a test keeps the two in step).
 */
export function orbCandidates(home: string): string[] {
  return [
    "/Applications/OrbStack.app/Contents/MacOS/bin/orb",
    path.join(home, "Applications/OrbStack.app/Contents/MacOS/bin/orb"),
    "/usr/local/bin/orb",
    "/opt/homebrew/bin/orb",
    path.join(home, ".orbstack/bin/orb"),
  ];
}

export const ORB_CANDIDATES = orbCandidates(os.homedir());

/** Where OrbStack.app itself may be installed. */
export function orbAppCandidates(home: string): string[] {
  return ["/Applications/OrbStack.app", path.join(home, "Applications/OrbStack.app")];
}

/** True for an executable regular file; a dangling symlink (ejected DMG) is false. */
export function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolved on every call (cheap), so ejecting or installing OrbStack mid-session is picked up. Falls back to `orb` on PATH. */
export function resolveOrb(exists: (p: string) => boolean = isExecutableFile): string {
  return ORB_CANDIDATES.find((p) => exists(p)) ?? "orb";
}
