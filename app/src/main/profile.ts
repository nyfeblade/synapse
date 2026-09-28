import fs from "node:fs";
import path from "node:path";
import { APP_DATA_NAME, resolveDataRoot } from "./data-rename";

export function profileName(env: NodeJS.ProcessEnv): string {
  const p = env.APP_PROFILE;
  return p && /^[A-Za-z0-9_-]{1,64}$/.test(p) ? p : "default";
}

/**
 * Must run before app.whenReady(): every app file lives under …/Synapse/profiles/<APP_PROFILE>/ (bug 289: a …/Bots
 * folder is another build's and is left alone). SYNAPSE_APP_DATA (an absolute path) replaces the app-data folder, so
 * e2e and packaged test runs (their Playwright globalSetup sets it to a temp folder) never open the real one.
 */
export function configureProfile(app: { getPath(n: "appData"): string; setPath(n: "userData" | "appData", p: string): void; setName(n: string): void }, env: NodeJS.ProcessEnv): string {
  app.setName(APP_DATA_NAME);
  const override = env.SYNAPSE_APP_DATA;
  let appData = app.getPath("appData");
  if (override && path.isAbsolute(override)) {
    fs.mkdirSync(override, { recursive: true });
    app.setPath("appData", override);
    appData = override;
  }
  const data = resolveDataRoot(appData, profileName(env));
  for (const n of data.notes) console.error(`data folder: ${n}`);
  const dir = path.join(data.root, "profiles", profileName(env));
  fs.mkdirSync(dir, { recursive: true });
  app.setPath("userData", dir);
  return dir;
}

/**
 * Bug 167: where a voice engine may be installed, best first. The install scripts put the heavy
 * engines (Qwen, F5, whisper) in …/Synapse/<engine>, shared by every profile, while userData is
 * …/Synapse/profiles/<name>; so the profile's own folder is tried first and the shared one after it.
 * Outside the profiles layout (tests, a custom userData) it is just the one folder.
 */
export function engineDirs(userData: string, engine: string): string[] {
  const parent = path.dirname(userData);
  const own = path.join(userData, engine);
  return path.basename(parent) === "profiles" ? [own, path.join(path.dirname(parent), engine)] : [own];
}
