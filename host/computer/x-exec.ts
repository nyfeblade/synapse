import { execFile } from "node:child_process";

export interface ExecResult { code: number; stdout: Buffer; stderr: string }
export type Exec = (file: string, args: string[], o?: { env?: Record<string, string>; timeoutMs?: number; input?: Buffer }) => Promise<ExecResult>;

const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";

export const execBuf: Exec = (file, args, o = {}) =>
  new Promise((resolve) => {
    const env = o.env ? { PATH: BASE_PATH, ...o.env } : process.env;
    const child = execFile(file, args, { env, timeout: o.timeoutMs ?? 30_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = err as (Error & { code?: unknown }) | null;
      const code = raw ? (typeof raw.code === "number" ? raw.code : 1) : 0;
      resolve({ code, stdout: stdout as Buffer, stderr: Buffer.from(stderr as Buffer).toString("utf8") });
    });
    if (o.input) child.stdin?.end(o.input);
  });

export interface XEnv { display: string; xauthority: string }

/** Runs X clients as bothost against a box display through its group-readable cookie (Decision 3). */
export class XRunner {
  constructor(private exec: Exec, readonly env: XEnv, private capture: "ffmpeg" | "import" = "ffmpeg") {}

  private xenv(): Record<string, string> {
    return { DISPLAY: this.env.display, XAUTHORITY: this.env.xauthority };
  }

  async xdotool(args: string[], timeoutMs = 10_000): Promise<string> {
    const r = await this.exec("xdotool", args, { env: this.xenv(), timeoutMs });
    if (r.code !== 0) throw new Error(`xdotool ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout.toString("utf8");
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const out = await this.xdotool(["getmouselocation", "--shell"]);
    const num = (k: string) => Number(new RegExp(`^${k}=(\\d+)`, "m").exec(out)?.[1] ?? NaN);
    return { x: num("X"), y: num("Y") };
  }

  /** `size`: scale the 1280×800 capture to this size (a computer subagent's view, host/computer/screen-view.ts). */
  async screenshotWebp(size?: { w: number; h: number }): Promise<Buffer> {
    const scaled = size && (size.w !== 1280 || size.h !== 800) ? size : null;
    const r = this.capture === "ffmpeg"
      ? await this.exec("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-video_size", "1280x800", "-i", this.env.display, "-frames:v", "1", ...(scaled ? ["-vf", `scale=${scaled.w}:${scaled.h}:flags=lanczos`] : []), "-c:v", "libwebp", "-quality", "80", "-f", "webp", "-"], { env: this.xenv(), timeoutMs: 15_000 })
      // `import` reads box's X display pixels directly (not via ffmpeg's x11grab or CDP), so it hits
      // the same cross-user MIT-SHM BadAccess class of bug the spike hit for x11vnc (S3-06 finding 5:
      // box-owned Xvfb + bothost-owned client => SysV/POSIX shared-memory attach fails). x11vnc's fix
      // was -noshm; ImageMagick's equivalent is -shared-memory False, which falls back to plain
      // XGetImage over the wire instead of attaching box's shared-memory pixmap.
      : await this.exec("sh", ["-c", `import -shared-memory False -window root png:- | convert png:-${scaled ? ` -resize ${scaled.w}x${scaled.h}!` : ""} -quality 80 webp:-`], { env: this.xenv(), timeoutMs: 15_000 });
    if (r.code !== 0 || r.stdout.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error(`screen capture failed: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }
}
