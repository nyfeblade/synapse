/**
 * mac-apps: the client for the warm `bots-mac` helper (app/native/macapp/MacApps.swift), in the same family as the
 * dictation one — one JSON object per line each way, stderr for diagnostics.
 *
 * WARM, because speed is the whole point. The process is spawned once, on the first action, and kept; it caches
 * compiled AppleScript/JXA, so the second Messages send pays no compile and no process start. Nothing here polls:
 * a request is a promise that settles when its id comes back, or when its own timeout fires.
 *
 * A helper that dies (crash, a Mac asleep, a missing binary) never wedges a Bot: every in-flight request is
 * settled with a plain sentence, and the next action starts a new one, with a backoff so a broken binary is not
 * respawned in a loop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

export type HelperCode = "permission" | "notfound" | "timeout" | "script" | "badrequest" | "unavailable";
export interface HelperOk { ok: true; [k: string]: unknown }
export interface HelperErr { ok: false; error: string; code: HelperCode }
export type HelperReply = HelperOk | HelperErr;

export interface HelperRequest { op: "ping" | "osa" | "ax" | "perms"; [k: string]: unknown }

const fail = (error: string, code: HelperCode = "unavailable"): HelperErr => ({ ok: false, error, code });

/** A helper that died this many times in a row is left alone for a while (a missing or unsigned binary). */
const MAX_STARTS = 3;
const COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class MacHelper {
  private child: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private waits = new Map<number, { settle(r: HelperReply): void; timer: NodeJS.Timeout }>();
  private starts = 0;
  private coolUntil = 0;
  private stderrTail: string[] = [];

  constructor(private d: {
    binary: string;
    log(line: string): void;
    now?(): number;
    spawnFn?: typeof spawn;
  }) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }

  /** Whether a helper is up right now (the Settings panel shows this; it never starts one to find out). */
  alive(): boolean { return !!this.child && !this.child.killed; }

  /** Start on demand. Returns null when the binary is missing or the helper keeps dying. */
  private ensure(): ChildProcess | null {
    if (this.child && !this.child.killed) return this.child;
    if (this.now() < this.coolUntil) return null;
    if (!fs.existsSync(this.d.binary)) return null;
    if (this.starts >= MAX_STARTS) { this.coolUntil = this.now() + COOLDOWN_MS; this.starts = 0; return null; }
    this.starts += 1;
    let c: ChildProcess;
    try {
      c = (this.d.spawnFn ?? spawn)(this.d.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.d.log(`macapp: the helper did not start (${(e as Error).message})`);
      return null;
    }
    this.child = c;
    this.buf = "";
    c.stdout?.setEncoding("utf8");
    c.stdout?.on("data", (d: string) => this.onData(d));
    c.stderr?.setEncoding("utf8");
    c.stderr?.on("data", (d: string) => {
      for (const l of String(d).split("\n")) if (l.trim()) this.stderrTail = [...this.stderrTail, l].slice(-20);
    });
    const gone = (why: string) => {
      if (this.child !== c) return;
      this.child = null;
      const tail = this.stderrTail.slice(-3).join(" · ");
      for (const [, w] of this.waits) w.settle(fail(`The Mac's app helper stopped${tail ? ` (${tail})` : ""}.`));
      this.waits.clear();
      this.d.log(`macapp: helper ${why}`);
    };
    c.on("error", (e) => gone(`error: ${e.message}`));
    c.on("exit", (code, sig) => gone(`exited (${code ?? sig})`));
    // A helper that started and answered is not a failing one: the counter resets on the first good reply.
    return c;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { id?: unknown };
      try { msg = JSON.parse(line) as { id?: unknown }; } catch { this.d.log(`macapp: unreadable helper line (${line.slice(0, 80)})`); continue; }
      const id = typeof msg.id === "number" ? msg.id : -1;
      const w = this.waits.get(id);
      if (!w) continue;
      this.waits.delete(id);
      this.starts = 0;
      w.settle(normalize(msg));
    }
  }

  /** One request. Always settles: on a reply, on the timeout, or when the helper goes away. */
  request(req: HelperRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HelperReply> {
    const c = this.ensure();
    if (!c?.stdin?.writable) return Promise.resolve(fail("The Mac's app helper isn't available on this computer."));
    const id = ++this.seq;
    return new Promise<HelperReply>((resolve) => {
      let done = false;
      const settle = (r: HelperReply) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      // The helper's own timeout is the script's; this one is the transport's, a little longer, so a helper that
      // answers late is still heard and only a helper that never answers is called stuck.
      const timer = setTimeout(() => { this.waits.delete(id); settle(fail("The Mac's app helper didn't answer in time.", "timeout")); }, timeoutMs + 2_000);
      timer.unref?.();
      this.waits.set(id, { settle, timer });
      try {
        // JSON.stringify escapes every newline, so a request is always exactly one stdin line.
        c.stdin!.write(`${JSON.stringify({ ...req, id })}\n`);
      } catch (e) {
        this.waits.delete(id);
        settle(fail(`The Mac's app helper didn't take the request (${(e as Error).message}).`));
      }
    });
  }

  /** Start it (and pay the launch cost) before the first action needs it. */
  async warm(): Promise<boolean> {
    const r = await this.request({ op: "ping" }, 5_000);
    return r.ok;
  }

  close(): void {
    const c = this.child;
    this.child = null;
    for (const [, w] of this.waits) w.settle(fail("The Mac's app helper was shut down."));
    this.waits.clear();
    if (!c) return;
    try { c.stdin?.end(); } catch { /* already gone */ }
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 1_000);
    t.unref?.();
    c.on("exit", () => clearTimeout(t));
  }
}

const CODES: HelperCode[] = ["permission", "notfound", "timeout", "script", "badrequest", "unavailable"];

/** Trust nothing off the wire: a reply is shaped here or it is an error. */
export function normalize(msg: Record<string, unknown>): HelperReply {
  if (msg.ok === true) return msg as HelperOk;
  const error = typeof msg.error === "string" && msg.error.trim() ? msg.error : "The Mac couldn't do that.";
  const code = CODES.includes(msg.code as HelperCode) ? (msg.code as HelperCode) : "script";
  return { ok: false, error, code };
}
