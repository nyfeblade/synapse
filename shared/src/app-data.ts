/**
 * Bug 285 + 289: the app's data folder is ~/Library/Application Support/Synapse. A …/Bots folder on the same Mac is a
 * different build's data (the app's former name); the app never moves or reads it, and every wall around the app's own
 * data covers the folder under both names, so a Bot can reach neither.
 */
export const APP_DATA_NAME = "Synapse";
export const LEGACY_APP_DATA_NAME = "Bots";

/**
 * The app's data folder and the same folder under its other name (`…/Application Support/Synapse/<rest>` ⇄
 * `…/Application Support/Bots/<rest>`), the one in use first. A folder outside an app-data folder of either name is
 * only itself. Plain string work on "/" paths (the renderer and the host use it too).
 */
export function appDataDirs(userData: string | null | undefined): string[] {
  if (!userData) return [];
  const parts = userData.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i - 1] !== "Application Support") continue;
    const other = parts[i] === APP_DATA_NAME ? LEGACY_APP_DATA_NAME : parts[i] === LEGACY_APP_DATA_NAME ? APP_DATA_NAME : null;
    if (!other) continue;
    const alt = [...parts];
    alt[i] = other;
    return [userData, alt.join("/")];
  }
  return [userData];
}

/**
 * Bug 288: the whole data root the profile sits in (`…/Application Support/Synapse` and `…/Application Support/Bots`),
 * not only the profile. Every profile, the shared voice engines (run by the main process outside the sandbox), backups
 * and releases live there, so a Bot may neither read nor write any of it. A folder outside an app-data folder of
 * either name is only itself (appDataDirs).
 */
export function appDataRoots(userData: string | null | undefined): string[] {
  if (!userData) return [];
  const parts = userData.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i - 1] !== "Application Support" || (parts[i] !== APP_DATA_NAME && parts[i] !== LEGACY_APP_DATA_NAME)) continue;
    const base = parts.slice(0, i).join("/");
    return parts[i] === APP_DATA_NAME ? [`${base}/${APP_DATA_NAME}`, `${base}/${LEGACY_APP_DATA_NAME}`] : [`${base}/${LEGACY_APP_DATA_NAME}`, `${base}/${APP_DATA_NAME}`];
  }
  return appDataDirs(userData);
}

/** Bug 288: every path the walls around the app's data name: the roots and the profile folders (for spelling checks). */
export function appDataWalls(userData: string | null | undefined): string[] {
  return [...new Set([...appDataRoots(userData), ...appDataDirs(userData)])];
}

/**
 * Bug 286: the app's URL scheme is synapse://. It was bots:// (the app's old name), and links written before the
 * rename (a Bot's reply, a note, a bookmark) still open: bots:// stays registered and parsed as an alias for one release.
 */
export const APP_SCHEME = "synapse";
export const LEGACY_APP_SCHEME = "bots";
export const APP_SCHEMES = [APP_SCHEME, LEGACY_APP_SCHEME] as const;
