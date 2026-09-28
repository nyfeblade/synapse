import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITS5, type LocalComputer, type LocalExecRequest } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { SseHub } from "../gateway/sse-hub";
import { GIT_CONTROL_PATH, SECURITY_PATH } from "../review/static";

export interface LocalExecResult { exitCode: number | null; result?: string; error?: string; output: string }
interface Pending { req: LocalExecRequest; output: string; resolve(r: LocalExecResult): void; onOutput?(c: string): void; lastActivity: number; running: boolean; result: LocalExecResult | null }

/** Ops that must answer promptly: a read or a copy has no "still running" affordance, so the Bot's
 *  tool call blocks on it outright. A shell command is excluded — it may legitimately be quiet for
 *  hours, and ExternalShell hands the Bot a shell_id instead of blocking. */
const BOUNDED: LocalExecRequest["op"][] = ["read-file", "list-directory", "write-file", "copy-to-box", "copy-from-box", "browser", "mac-app"];
const STUCK_MS = 10 * 60_000;

export class LocalBridge {
  private comp: LocalComputer | null = null;
  private lastBeat = 0;
  /** False for a Mac restored from the file until this process hears from it. */
  private heard = false;
  /** False for a Mac restored from the file until it registers with this process (its policy copy may be stale). */
  private fresh = false;
  private pending = new Map<string, Pending>();
  /** Ruling (b): revoke-grants messages stay queued for the Mac's heartbeat until it acks them (no idle watchdog). */
  private revokes = new Map<string, LocalExecRequest>();

  /** `file`: bug-log 129. The last registered Mac is remembered across host restarts. The desktop app registers only
   *  when it connects, so a host restarted under a running app used to forget the Mac until Synapse was relaunched, and
   *  every Bot spawned in between got no Mac tools. Restored, the Mac is known but not available until it heartbeats. */
  constructor(private d: { hub: SseHub; now(): number; workspace: string; livenessMs?: number; idleMs?: number; stuckMs?: number; file?: string }) {
    this.comp = this.load();
  }

  register(c: LocalComputer): void { this.comp = c; this.lastBeat = this.d.now(); this.heard = true; this.fresh = true; this.save(); }
  /** The last Mac that registered with this host (possibly in an earlier process); null only if none ever did. */
  computer(): LocalComputer | null { return this.comp; }
  available(): boolean { return !!this.comp && this.heard && this.d.now() - this.lastBeat <= (this.d.livenessMs ?? LIMITS5.localLivenessMs); }

  /** `register: true` asks a computer to register again when the host doesn't know it, or knows it only from the file
   *  (a policy change made while the host was down never arrived). A restored Mac's heartbeat still makes it
   *  available, so an app that predates the flag keeps working; the Mac re-checks its own policy on every request. */
  heartbeat(computerId: string): { pending: LocalExecRequest[]; register?: true } {
    const known = !!this.comp && this.comp.computerId === computerId;
    if (known) { this.lastBeat = this.d.now(); this.heard = true; }
    const pending = [...[...this.pending.values()].filter((p) => p.running && p.output === "").map((p) => p.req), ...this.revokes.values()];
    return known && this.fresh ? { pending } : { pending, register: true };
  }

  private save(): void {
    if (!this.d.file) return;
    try {
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ computer: this.comp }), { mode: 0o600 });
      fs.renameSync(tmp, this.d.file);
    } catch { /* best effort: this process still knows the Mac */ }
  }

  private load(): LocalComputer | null {
    if (!this.d.file) return null;
    try {
      const c = (JSON.parse(fs.readFileSync(this.d.file, "utf8")) as { computer?: LocalComputer }).computer;
      return c && typeof c.computerId === "string" && typeof c.label === "string" && typeof c.localRoot === "string" && typeof c.executionPolicy === "string" ? c : null;
    } catch { return null; }
  }

  request(req: Omit<LocalExecRequest, "execId">, o: { onOutput?(chunk: string): void } = {}): { execId: string; done: Promise<LocalExecResult> } {
    const execId = `lx_${randomUUID()}`;
    const full: LocalExecRequest = { ...req, execId };
    const done = new Promise<LocalExecResult>((resolve) => {
      this.pending.set(execId, { req: full, output: "", resolve, onOutput: o.onOutput, lastActivity: this.d.now(), running: true, result: null });
    });
    this.d.hub.publish({ channel: "local-exec", payload: full });
    this.watch(execId);
    return { execId, done };
  }

  output(execId: string, _stream: "stdout" | "stderr", chunk: string): void {
    const p = this.pending.get(execId);
    if (!p) return;
    p.output = (p.output + chunk).slice(-LIMITS5.localOutputMaxChars);
    p.lastActivity = this.d.now();
    p.onOutput?.(chunk);
  }

  done(execId: string, a: { exitCode: number | null; result?: string; error?: string }): void {
    if (this.revokes.delete(execId)) return;
    const p = this.pending.get(execId);
    if (!p || !p.running) return; // a late duplicate never overwrites the answer the Bot already has
    p.running = false;
    p.result = { exitCode: a.exitCode, output: p.output, ...(a.result !== undefined ? { result: a.result } : {}), ...(a.error ? { error: a.error } : {}) };
    p.resolve(p.result);
    setTimeout(() => this.pending.delete(execId), 60_000).unref?.();
  }

  /** Scoped by the requesting botId so one Bot can't poll another Bot's execId (e.g. copied into shared workspace files/memory) for its shell output/result. */
  outputSoFar(execId: string, botId: string): string {
    const p = this.pending.get(execId);
    return p && p.req.botId === botId ? p.output : "";
  }
  isRunning(execId: string, botId: string): boolean {
    const p = this.pending.get(execId);
    return !!p && p.req.botId === botId && p.running;
  }
  result(execId: string, botId: string): LocalExecResult | null {
    const p = this.pending.get(execId);
    return p && p.req.botId === botId ? p.result : null;
  }

  upload(execId: string, offset: number, bytesBase64: string, _final: boolean): void {
    const p = this.pending.get(execId);
    if (!p || p.req.op !== "copy-to-box") throw new GatewayError("NOT_FOUND", "No copy in progress.", 404);
    const dest = this.inWorkspace(p.req.boxPath ?? "");
    // P5 review I2: the F8 floor holds here too — a copy never lands on a git control file or a security control.
    if (GIT_CONTROL_PATH.test(dest) || SECURITY_PATH.test(dest)) throw new GatewayError("PROTECTED_PATH", "That box path is a protected control file.");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const fd = fs.openSync(dest, offset === 0 ? "w" : "r+");
    try { fs.writeSync(fd, Buffer.from(bytesBase64, "base64"), 0, undefined, offset); } finally { fs.closeSync(fd); }
    p.lastActivity = this.d.now();
  }

  readWorkspaceFile(p: string, offset: number, length: number): { bytesBase64: string; eof: boolean; size: number } {
    const file = this.inWorkspace(p);
    const size = fs.statSync(file).size;
    if (size > LIMITS5.localFileMaxBytes) throw new GatewayError("TOO_LARGE", "Files over 100 MiB can't be copied.");
    const len = Math.max(0, Math.min(length, LIMITS5.localChunkBytes, size - offset));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    return { bytesBase64: buf.toString("base64"), eof: offset + len >= size, size };
  }

  /** Lexically AND physically inside the workspace: the deepest existing ancestor is realpath'd (a Bot-made
   *  symlink can't carry a host-side read or write out of it), and the target itself must not be a symlink. */
  private inWorkspace(p: string): string {
    const outside = () => new GatewayError("OUTSIDE_WORKSPACE", "Box paths must be inside the workspace.");
    const inside = (root: string, x: string) => x === root || x.startsWith(root + path.sep);
    const abs = path.resolve(this.d.workspace, p);
    if (!inside(this.d.workspace, abs)) throw outside();
    const root = fs.realpathSync(this.d.workspace);
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    if (!inside(root, fs.realpathSync(probe))) throw outside();
    if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw outside();
    return abs;
  }

  /** I12: a deleted Bot's running Mac execs are killed on the Mac and end here as deleted. */
  cancelBot(botId: string): void {
    for (const [execId, p] of this.pending) {
      if (p.req.botId !== botId || !p.running) continue;
      this.d.hub.publish({ channel: "local-exec", payload: { execId: `lx_${randomUUID()}`, botId, approvalId: null, op: "kill", command: execId } });
      this.done(execId, { exitCode: null, error: "The Bot was deleted." });
    }
  }

  /** Ruling (b): tell the Mac to drop every per-Bot "Always" grant of a deleted Bot (its grants file). */
  revokeGrants(botId: string): void {
    const req: LocalExecRequest = { execId: `lx_${randomUUID()}`, botId, approvalId: null, op: "revoke-grants" };
    this.revokes.set(req.execId, req);
    this.d.hub.publish({ channel: "local-exec", payload: req });
  }

  /** LOC-06 exec idle watchdog: 10 s with no output while the Mac stopped heartbeating → "unavailable". */
  private watch(execId: string): void {
    const t = setInterval(() => {
      const p = this.pending.get(execId);
      if (!p || !p.running) return clearInterval(t);
      const quietFor = this.d.now() - p.lastActivity;
      if (!this.available() && quietFor >= (this.d.idleMs ?? LIMITS5.localExecIdleWatchdogMs)) {
        clearInterval(t);
        this.done(execId, { exitCode: null, error: `unavailable:${this.comp?.label ?? "this computer"}` });
        return;
      }
      // A delivered request the Mac never answers is stuck whether or not it is still heartbeating
      // (an app restart mid-exec: the relaunched daemon sees the id as already delivered). Without
      // this the tool call never returns and the Bot stays `running` for the host's lifetime.
      if (BOUNDED.includes(p.req.op) && quietFor >= (this.d.stuckMs ?? STUCK_MS)) {
        clearInterval(t);
        this.done(execId, { exitCode: null, error: `The Mac didn't answer this ${p.req.op} in time.` });
      }
    }, Math.min(1000, this.d.idleMs ?? 1000));
    t.unref?.();
  }
}
