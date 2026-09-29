import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPDATE_PUBLIC_KEY } from "./update-public-key";
import { APP_DATA_NAME } from "../data-rename";

export type UpdateState = { version: string; track: "stable"; auto: boolean; feed: string | null; status: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "no-feed" | "not-configured" | "error"; latest: string | null; error: string | null };

/** I8: a release tag is a plain version. */
export const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
/** I7: the update feed is owner/repo, nothing else. */
export function validFeed(f: unknown): f is string {
  return typeof f === "string" && /^[\w.-]+\/[\w.-]+$/.test(f) && !f.split("/").some((p) => p === "." || p === "..");
}
export const NOT_CONFIGURED = "Updates not configured";

/** Release updates: every release artifact is named Synapse-<version>-arm64 (app/scripts/release-lib.mjs, releaseArtifacts). */
export const releaseZipName = (version: string) => `Synapse-${version}-arm64.zip`;

type Semver = { core: [number, number, number]; pre: (string | number)[] };
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
/** Semver 2.0.0 (an optional leading "v"); null for anything else. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : [] };
}
/** Semver precedence (§11): <0, 0 or >0. Throws on a string that isn't a version. Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
/** a is a newer version than b. Anything that isn't a version is never newer (and nothing is newer than it). */
export function newer(a: string, b: string): boolean {
  if (!parseSemver(a) || !parseSemver(b)) return false;
  return compareSemver(a, b) > 0;
}

/** The local release folder's manifest (app/scripts/release.mjs writes it). sig: base64 Ed25519 over "zip|version|sha256". */
export interface LocalRelease { name: string; version: string; zip: string; sha256: string; sig?: string; hostBuild?: string | null; createdAt?: number }

/** A network failure, a rate limit or a GitHub outage: not the user's problem, so no error is shown; try again later. */
class TransientError extends Error {
  constructor(readonly retryMs: number) { super("transient"); }
}
const RETRY_DEFAULT_MS = 30 * 60_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 6 * 3600_000;
const clampRetry = (ms: number) => Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(ms)));
/** 429, 5xx, or a 403 with no requests left: transient. The wait comes from Retry-After or X-RateLimit-Reset. */
function transientStatus(res: { status: number; headers?: { get(n: string): string | null } }, now = Date.now()): TransientError | null {
  const h = (n: string) => res.headers?.get?.(n) ?? null;
  const limited = res.status === 429 || (res.status === 403 && h("x-ratelimit-remaining") === "0");
  if (!limited && res.status < 500) return null;
  const after = Number(h("retry-after"));
  if (Number.isFinite(after) && after > 0) return new TransientError(clampRetry(after * 1000));
  const reset = Number(h("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return new TransientError(clampRetry(reset * 1000 - now));
  return new TransientError(RETRY_DEFAULT_MS);
}
/** fetch() itself rejecting (offline, DNS, reset) is transient. */
async function quietFetch(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await f(url, init); } catch { throw new TransientError(15 * 60_000); }
  const t = transientStatus(res);
  if (t) throw t;
  return res;
}
/** The largest update zip the app will download (the packaged app with its bundled voice runtime is well under this). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 3 * 1024 ** 3;
const TOKEN_ORIGIN = "https://api.github.com";
const tooLarge = (cap: number) => new Error(`The download is too large (over ${Math.round(cap / 1024 ** 2)} MB), so it wasn't installed.`);
/** Streams a response body to `file`, hashing as it goes and stopping at `cap` bytes. Returns the sha256. */
async function saveCapped(res: Response, file: string, cap: number): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) throw tooLarge(cap);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "wx", 0o600);
  let n = 0;
  try {
    const reader = (res.body as ReadableStream<Uint8Array> | null | undefined)?.getReader?.();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > cap) { await reader.cancel().catch(() => {}); throw tooLarge(cap); }
        hash.update(value);
        fs.writeSync(fd, value);
      }
    } else {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > cap) throw tooLarge(cap);
      hash.update(bytes);
      fs.writeSync(fd, bytes);
    }
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}
const SIG_REFUSED = "The update's signature didn't verify against Synapse's update key, so it wasn't installed.";
const UNSIGNED = "This update isn't signed, so it wasn't installed.";
/** The detached Ed25519 signature over "name|version|sha256", checked against the embedded public key. */
export function verifyReleaseSignature(o: { name: string; version: string; sha256: string; sig: string | null | undefined; publicKey: string }): void {
  if (!o.sig || !String(o.sig).trim()) throw new Error(UNSIGNED);
  const sig = Buffer.from(String(o.sig).trim(), "base64");
  let ok = false;
  try { ok = sig.length === 64 && crypto.verify(null, Buffer.from(`${o.name}|${o.version}|${o.sha256}`, "utf8"), crypto.createPublicKey(o.publicKey), sig); } catch { ok = false; }
  if (!ok) throw new Error(SIG_REFUSED);
}

type CodesignRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const codesignRun: CodesignRun = (args) => new Promise((resolve) => {
  execFile("/usr/bin/codesign", args, { timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/**
 * The new build must satisfy the RUNNING app's designated requirement — `identifier
 * "com.nyfeblade.synapse" and certificate leaf = H"<Synapse Local Signing's SHA-1>"` for a build
 * package.mjs signed with the stable local identity (bug 99). Only the holder of that private key
 * (this Mac's login keychain) can make a bundle that passes, so this is the trust anchor for the
 * local release folder. An ad-hoc running app has a bare-cdhash requirement no other build can
 * meet; that is said plainly instead of pretending to check.
 */
export async function checkDesignatedRequirement(o: { current: string; staged: string; codesign?: CodesignRun }): Promise<void> {
  const run = o.codesign ?? codesignRun;
  const d = await run(["-d", "-r-", o.current]);
  const m = /designated => (.+)/.exec(`${d.stdout}\n${d.stderr}`);
  const req = m?.[1]?.trim() ?? "";
  if (!req || /^cdhash /.test(req) || !/certificate leaf = H"[0-9a-f]{40}"/i.test(req)) {
    throw new Error("This copy of Synapse is signed ad hoc, so an update's signature can't be checked. Install a build signed with Synapse Local Signing (npm run package) once by hand.");
  }
  const v = await run(["--verify", "--deep", "--strict", `-R=${req}`, o.staged]);
  if (v.code !== 0) throw new Error("The new build isn't signed by Synapse Local Signing, so it wasn't installed.");
}

export class UpdateService {
  private st: UpdateState;
  private assets: { zip: string; sha: string; sig: string; name: string } | null = null;
  private local: (LocalRelease & { dir: string }) | null = null;
  private staged: string | null = null;
  private retryMs: number | null = null;
  /** One in-flight run per operation: a second call while one is running gets the same promise. */
  private checking: Promise<UpdateState> | null = null;
  private downloading: Promise<UpdateState> | null = null;

  /** publicKey: the pinned Ed25519 key (SPKI PEM); defaults to the build-time UPDATE_PUBLIC_KEY. null = not configured. */
  constructor(private o: {
    current: string; feed(): string | null; packaged: boolean;
    /** The local release folder (Settings → Updates); checked before the GitHub feed. */
    folder?(): string | null;
    /** Checks the unpacked build's code signature (default: checkDesignatedRequirement against appPath). */
    verifySignature?(staged: string): Promise<void>;
    /** Where the new build reports it started healthily, and where a rollback is recorded (default: stageDir). */
    markerDir?: string; appPath: string; stageDir: string; auto?: boolean; token?(): string | null; fetchFn?: typeof fetch;
    run?: (cmd: string, args: string[]) => Promise<void>; emit(s: UpdateState): void; publicKey?: string | null;
    /** Final secfix item 11: reads CFBundleShortVersionString from an unpacked .app (default: its Contents/Info.plist). */
    bundleVersion?: (app: string) => string | null;
    /** The zip download's size cap (Content-Length and the streamed body); default DEFAULT_MAX_DOWNLOAD_BYTES. */
    maxDownloadBytes?: number;
    /** A version the swap script rolled back (skippedVersion): never offered or downloaded again until a newer one is out. */
    skipped?(): string | null;
  }) {
    this.st = { version: o.current, track: "stable", auto: !!o.auto, feed: o.feed(), status: "idle", latest: null, error: null };
  }

  state(): UpdateState { return { ...this.st, feed: this.o.feed() }; }
  /** The swap script rolled a new build back (it never reported healthy): say so on the old build. */
  noteRolledBack(version?: string | null): UpdateState { return this.set({ status: "error", latest: version ?? this.st.latest, error: rolledBackMessage(version ?? null) }); }
  /** The rolled-back version, when `v` is it: it stays off offer (with the message on screen) until a newer one is out. */
  private isSkipped(v: string): boolean { const s = this.o.skipped?.(); return !!s && s === v; }
  setAuto(on: boolean): UpdateState { return this.set({ auto: on }); }
  /** After a network error or rate limit: how long to wait before checking again (null: nothing to retry). */
  retryAfterMs(): number | null { return this.retryMs; }

  /** A transient failure: back to a quiet state (no error line), and remember when to retry. */
  private quiet(e: TransientError): UpdateState {
    this.retryMs = e.retryMs;
    // A rollback note stays on screen through a network hiccup.
    const skipped = this.o.skipped?.();
    if (skipped && this.st.error === rolledBackMessage(skipped)) return this.state();
    return this.set({ status: "idle", error: null });
  }

  // A private feed needs the same bearer token on every GitHub API call (update-source.json,
  // update-source.ts); a public feed works with no token, so none is sent.
  // The token goes ONLY to https://api.github.com (exact origin): an asset URL elsewhere, or a look-alike host, never sees it.
  private authHeaders(accept: string, url: string): Record<string, string> {
    const token = this.o.token?.();
    let origin = "";
    try { origin = new URL(url).origin; } catch { /* not a URL: no token */ }
    return token && origin === TOKEN_ORIGIN ? { accept, authorization: `Bearer ${token}` } : { accept };
  }

  private publicKey(): string | null {
    return this.o.publicKey === undefined ? UPDATE_PUBLIC_KEY : this.o.publicKey;
  }

  /** latest.json in the release folder, validated. null when there is no folder or no manifest. */
  private readLocal(): (LocalRelease & { dir: string }) | null {
    const dir = this.o.folder?.();
    if (!dir) return null;
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, "latest.json"), "utf8"); } catch { return null; }
    let m: LocalRelease;
    try { m = JSON.parse(raw) as LocalRelease; } catch { throw new Error("The release folder's latest.json isn't valid."); }
    if (typeof m?.version !== "string" || !RELEASE_TAG.test(m.version)) throw new Error("The release folder's latest.json has no plain version number.");
    if (typeof m.zip !== "string" || !/^[\w.-]+\.zip$/.test(m.zip) || m.zip.startsWith(".")) throw new Error("The release folder's latest.json names a zip outside the folder.");
    if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error("The release folder's latest.json has no checksum.");
    let sig = typeof m.sig === "string" ? m.sig : undefined;
    if (!sig) { try { sig = fs.readFileSync(path.join(dir, `${m.zip}.sig`), "utf8").trim(); } catch { /* unsigned: download() refuses it */ } }
    return { ...m, sig, version: m.version.replace(/^v/, ""), dir };
  }

  check(): Promise<UpdateState> {
    this.checking ??= this.checkOnce().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async checkOnce(): Promise<UpdateState> {
    if (!this.o.packaged) return this.set({ status: "no-feed" });
    this.local = null;
    try {
      const l = this.readLocal();
      if (l) {
        if (newer(l.version, this.o.current) && this.isSkipped(l.version)) {
          this.assets = null;
          return this.set({ status: "error", latest: l.version, error: rolledBackMessage(l.version) });
        }
        if (newer(l.version, this.o.current)) {
          this.local = l; this.assets = null;
          if (!this.publicKey()) return this.set({ status: "not-configured", latest: l.version, error: NOT_CONFIGURED });
          return this.set({ status: "available", latest: l.version, error: null });
        }
        if (!this.o.feed()) return this.set({ status: "none", latest: l.version, error: null });
      }
    } catch (e) {
      return this.set({ status: "error", error: (e as Error).message });
    }
    const feed = this.o.feed();
    if (!feed) return this.set({ status: "no-feed" });
    // I7: no pinned signing key → never install anything.
    if (!this.publicKey()) { this.assets = null; return this.set({ status: "not-configured", error: NOT_CONFIGURED }); }
    if (!validFeed(feed)) return this.set({ status: "error", error: "The update source must be owner/repo." });
    this.set({ status: "checking", error: null });
    this.retryMs = null;
    try {
      // The releases LIST, not /releases/latest: /latest hides a release someone ticked "pre-release" on, and
      // 404s when the newest is one. Drafts are skipped (not published); only plain version tags count.
      const listUrl = `https://api.github.com/repos/${feed}/releases?per_page=30`;
      const res = await quietFetch(this.o.fetchFn ?? fetch, listUrl, { headers: this.authHeaders("application/vnd.github+json", listUrl) });
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        throw new Error(this.o.token?.() ? `GitHub didn't let this token read ${feed}'s releases (${res.status}). Check the repo name and the token.` : `GitHub can't find ${feed}. If the repo is private, add an access token that can read it.`);
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const list = (await res.json()) as { tag_name?: unknown; draft?: unknown; assets?: { name: string; url: string }[] }[];
      if (!Array.isArray(list)) throw new Error("GitHub's release list wasn't readable.");
      this.retryMs = null;
      const best = list
        // parseSemver too: RELEASE_TAG alone lets "v01.0.0" through, which compareSemver would throw on inside sort.
        .filter((r) => r && r.draft !== true && typeof r.tag_name === "string" && RELEASE_TAG.test(r.tag_name) && parseSemver(r.tag_name) !== null)
        .map((r) => ({ v: (r.tag_name as string).replace(/^v/, ""), assets: Array.isArray(r.assets) ? r.assets : [] }))
        .sort((a, b) => compareSemver(b.v, a.v))[0];
      if (!best || !newer(best.v, this.o.current)) { this.assets = null; return this.set({ status: "none", latest: best?.v ?? null, error: null }); }
      const v = best.v;
      if (this.isSkipped(v)) { this.assets = null; return this.set({ status: "error", latest: v, error: rolledBackMessage(v) }); }
      // By exact name only: a look-alike (another arch, the DMG, an old "Bots-" name) is never downloaded.
      const name = releaseZipName(v);
      const zip = best.assets.find((a) => a.name === name);
      const sha = best.assets.find((a) => a.name === `${name}.sha256`);
      const sig = best.assets.find((a) => a.name === `${name}.sig`);
      if (!zip || !sha) throw new Error(`The ${v} release is missing ${name} or its checksum.`);
      if (!sig) throw new Error(`The ${v} release isn't signed, so it won't be installed.`);
      // `browser_download_url` 404s unauthenticated on a private repo (same as the release call
      // itself); the asset API `url` with Accept: application/octet-stream is the path that
      // actually works with a bearer token (and with none, on a public repo).
      this.assets = { zip: zip.url, sha: sha.url, sig: sig.url, name };
      return this.set({ status: "available", latest: v, error: null });
    } catch (e) {
      this.assets = null;
      if (e instanceof TransientError) return this.quiet(e);
      return this.set({ status: "error", error: (e as Error).message });
    }
  }

  download(): Promise<UpdateState> {
    this.downloading ??= this.downloadOnce().finally(() => { this.downloading = null; });
    return this.downloading;
  }

  private async downloadOnce(): Promise<UpdateState> {
    if (this.local) return this.downloadLocal({ ...this.local });
    const key = this.publicKey();
    if (!key) return this.set({ status: "not-configured", error: NOT_CONFIGURED });
    // A snapshot: a check() that runs meanwhile may replace this.assets / st.latest; this run keeps what it started with.
    const assets = this.assets ? { ...this.assets } : null;
    const version = this.st.latest;
    if (!assets || !version) return this.state();
    if (this.isSkipped(version)) return this.set({ status: "error", error: rolledBackMessage(version) });
    // Final secfix item 11: never a downgrade (or a reinstall of the running version).
    if (!newer(version, this.o.current)) return this.set({ status: "error", error: "That release isn't newer than this version, so it wasn't installed." });
    this.set({ status: "downloading" });
    this.staged = null;
    this.retryMs = null;
    const zipPath = path.join(this.o.stageDir, `update-${version}.zip`);
    const out = path.join(this.o.stageDir, `update-${version}`);
    try {
      const f = this.o.fetchFn ?? fetch;
      const get = async (url: string) => {
        const res = await quietFetch(f, url, { headers: this.authHeaders("application/octet-stream", url) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status} for a release file.`);
        return res;
      };
      const want = (await (await get(assets.sha)).text()).trim().split(/\s+/)[0]!;
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(out, { recursive: true, force: true });
      // Streamed straight into the 0700 stage dir, hashed on the way, capped in size.
      const got = await saveCapped(await get(assets.zip), zipPath, this.o.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES);
      const sigText = (await (await get(assets.sig)).text()).trim();
      if (got !== want) throw new Error("The download didn't match its checksum.");
      // I7 + final secfix 11: a detached Ed25519 signature over "name|version|sha256", checked against the pinned key
      // BEFORE ditto or any swap — so an older signed zip can't be replayed under a newer tag or another asset name.
      // A tampered zip with a rewritten .sha256 passes the line above and fails here.
      verifyReleaseSignature({ name: assets.name, version, sha256: got, sig: sigText, publicKey: key });
      await (this.o.run ?? run)("ditto", ["-x", "-k", zipPath, out]);
      const staged = path.join(out, path.basename(this.o.appPath));
      // Final secfix item 11: the unpacked bundle must say it IS the tagged version.
      const bv = (this.o.bundleVersion ?? readBundleVersion)(staged);
      if (bv !== version) {
        fs.rmSync(out, { recursive: true, force: true });
        throw new Error(`The downloaded app says it is version ${bv || "unknown"}, not ${version}, so it wasn't installed.`);
      }
      await this.verify(staged, out);
      fs.rmSync(zipPath, { force: true });
      this.staged = staged;
      return this.set({ status: "ready", latest: version, error: null });
    } catch (e) {
      fs.rmSync(zipPath, { force: true });
      if (e instanceof TransientError) return this.quiet(e);
      return this.set({ status: "error", error: (e as Error).message });
    }
  }

  private async verify(staged: string, out: string): Promise<void> {
    try {
      await (this.o.verifySignature ?? ((s: string) => checkDesignatedRequirement({ current: this.o.appPath, staged: s })))(staged);
    } catch (e) {
      fs.rmSync(out, { recursive: true, force: true });
      throw e;
    }
  }

  /** The local folder: the manifest's checksum and Ed25519 signature, ditto, the bundle's own version, then the code signature. */
  private async downloadLocal(l: LocalRelease & { dir: string }): Promise<UpdateState> {
    const key = this.publicKey();
    if (!key) return this.set({ status: "not-configured", error: NOT_CONFIGURED });
    if (!newer(l.version, this.o.current)) return this.set({ status: "error", error: "That release isn't newer than this version, so it wasn't installed." });
    if (this.isSkipped(l.version)) return this.set({ status: "error", error: rolledBackMessage(l.version) });
    this.set({ status: "downloading" });
    this.staged = null;
    // The release folder is user-writable: copy the zip into the 0700 stage dir FIRST, then hash, verify and
    // unpack that copy, so a file swapped in after the check can't be what ditto unpacks.
    const zipPath = path.join(this.o.stageDir, `update-${l.version}.zip`);
    const out = path.join(this.o.stageDir, `update-${l.version}`);
    try {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(out, { recursive: true, force: true });
      const cap = this.o.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
      if (fs.statSync(path.join(l.dir, l.zip)).size > cap) throw tooLarge(cap);
      fs.copyFileSync(path.join(l.dir, l.zip), zipPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(zipPath, 0o600);
      const hash = crypto.createHash("sha256");
      for await (const c of fs.createReadStream(zipPath)) hash.update(c as Buffer);
      const got = hash.digest("hex");
      if (got !== l.sha256) throw new Error("The build in the release folder didn't match its checksum.");
      verifyReleaseSignature({ name: l.zip, version: l.version, sha256: got, sig: l.sig, publicKey: key });
      await (this.o.run ?? run)("ditto", ["-x", "-k", zipPath, out]);
      const staged = path.join(out, path.basename(this.o.appPath));
      const bv = (this.o.bundleVersion ?? readBundleVersion)(staged);
      if (bv !== l.version) {
        fs.rmSync(out, { recursive: true, force: true });
        throw new Error(`The build says it is version ${bv || "unknown"}, not ${l.version}, so it wasn't installed.`);
      }
      await this.verify(staged, out);
      fs.rmSync(zipPath, { force: true });
      this.staged = staged;
      return this.set({ status: "ready", latest: l.version, error: null });
    } catch (e) {
      fs.rmSync(zipPath, { force: true });
      return this.set({ status: "error", error: (e as Error).message });
    }
  }

  /** There is no paid Developer ID, so the app replaces its own bundle after quitting.
   *  I8: the script is fixed text; everything comes in as argv, never interpolated:
   *  $1 pid, $2 app, $3 staged, $4 health marker, $5 rollback note, $6 health timeout (s), $7 the version being installed
   *  (written into the rollback note, so the old build can skip it).
   *  The new bundle is copied next to the old one first, then two renames swap them, so there is
   *  never a moment without an app. The new build writes $4 once its window is up and its
   *  renderer loaded (launchHealth → markHealthy); if it doesn't within $6 seconds it is stopped and the old build goes back. */
  swapScript(): string {
    return [
      "#!/bin/sh",
      'pid="$1"; app="$2"; staged="$3"; marker="$4"; rolled="$5"; wait_s="${6:-60}"; ver="${7:-}"',
      'case "$ver" in *[!0-9A-Za-z.+-]*) ver="";; esac',
      'case "$pid" in ""|*[!0-9]*) exit 2;; esac',
      'case "$wait_s" in ""|*[!0-9]*) exit 2;; esac',
      '[ -n "$app" ] && [ -n "$staged" ] && [ -n "$marker" ] && [ -n "$rolled" ] || exit 2',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.3; done',
      'rm -f "$marker" "$rolled"',
      'rm -rf "$app.new" "$app.old"',
      'ditto "$staged" "$app.new" || { rm -rf "$app.new"; open "$app"; exit 1; }',
      'mv "$app" "$app.old" || { rm -rf "$app.new"; open "$app"; exit 1; }',
      'mv "$app.new" "$app" || { mv "$app.old" "$app"; open "$app"; exit 1; }',
      'xattr -dr com.apple.quarantine "$app"',
      'open "$app"',
      'i=0',
      'while [ "$i" -lt "$wait_s" ]; do [ -f "$marker" ] && break; sleep 1; i=$((i+1)); done',
      'if [ -f "$marker" ]; then rm -rf "$app.old"; exit 0; fi',
      'pkill -TERM -f "$app/Contents/MacOS/"; sleep 3; pkill -KILL -f "$app/Contents/MacOS/"',
      'rm -rf "$app.failed"; mv "$app" "$app.failed" && mv "$app.old" "$app" && rm -rf "$app.failed"',
      'printf \'{"rolledBackAt":%s,"version":"%s"}\\n\' "$(date +%s)" "$ver" > "$rolled"',
      'open "$app"',
      "exit 3",
    ].join("\n");
  }

  private markers(): { marker: string; rolled: string } {
    const dir = this.o.markerDir ?? this.o.stageDir;
    return { marker: path.join(dir, `healthy-${this.st.latest ?? "none"}`), rolled: path.join(dir, "rolled-back.json") };
  }

  swapArgs(pid: number, waitS = 60): string[] {
    const m = this.markers();
    return [String(Math.trunc(pid)), this.o.appPath, this.staged ?? "", m.marker, m.rolled, String(Math.trunc(waitS)), this.st.latest ?? ""];
  }

  restart(pid: number): void {
    if (this.st.status !== "ready" || !this.staged) return;
    const file = path.join(this.o.stageDir, "swap.sh");
    fs.writeFileSync(file, this.swapScript(), { mode: 0o755 });
    spawn("/bin/sh", [file, ...this.swapArgs(pid)], { detached: true, stdio: "ignore" }).unref();
  }

  private set(p: Partial<UpdateState>): UpdateState {
    this.st = { ...this.st, ...p, feed: this.o.feed() };
    this.o.emit(this.state());
    return this.state();
  }
}

/** Final secfix item 11: CFBundleShortVersionString from <app>/Contents/Info.plist (XML, or binary via plutil). */
export function readBundleVersion(app: string): string | null {
  const plist = path.join(app, "Contents", "Info.plist");
  let text: string;
  try {
    const raw = fs.readFileSync(plist);
    text = raw.subarray(0, 8).toString("latin1") === "bplist00"
      ? execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", plist], { encoding: "utf8", timeout: 10_000 })
      : raw.toString("utf8");
  } catch { return null; }
  const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/.exec(text);
  return m ? m[1]! : null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => spawn(cmd, args, { stdio: "ignore" }).on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`)))));
}

// `reg`'s handler param is typed `any` (matching native.ts's NativeHandler) rather than `never`:
// under strictFunctionTypes, `(a: never) => unknown` isn't assignable from `registerNative`'s own
// `(args: any) => unknown` parameter type, so `never` there would fail `npx tsc -p app`.
/** Where the new build says it started healthily and where a rollback is recorded (fixed per profile, unlike stageDir). */
export const updateMarkerDir = (userData: string) => path.join(userData, "updates");

/**
 * Called by the new build once its window is up and its renderer has loaded (launchHealth): the swap script is
 * waiting for this file and rolls back without it. Also returns (and clears) a rollback note the
 * swap script left, so the old build can say the update didn't take.
 */
export function markHealthy(userData: string, version: string): { rolledBack: boolean; version: string | null } {
  const dir = updateMarkerDir(userData);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `healthy-${version}`), `${Date.now()}\n`, { mode: 0o600 });
  const rolled = path.join(dir, "rolled-back.json");
  const rolledBack = fs.existsSync(rolled);
  const failed = rolledBack ? rolledBackVersion(rolled) : null;
  // The failed version stays skipped after the note is cleared (skippedVersion), until a newer one is out.
  if (failed) fs.writeFileSync(path.join(dir, "skip-version.json"), JSON.stringify({ version: failed }), { mode: 0o600 });
  fs.rmSync(rolled, { force: true });
  return { rolledBack, version: failed };
}

const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
function rolledBackVersion(file: string): string | null {
  try { const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }).version; return typeof v === "string" && VERSION_RE.test(v) ? v : null; } catch { return null; }
}
/** The version the swap script last rolled back (a pending note, or one markHealthy remembered); null for none. */
export function skippedVersion(userData: string): string | null {
  const dir = updateMarkerDir(userData);
  return rolledBackVersion(path.join(dir, "rolled-back.json")) ?? rolledBackVersion(path.join(dir, "skip-version.json"));
}
/** Stays on screen while the rolled-back version is the newest there is. */
export function rolledBackMessage(v: string | null): string {
  return v
    ? `Synapse ${v} didn't start correctly within a minute, so Synapse went back to this version. It won't be installed again; a newer version will be.`
    : "The last update didn't start correctly within a minute, so Synapse went back to this version.";
}

/**
 * One background check (launch, every 6 hours, and a retry after a rate limit). It always checks, so an update
 * is always shown; the Automatic Updates switch decides only whether it's downloaded and made ready by itself.
 */
export async function backgroundCheck(svc: Pick<UpdateService, "check" | "download">, auto: boolean): Promise<UpdateState> {
  const s = await svc.check();
  return s.status === "available" && auto ? svc.download() : s;
}

/**
 * When a freshly swapped-in build counts as healthy: its window is shown AND its renderer finished loading, in
 * either order, once per launch. Not the box: a slow Bots' computer used to get a good update rolled back
 * (code audit 2026-09-29 §7.2). A rollback the swap script left is reported to onRolledBack listeners.
 */
export function launchHealth(mark: () => { rolledBack: boolean; version?: string | null }) {
  let shown = false, loaded = false, done = false, rolled = false, failed: string | null = null;
  const waiting: ((version: string | null) => void)[] = [];
  const maybe = () => {
    if (done || !shown || !loaded) return;
    done = true;
    try { const m = mark(); rolled = m.rolledBack; failed = m.version ?? null; } catch (e) { console.error(`[updates] couldn't mark this build healthy: ${(e as Error).message}`); }
    if (rolled) for (const f of waiting.splice(0)) f(failed);
  };
  return {
    windowShown() { shown = true; maybe(); },
    rendererLoaded() { loaded = true; maybe(); },
    onRolledBack(cb: (version: string | null) => void) { if (rolled) cb(failed); else if (!done) waiting.push(cb); },
  };
}

export const defaultReleaseDir = () => path.join(os.homedir(), "Library", "Application Support", APP_DATA_NAME, "releases");

export function registerUpdater(o: { app: Electron.App; feed(): string | null; folder?(): string | null; setFolder?(dir: string | null): void; chooseFolder?(): Promise<string | null>; auto(): boolean; setAuto(on: boolean): void; token?(): string | null; setFeed?(feed: string): void; setToken?(token: string): void; hasToken?(): boolean }, reg: (name: string, fn: (a: any) => unknown) => void, emit: (ch: string, p: unknown) => void): UpdateService {
  const svc = new UpdateService({
    current: o.app.getVersion(), feed: o.feed, folder: o.folder, packaged: o.app.isPackaged, auto: o.auto(), token: o.token,
    appPath: path.resolve(o.app.getPath("exe"), "../../.."), stageDir: fs.mkdtempSync(path.join(os.tmpdir(), "synapse-update-")), emit: (s) => emit("updates", s),
    markerDir: updateMarkerDir(o.app.getPath("userData")), skipped: () => skippedVersion(o.app.getPath("userData")),
  });
  reg("updates.folder", () => ({ folder: o.folder?.() ?? null, defaultFolder: defaultReleaseDir() }));
  reg("updates.chooseFolder", async () => { const d = await o.chooseFolder?.(); if (d) o.setFolder?.(d); return { folder: o.folder?.() ?? null, defaultFolder: defaultReleaseDir() }; });
  reg("updates.resetFolder", () => { o.setFolder?.(null); return { folder: o.folder?.() ?? null, defaultFolder: defaultReleaseDir() }; });
  reg("updates.get", () => svc.state());
  reg("updates.setAuto", (a: { on: boolean }) => { o.setAuto(a.on); return svc.setAuto(a.on); });
  // I7: the feed (owner/repo) and the private-repo token: the profile's update-source.json (update-source.ts), never app-settings.json.
  // What the "Updates from GitHub" row shows: the repo, and whether a token is saved (never the token itself).
  reg("updates.source", () => ({ feed: o.feed(), hasToken: o.hasToken?.() ?? false }));
  reg("updates.setSource", (a: { feed?: string; token?: string }) => {
    if (a.feed !== undefined) {
      const f = String(a.feed).trim();
      if (f && !validFeed(f)) throw new Error("The update source must be owner/repo.");
      o.setFeed?.(f);
    }
    if (a.token !== undefined) o.setToken?.(String(a.token).trim());
    return svc.state();
  });
  reg("updates.restart", () => { svc.restart(process.pid); setTimeout(() => o.app.quit(), 200); return svc.state(); });
  // A network error or rate limit is quiet (no error line): check again once GitHub says it may, and
  // download only when auto-update is on (a manual check that hit a limit just checks again).
  reg("updates.download", async () => svc.download());
  let retry: ReturnType<typeof setTimeout> | null = null;
  const retryLater = () => {
    const ms = svc.retryAfterMs();
    if (ms === null || retry) return;
    retry = setTimeout(() => { retry = null; void (async () => { await backgroundCheck(svc, o.auto()); retryLater(); })(); }, ms);
    retry.unref?.();
  };
  reg("updates.check", async () => { const s = await svc.check(); const r = s.status === "available" ? await svc.download() : s; retryLater(); return r; });
  // Always checks (code audit 2026-09-29 §7.1): the switch only decides whether the update is also downloaded.
  const tick = async () => { await backgroundCheck(svc, o.auto()); retryLater(); };
  setInterval(() => void tick(), 6 * 3600_000).unref();
  void tick();
  return svc;
}
