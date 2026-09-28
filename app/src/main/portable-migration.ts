import fs from "node:fs";
import path from "node:path";
import { writeAppSettings, type AppSettings } from "./app-settings";

/**
 * Portable install: at launch, a profile that already pinned a box's key keeps the machine it has ("box") and is
 * marked set up, so the setup screen never decides it lazily. Voice settings are left exactly as they are.
 */
/** Bumped if a later build needs to migrate again. */
export const PORTABLE_MIGRATION = 1;

/**
 * Runs once per profile, at launch, before any voice engine is looked for. Returns true when it wrote.
 * A profile with no settings file (a new Mac) is left without one.
 */
export function runPortableMigration(userData: string, _home: string, log: (line: string) => void): boolean {
  let current: Partial<AppSettings> | null;
  try {
    current = JSON.parse(fs.readFileSync(path.join(userData, "app-settings.json"), "utf8")) as Partial<AppSettings>;
  } catch {
    current = null;
  }
  // An existing install (this profile pinned a box's key) keeps the machine it has, "box", and never sees the
  // setup screen: recorded here, at startup, so nothing later decides it lazily (fix round 1).
  const pinned = fs.existsSync(path.join(userData, "box-pin.json"));
  const existing = pinned && !current?.boxMachine ? { boxMachine: "box", setupDone: true } : null;
  if (!current) {
    if (!existing) return false;
    writeAppSettings(userData, { ...existing, portableMigrated: PORTABLE_MIGRATION });
    log("portable install: this profile already has a Bots' computer (box); setup is done");
    return true;
  }
  if ((current.portableMigrated ?? 0) >= PORTABLE_MIGRATION && !existing) return false;
  writeAppSettings(userData, { ...(existing ?? {}), portableMigrated: PORTABLE_MIGRATION });
  if (existing) log("portable install: this profile already has a Bots' computer (box); setup is done");
  return true;
}
