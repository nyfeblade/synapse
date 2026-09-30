import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Exec } from "../box-provider";
import { ORB_LIMITS, orbCall } from "../orb-exec";
import type { BoxStep, StepContext } from "./provisioner";
import { listMachines, machineSize, type MachineInfo } from "./orb";

/**
 * 0.1.5 ready-made Bots' computer (docs/superpowers/specs/2026-09-29-ready-made-box-design.md). A new install downloads
 * a prebuilt image of a provisioned box instead of provisioning one from scratch, and imports it into OrbStack:
 *
 * - The manifest (box/image.json) ships inside the signed app. Its SHA-256 is the only thing trusted: the file is hashed
 *   before `orb import` sees it, whichever URL it came from (the manifest's, or SYNAPSE_BOX_IMAGE_URL for a mirror or a test).
 * - The download resumes (a .part file and an HTTP Range request) and retries; a mismatching file is deleted.
 * - The image carries no per-install secret or id (box/image-prep.sh strip, box/build-image.sh's leak check). After the
 *   import, image-prep.sh adopt refuses an image that holds any, gives this install its own machine id and marker, and
 *   enables the host; deploy then starts it, and it makes this install's own token and keys.
 * - Any failure (no image for this version, no disk, the network, a bad hash, OrbStack refusing, adopt refusing) removes
 *   what this step imported and falls back to the from-scratch steps, which run exactly as before.
 * - The provision step then finds the image's version already there and is skipped; deploy, the firewall and the
 *   host's own checks run as they always do.
 */
export interface ImageManifest {
  format: 1;
  imageVersion: string;
  hostBuild: string | null;
  arch: "arm64";
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The manifest bundled next to the box scripts, or null when there is none or it isn't well formed. */
export function readImageManifest(boxDir: string, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): ImageManifest | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(read(path.join(boxDir, "image.json"))) as Record<string, unknown>; } catch { return null; }
  const ok = j.format === 1 && typeof j.imageVersion === "string" && HEX16.test(j.imageVersion)
    && (j.hostBuild === null || (typeof j.hostBuild === "string" && HEX16.test(j.hostBuild)))
    && j.arch === "arm64" && typeof j.url === "string" && j.url.startsWith("https://")
    && typeof j.sha256 === "string" && HEX64.test(j.sha256)
    && Number.isSafeInteger(j.bytes) && (j.bytes as number) > 0 && Number.isSafeInteger(j.unpackedBytes) && (j.unpackedBytes as number) > 0;
  return ok ? (j as unknown as ImageManifest) : null;
}

/**
 * Where to fetch it: the manifest's https URL, or an override (a mirror, or a local file or server in a test). The
 * override needs no trust of its own: the hash is pinned either way. Plain http only to this Mac's own loopback.
 */
export function imageUrl(m: ImageManifest, override?: string | null): string | null {
  const u = override?.trim() || m.url;
  let p: URL;
  try { p = new URL(u); } catch { return null; }
  if (p.protocol === "https:" || p.protocol === "file:") return p.href;
  if (p.protocol === "http:" && (p.hostname === "127.0.0.1" || p.hostname === "localhost" || p.hostname === "[::1]")) return p.href;
  return null;
}

/** Room for the download, the imported machine next to it, and 2 GiB to spare. */
export function diskNeeded(m: ImageManifest, have = 0): number {
  return Math.max(0, m.bytes - have) + m.unpackedBytes + 2 * 1024 ** 3;
}

export async function sha256File(file: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    if (signal?.aborted) throw new Error("stopped");
    h.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return h.digest("hex");
}

/**
 * Downloads `url` into `part`, resuming what's already there (HTTP Range; a server that ignores it starts over).
 * `onBytes(total)` reports the bytes on disk. Retries a dropped connection `tries` times with a short backoff.
 */
export async function downloadResumable(o: {
  url: string; part: string; bytes: number; signal: AbortSignal; onBytes(total: number): void;
  fetchFn?: typeof fetch; tries?: number; backoffMs?: number;
}): Promise<void> {
  const tries = o.tries ?? 4;
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    if (o.signal.aborted) throw new Error("stopped");
    try {
      await downloadOnce(o);
      return;
    } catch (e) {
      last = e;
      if (o.signal.aborted || (e as { permanent?: boolean }).permanent) break;
      await new Promise((r) => setTimeout(r, (o.backoffMs ?? 1500) * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function permanent(msg: string): Error { return Object.assign(new Error(msg), { permanent: true }); }

async function downloadOnce(o: { url: string; part: string; bytes: number; signal: AbortSignal; onBytes(total: number): void; fetchFn?: typeof fetch }): Promise<void> {
  fs.mkdirSync(path.dirname(o.part), { recursive: true });
  let have = fs.existsSync(o.part) ? fs.statSync(o.part).size : 0;
  if (have > o.bytes) { fs.rmSync(o.part, { force: true }); have = 0; }
  if (have === o.bytes) { o.onBytes(have); return; }
  let body: AsyncIterable<Uint8Array>;
  if (o.url.startsWith("file:")) {
    const src = fileURLToPath(o.url);
    if (!fs.existsSync(src)) throw permanent(`no image at ${src}`);
    body = fs.createReadStream(src, { start: have, highWaterMark: 4 * 1024 * 1024, signal: o.signal }) as unknown as AsyncIterable<Uint8Array>;
  } else {
    const res = await (o.fetchFn ?? fetch)(o.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: o.signal, redirect: "follow" });
    if (res.status === 416 && have) { fs.rmSync(o.part, { force: true }); throw new Error("the server refused the resume; starting over"); }
    if (!res.ok || !res.body) {
      const e = new Error(`the image download answered HTTP ${res.status}`);
      if (res.status === 404 || res.status === 403 || res.status === 410) throw permanent(e.message);
      throw e;
    }
    if (have && res.status !== 206) have = 0; // the server ignored the range: start over
    body = res.body as unknown as AsyncIterable<Uint8Array>;
  }
  o.onBytes(have);
  const out = fs.createWriteStream(o.part, { flags: have ? "a" : "w" });
  let total = have;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > o.bytes) throw permanent("the image is bigger than the app expects");
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      o.onBytes(total);
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  const size = fs.statSync(o.part).size;
  if (size !== o.bytes) throw new Error(`the image download ended early (${size} of ${o.bytes} bytes)`);
}

export interface ImageStepDeps {
  exec: Exec;
  orb(): string;
  machine: string;
  boxDir: string;
  /** What the bundle provisions: the image is used only when it is exactly this version. */
  imageVersion(): string | null;
  /** userData/box-image: the download and the import marker. */
  cacheDir: string;
  /** Free bytes on the disk that holds cacheDir (null: unknown, then the step doesn't risk it). */
  freeBytes(): number | null;
  forgetPin(): void;
  mac: { cpus: number; totalMemBytes: number };
  /** SYNAPSE_BOX_IMAGE_URL: a mirror, or a local file or server in a test. "off" turns the fast path off. */
  urlOverride?: string | null;
  arch?: string;
  fetchFn?: typeof fetch;
  manifest?: () => ImageManifest | null;
  /** Streams image-prep.sh into the machine as root (`adopt VERSION`). */
  runPrep?: (args: string[]) => Promise<{ code: number; out: string }>;
  now?: () => number;
}

/** Stage keys the setup screen labels (one short word each). */
export type ImageStage = "download" | "verify" | "import" | "start";

/** What the step reports when it hands over to the from-scratch steps. */
export interface StepFallback { fallback: string }

/**
 * The "image" step: runs first. Done when the machine exists (then it never touches it) or when there is no image to
 * use; its work covers "create" and "provision" (the bar leaves them out while it runs). It never throws for anything
 * but a cancel: any failure cleans up and returns a fallback, and the from-scratch steps take over.
 */
export function imageStep(d: ImageStepDeps): BoxStep & { covers: ("create" | "provision")[] } {
  const marker = path.join(d.cacheDir, `importing-${d.machine}`);
  const manifest = () => (d.manifest ?? (() => readImageManifest(d.boxDir)))();
  const usable = (): ImageManifest | null => {
    if (d.urlOverride === "off") return null;
    if ((d.arch ?? process.arch) !== "arm64") return null;
    const m = manifest();
    const want = d.imageVersion();
    return m && want && m.imageVersion === want && imageUrl(m, d.urlOverride) ? m : null;
  };
  const find = async (): Promise<MachineInfo | undefined> => (await listMachines(d.exec, d.orb())).find((x) => x.name === d.machine);
  // Bug 435: every orb call is bounded (orb-exec.ts), killed with its process group on timeout, and retried only
  // when running it twice is safe. A timed-out import is never retried: it may have half-made the machine.
  const orb = async (args: string[], timeoutMs: number, what: string, idempotent: boolean) => {
    const r = await orbCall(d.exec, d.orb(), args, { timeoutMs, idempotent });
    if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r;
  };
  const runPrep = d.runPrep ?? ((args: string[]) => streamPrep(d.exec, d.orb(), d.machine, path.join(d.boxDir, "image-prep.sh"), args));
  /** Removes a machine only this step imported (the marker says so: the name was free when the import began). */
  const discard = async (ctx: StepContext) => {
    if (!fs.existsSync(marker)) return;
    if (await find()) {
      ctx.line(`image: removing the half-imported ${d.machine}`);
      await orbCall(d.exec, d.orb(), ["delete", "-f", d.machine], { timeoutMs: ORB_LIMITS.delete, idempotent: false });
    }
    if (!(await find())) fs.rmSync(marker, { force: true });
  };

  return {
    id: "image", label: "Downloading the Bots' computer", weight: 40, covers: ["create", "provision"],
    // An import left half-done by a quit is not "done": run() removes it and starts again.
    done: async () => !usable() || (!!(await find()) && !fs.existsSync(marker)),
    run: async (ctx): Promise<void | StepFallback> => {
      const m = usable();
      if (!m) return { fallback: "no ready-made image for this version" };
      const url = imageUrl(m, d.urlOverride)!;
      const file = path.join(d.cacheDir, `synapse-box-${m.imageVersion}-${m.sha256.slice(0, 12)}.tar.zst`);
      const part = `${file}.part`;
      const now = d.now ?? Date.now;
      const t0 = now();
      // Setting up from scratch next: the download is of no more use (only a cancel keeps it, to resume on Retry).
      const fall = async (why: string): Promise<StepFallback> => {
        ctx.line(`image: ${why}; setting up from scratch instead`);
        await discard(ctx).catch(() => {});
        fs.rmSync(part, { force: true });
        fs.rmSync(file, { force: true });
        return { fallback: why };
      };
      // A download for another version (an app updated mid-setup) is of no use.
      try {
        for (const n of fs.readdirSync(d.cacheDir)) {
          if (n.startsWith("synapse-box-") && n !== path.basename(file) && n !== path.basename(part)) fs.rmSync(path.join(d.cacheDir, n), { force: true });
        }
      } catch { /* no cache yet */ }
      try {
        await discard(ctx);
        if (await find()) return { fallback: "the machine already exists" };
        const have = fs.existsSync(file) ? m.bytes : fs.existsSync(part) ? fs.statSync(part).size : 0;
        const free = d.freeBytes();
        if (free === null || free < diskNeeded(m, have)) {
          return await fall(`not enough free disk for the ready-made image (${Math.round((free ?? 0) / 1e9)} GB free, ${Math.round(diskNeeded(m, have) / 1e9)} GB needed)`);
        }
        // Download: 0 .. 0.78 of this step.
        if (!fs.existsSync(file)) {
          ctx.stage?.("download");
          ctx.line(`image: downloading ${Math.round(m.bytes / 1e6)} MB${have ? ` (resuming at ${Math.round(have / 1e6)} MB)` : ""}`);
          let lastLine = 0;
          await downloadResumable({
            url, part, bytes: m.bytes, signal: ctx.signal, fetchFn: d.fetchFn,
            onBytes: (n) => {
              ctx.progress(0.78 * (n / m.bytes));
              if (n - lastLine > m.bytes / 10) { lastLine = n; ctx.line(`image: ${Math.round((100 * n) / m.bytes)}%`); }
            },
          });
          fs.renameSync(part, file);
        }
        // Verify: 0.78 .. 0.86. The pinned hash is the only trust: nothing unverified reaches OrbStack.
        ctx.stage?.("verify");
        let hashed = 0;
        const sum = await sha256File(file, (n) => { hashed += n; ctx.progress(0.78 + 0.08 * (hashed / m.bytes)); }, ctx.signal);
        if (sum !== m.sha256) return await fall("the downloaded image doesn't match the app's pinned SHA-256");
        ctx.line(`image: verified in ${Math.round((now() - t0) / 1000)} s`);
        // Import: 0.86 .. 0.95.
        ctx.stage?.("import");
        if (await find()) return { fallback: "the machine already exists" };
        fs.mkdirSync(d.cacheDir, { recursive: true });
        fs.writeFileSync(marker, `${now()}\n`);
        const ti = now();
        await orb(["import", "-n", d.machine, file], ORB_LIMITS.import, "OrbStack couldn't import the image", false);
        ctx.line(`image: imported in ${Math.round((now() - ti) / 1000)} s`);
        ctx.progress(0.95);
        // This Mac's size, and an isolated machine (the image says so too; set again, never assumed).
        const size = machineSize(d.mac);
        const diskBytes = Number.parseInt(size.disk, 10) * 1024 ** 3;
        for (const [k, v] of [["isolated", "true"], ["cpu", String(size.cpus)], ["memory_mib", String(size.memoryMib)], ["disk_bytes", String(diskBytes)]] as const) {
          await orb(["config", "set", `machine.${d.machine}.${k}`, v], ORB_LIMITS.config, "OrbStack couldn't size the machine", true);
        }
        const got = await find();
        if (!got?.isolated) return await fall("the imported machine isn't isolated");
        // Start and adopt: this install's own identity; refuses an image that carries anyone else's.
        ctx.stage?.("start");
        await orb(["start", d.machine], ORB_LIMITS.start, "The imported machine didn't start", true);
        const r = await runPrep(["adopt", m.imageVersion]);
        if (r.code !== 0) return await fall(`the imported machine was refused (${r.out.trim().split("\n").at(-1) ?? `exit ${r.code}`})`);
        d.forgetPin();
        fs.rmSync(marker, { force: true });
        fs.rmSync(file, { force: true });
        ctx.progress(1);
        ctx.line(`image: ready in ${Math.round((now() - t0) / 1000)} s`);
      } catch (e) {
        if (ctx.signal.aborted) { await discard(ctx).catch(() => {}); throw e; }
        return await fall((e as Error).message.split("\n")[0]!.slice(0, 300));
      }
    },
  };
}

/**
 * `orb -m MACHINE -u root bash -s ARGS < image-prep.sh`: the script goes over stdin, as provision-from-mac.sh does.
 * Bounded through orb-exec (bug 435); adopt is not safe to repeat (it writes the created marker), so no retry.
 */
async function streamPrep(exec: Exec, orb: string, machine: string, script: string, args: string[]): Promise<{ code: number; out: string }> {
  let stdin: Buffer;
  try { stdin = fs.readFileSync(script); } catch (e) { return { code: 1, out: (e as Error).message }; }
  const r = await orbCall(exec, orb, ["-m", machine, "-u", "root", "bash", "-s", ...args], { timeoutMs: ORB_LIMITS.adopt, idempotent: false, stdin });
  return { code: r.code, out: `${r.stdout}${r.stderr}`.slice(-4000) };
}
