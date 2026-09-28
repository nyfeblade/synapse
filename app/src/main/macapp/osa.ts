/**
 * mac-apps: running one AppleScript/JXA script.
 *
 * Two backends, one result shape:
 *   - the warm `bots-mac` helper (no process start, compiled scripts cached) — the fast path;
 *   - `osascript` as a child process — the fallback when the helper isn't built or keeps dying, and the path
 *     CI stubs with a fake `osascript` on disk (tests pass their own binary; nothing here reads PATH).
 *
 * Every macOS refusal is turned into a plain sentence and a code here, so nothing above this file has to read
 * an OSA error number, and a denial is never a crash.
 */
import { execFile } from "node:child_process";
import type { MacScript } from "./scripts";
import type { HelperCode, MacHelper } from "./helper";

export interface OsaResult { ok: true; json: unknown; raw: string }
export interface OsaError { ok: false; error: string; code: HelperCode }
export type OsaOutcome = OsaResult | OsaError;

/**
 * The Apple event errors worth naming. -1743 is the one every user hits: macOS asked for Automation consent
 * (or was never asked) and the answer was no.
 */
const NOT_AUTHORISED = /-1743|-1744|Not authori[sz]ed to send Apple events|errAEEventNotPermitted/i;
const APP_MISSING = /-1728|-600|-10814|Can'?t get application|isn'?t running|Application isn'?t running/i;
const NO_SUCH = /-1719|-1728|Can'?t get |Invalid index/i;

/** The sentence a denial gets. `app` is named so the Settings panel's row is obvious. */
export function osaError(stderr: string, app: string): OsaError {
  const s = stderr.trim();
  if (NOT_AUTHORISED.test(s)) {
    return { ok: false, code: "permission", error: `macOS hasn't allowed Synapse to control ${app}. Settings → Computer → Apps turns it on (or System Settings → Privacy & Security → Automation).` };
  }
  if (APP_MISSING.test(s)) return { ok: false, code: "notfound", error: `${app} isn't available on this Mac right now.` };
  if (NO_SUCH.test(s)) return { ok: false, code: "notfound", error: `${app} couldn't find that. ${firstLine(s)}` };
  return { ok: false, code: "script", error: `${app} refused: ${firstLine(s) || "no reason given"}` };
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").replace(/^execution error:\s*/i, "").slice(0, 300).trim();

/** A script's stdout is meant to be one JSON object. Anything else is reported, never guessed at. */
export function parseResult(raw: string, app: string): OsaOutcome {
  const s = raw.trim();
  if (!s) return { ok: true, json: {}, raw: "" };
  try { return { ok: true, json: JSON.parse(s) as unknown, raw: s }; } catch { /* fall through */ }
  return { ok: false, code: "script", error: `${app} answered something unreadable: ${s.slice(0, 200)}` };
}

export interface OsaRunner { run(s: MacScript): Promise<OsaOutcome> }

/** The fallback: one `osascript` per action. Correct, and about 60–150 ms slower than the warm helper. */
export class OsascriptRunner implements OsaRunner {
  constructor(private d: { binary?: string; execFileFn?: typeof execFile; env?: NodeJS.ProcessEnv }) {}

  run(s: MacScript): Promise<OsaOutcome> {
    const bin = this.d.binary ?? "/usr/bin/osascript";
    const args = [...(s.lang === "js" ? ["-l", "JavaScript"] : []), "-e", s.source];
    const run = this.d.execFileFn ?? execFile;
    return new Promise<OsaOutcome>((resolve) => {
      run(bin, args, { timeout: s.timeoutMs, maxBuffer: 8 << 20, env: this.d.env ?? process.env }, (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "") || (err ? err.message : "");
        if (err && (err as { killed?: boolean }).killed) return resolve({ ok: false, code: "timeout", error: `${s.app} didn't answer within ${Math.round(s.timeoutMs / 1000)}s.` });
        if (err && !out.trim()) return resolve(osaError(errText, s.app));
        resolve(parseResult(out, s.app));
      });
    });
  }
}

/** The fast path: the warm helper compiles once and keeps the script. */
export class HelperRunner implements OsaRunner {
  constructor(private helper: MacHelper) {}

  async run(s: MacScript): Promise<OsaOutcome> {
    const r = await this.helper.request({ op: "osa", lang: s.lang, source: s.source, timeoutMs: s.timeoutMs }, s.timeoutMs);
    if (!r.ok) return r.code === "permission" ? osaError("-1743", s.app) : { ok: false, code: r.code, error: `${s.app}: ${r.error}` };
    return parseResult(typeof r.result === "string" ? r.result : "", s.app);
  }
}

/** The helper when it is up, `osascript` when it is not. One object, so the caller never chooses. */
export class WarmFirstRunner implements OsaRunner {
  constructor(private d: { helper: MacHelper; fallback: OsaRunner; log(l: string): void }) {}

  async run(s: MacScript): Promise<OsaOutcome> {
    const viaHelper = new HelperRunner(this.d.helper);
    const r = await viaHelper.run(s);
    // "unavailable" means the helper itself isn't there — the script never ran, so running it through
    // osascript is not a retry of something that may have half-happened.
    if (r.ok || r.code !== "unavailable") return r;
    this.d.log(`macapp: no warm helper, running ${s.app} through osascript`);
    return this.d.fallback.run(s);
  }
}
