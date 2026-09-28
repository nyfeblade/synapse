import fs from "node:fs";
import path from "node:path";
import { APP_DATA_NAME, LEGACY_APP_DATA_NAME } from "@synapse/shared";

/**
 * Bug 289: the app's data lives in ~/Library/Application Support/Synapse. The public build has never shipped under
 * another name, so a …/Bots folder on this Mac (or ~/Library/Logs/Bots) is never its own data: it belongs to a
 * different build of the app, and is never moved, merged or read here (bug 285 moved it on the first launch, which took
 * the other build's whole data folder). The walls around the app's data still cover …/Bots (app-data.ts), so a Bot
 * can't reach that build's data either.
 */
export { APP_DATA_NAME, LEGACY_APP_DATA_NAME };

export type DataRootState = "current";
export interface DataRoot { root: string; state: DataRootState; notes: string[] }

/** Where this launch's data lives: always `<appData>/Synapse`. Nothing under any other name is touched. */
export function resolveDataRoot(appData: string, _profile: string): DataRoot {
  const notes: string[] = [];
  let other = false;
  try { other = fs.lstatSync(path.join(appData, LEGACY_APP_DATA_NAME)).isDirectory(); } catch { /* none */ }
  if (other) notes.push(`${path.join(appData, LEGACY_APP_DATA_NAME)} belongs to another build of the app and is left alone`);
  return { root: path.join(appData, APP_DATA_NAME), state: "current", notes };
}
