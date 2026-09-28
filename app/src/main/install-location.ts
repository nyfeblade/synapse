/**
 * Portable install: an app run straight from the DMG or from Downloads is translocated by macOS to a random
 * read-only path — the updater can't swap it, synapse:// and .botpack files don't reach it, and each launch is a
 * "new" app to the system. The first launch outside /Applications offers to move it there (Electron's
 * app.moveToApplicationsFolder, which moves, then relaunches from /Applications). "Not now" is remembered.
 *
 * Fix round 1: a Synapse already in /Applications is never replaced silently. A newer one is kept (this copy
 * isn't moved over it); an older or equal one is replaced only when the user confirms it by name; a running one
 * is never touched. Electron's conflict handler enforces the same answer at the moment of the move.
 */
export type MoveConflict = "exists" | "existsAndRunning";

function newer(a: string, b: string): boolean {
  const x = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function offerMoveToApplications(o: {
  packaged: boolean; inApplications: boolean; fuzz: boolean; alreadyDeclined: boolean;
  currentVersion: string;
  /** The Synapse already in /Applications, if any. */
  existing(): { version: string } | null;
  ask(): Promise<"move" | "later">;
  /** "Replace the Synapse <version> in Applications?" */
  confirmReplace(existingVersion: string): Promise<boolean>;
  move(conflictHandler: (kind: MoveConflict) => boolean): boolean;
  remember(): void;
}): Promise<"skipped" | "moved" | "declined" | "kept-newer" | "failed"> {
  if (!o.packaged || o.fuzz || o.inApplications || o.alreadyDeclined) return "skipped";
  const there = o.existing();
  if (there && newer(there.version, o.currentVersion)) return "kept-newer";
  const answer = await o.ask();
  if (answer !== "move") { o.remember(); return "declined"; }
  let replaceOk = false;
  if (there) {
    replaceOk = await o.confirmReplace(there.version);
    if (!replaceOk) return "declined";
  }
  try {
    return o.move((kind) => kind === "exists" && replaceOk) ? "moved" : "failed";
  } catch {
    return "failed";
  }
}
