import fs from "node:fs";
import path from "node:path";
import { LIMITSC, formatDuration, type AsyncTaskView } from "@synapse/shared";
import { buildBotEnv } from "../brain/spawn-options";
import type { BotToolResult } from "../brain/types";
import type { HostConfig } from "../config";
import type { SseHub } from "../gateway/sse-hub";
import { fillTemplate, loadPrompt } from "../prompts";
import type { HiddenSpec } from "../runner/turn-runner";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import type { PendingWakes } from "./pending-wakes";
import type { Revivals } from "./revivals";
import type { ShellSpawner } from "./shell-spawner";
import { botOsUser } from "../walls/bot-uid";

export interface ShellArgs { command: string; working_directory?: string; block_until_ms?: number; description?: string; notify_on_output?: { pattern: string; reason: string; debounce_ms?: number } }
export interface ShellServiceDeps {
  cfg: HostConfig; spawner: ShellSpawner; pending: PendingWakes; revivals: Pick<Revivals, "complete">; hub: SseHub;
  /** C1: the Shell env is always built by buildBotEnv from these inputs (no token, git pins last). */
  /** Bug 195 S2: a Shell is starting for this Bot (a pending GitHub sign-in is cancelled). */
  onWork?(botId: string): void;
  /** Bug 231 round 1: real paths inside the Bot's home, resolved as the Bot (null = unavailable). */
  realAsBot?(botId: string, paths: string[]): Promise<(string | null)[] | null>;
  envInputs(botId: string): { secrets?: Record<string, string>; display?: Record<string, string> }; enqueueHidden(botId: string, spec: HiddenSpec): void; now?(): number; pollMs?: number;
}
interface Rec {
  id: string; botId: string; command: string; startedAt: number; status: AsyncTaskView["status"]; endedAt: number | null;
  background: boolean; awaited: boolean; blocking: boolean; notify: { re: RegExp; reason: string; debounceMs: number; lastAt: number; offset: number } | null;
  cwdKey?: string;
}
type Footer = { exitCode: number; elapsedMs: number; endedAt: number; cwd: string };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };

/**
 * A real path as bothost sees it. A folder that doesn't exist keeps its text (nothing can run there: the Shell's
 * `cd -P` fails), but one bothost may not enter (EACCES: inside a Bot's 0700 home) is unverifiable, never its raw text.
 */
function realOf(p: string): { real: string; verified: boolean } {
  try { return { real: fs.realpathSync(p), verified: true }; } catch (e) {
    return { real: p, verified: (e as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

/** Bug 231 round 1: resolves a path inside a Bot's home as the Bot (bot-fs-query): the real path, null = unverifiable,
 *  undefined = not a path it answers for (plain fs). */
export type RealResolver = (p: string) => string | null | undefined;

/** Item 3: the real path (symlinks resolved), spelled under the configured workspace when it lies inside it. */
export function canonicalPathInfo(workspace: string, p: string, resolve?: RealResolver): { path: string; verified: boolean } {
  const viaBot = resolve?.(p);
  const { real, verified } = viaBot === undefined ? realOf(p) : viaBot === null ? { real: p, verified: false } : { real: viaBot, verified: true };
  const ws = realOr(workspace);
  if (real === ws) return { path: workspace, verified };
  return { path: real.startsWith(`${ws}/`) ? path.join(workspace, real.slice(ws.length + 1)) : real, verified };
}
export function canonicalPath(workspace: string, p: string, resolve?: RealResolver): string {
  return canonicalPathInfo(workspace, p, resolve).path;
}

/**
 * I2 + item 3: the directory a Shell call runs in — working_directory (relative to the workspace) ?? the last
 * cwd ?? the workspace — canonicalized (realpath), so review, the TOCTOU recheck and the run all see the same
 * real directory. Auto-review uses the same value.
 */
export function resolveShellCwd(workspace: string, workingDirectory: unknown, lastCwd: string | null | undefined, home?: string | null, resolve?: RealResolver): string {
  return resolveShellCwdInfo(workspace, workingDirectory, lastCwd, home, resolve).path;
}
/** The folder a Shell call runs in, before it is canonicalized (what a resolver is asked about). */
export function rawShellCwd(workspace: string, workingDirectory: unknown, lastCwd: string | null | undefined, home?: string | null): string {
  return typeof workingDirectory === "string" && workingDirectory.trim() ? path.resolve(workspace, expandHome(workingDirectory, home)) : lastCwd ?? workspace;
}
export function resolveShellCwdInfo(workspace: string, workingDirectory: unknown, lastCwd: string | null | undefined, home?: string | null, resolve?: RealResolver): { path: string; verified: boolean } {
  return canonicalPathInfo(workspace, rawShellCwd(workspace, workingDirectory, lastCwd, home), resolve);
}

/** Bug 231: `~` and `~/…` in a working_directory are the Bot's home, as its shell reads them (its projects are in ~/code). */
export function expandHome(dir: string, home: string | null | undefined): string {
  if (!home) return dir;
  return dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;
}

/** The HOME a Bot's Shell runs with (buildBotEnv): its own account's home once migrated, else box's. */
export function shellHome(cfg: Pick<HostConfig, "perBotUid" | "boxHome" | "botHomes">, botId: string): string {
  return botOsUser(cfg, botId)?.home ?? cfg.boxHome;
}

/**
 * Bug #66 follow-up: where a Bot's Shell transcript lives. Once the box runs per-Bot accounts it is private to the
 * Bot: /workspace/.host-out/terminals/<botId>/ is bothost:<the Bot's group> 2750 (bot-user ensure), the host writes the
 * header 0640, and systemd appends the unit's output as root (StandardOutput=append:), so the Bot's own uid never
 * needs write access and no other Bot can read it. Before that: the shared /workspace/.bot/terminals, as ever.
 */
export function terminalDirFor(cfg: HostConfig, botId: string): string {
  return botOsUser(cfg, botId) ? path.join(cfg.workspace, ".host-out", "terminals", botId) : path.join(cfg.workspace, ".bot", "terminals");
}
export function terminalFileFor(cfg: HostConfig, botId: string, id: string): string {
  return path.join(terminalDirFor(cfg, botId), `${id}.txt`);
}

/** Item 5: a terminal file is created fresh (O_EXCL, O_NOFOLLOW); a name the box pre-planted (a symlink) is unlinked, never followed. */
export function createTerminalFile(file: string, mode: number, text: string): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(file, flags, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    fs.unlinkSync(file);
    fd = fs.openSync(file, flags, mode);
  }
  try {
    fs.fchmodSync(fd, mode);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/** Item 4: a child subagent's Shell keeps its own last cwd. */
const cwdKey = (botId: string, childId?: string) => (childId ? `${botId}\u0000${childId}` : botId);

/** The bot-shell EnvironmentFile (systemd) text. Only well-formed names are written; others are dropped. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join("\n") + "\n";
}

export function parseTerminal(text: string): { header: Record<string, string>; body: string; footer: Footer | null } {
  const header: Record<string, string> = {};
  let rest = text;
  const h = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (h) {
    for (const line of h[1]!.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) header[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    rest = text.slice(h[0].length);
  }
  const f = /\n---\nexit_code: (-?\d+)\nelapsed_ms: (\d+)\nended_at: (\d+)\ncwd: (.*)\n---\n$/.exec(rest);
  if (!f) return { header, body: rest, footer: null };
  return { header, body: rest.slice(0, f.index), footer: { exitCode: Number(f[1]), elapsedMs: Number(f[2]), endedAt: Number(f[3]), cwd: f[4]! } };
}

/** TOOL-11: the Shell tool — terminal files, background after block_until_ms, revivals, notify_on_output, rewatch. */
export class ShellService {
  private recs = new Map<string, Rec>();
  private lastCwd = new Map<string, string>();
  private retired = new Set<string>(); // I6: deleted Bots never start another shell
  private starting = new Map<string, Promise<unknown>>(); // item 6: in-flight spawner starts, by task id
  private now: () => number;
  private terminals: string;
  private runDir: string;
  private seqFile: string;

  constructor(private d: ShellServiceDeps) {
    this.now = d.now ?? Date.now;
    this.terminals = path.join(d.cfg.workspace, ".bot", "terminals");
    this.runDir = path.join(d.cfg.hostPrivate, "run");
    this.seqFile = path.join(d.cfg.hostPrivate, "shell-seq.json");
  }

  /** I2: the cwd the next Shell call without a working_directory starts in (null = the workspace). */
  lastCwdFor(botId: string, childId?: string): string | null {
    return this.lastCwd.get(cwdKey(botId, childId)) ?? null;
  }

  /** C1: the one env builder; a Shell never gets the OAuth token and always gets the git pins. */
  env(botId: string): Record<string, string> {
    return buildBotEnv({ cfg: this.d.cfg, botId, ...this.d.envInputs(botId) });
  }

  private nextId(): string {
    const s = readJson<{ n: number }>(this.seqFile, { n: 0 });
    s.n += 1;
    writeJsonAtomic(this.seqFile, s);
    return `shell-${s.n}`;
  }

  private file(id: string, botId = this.recs.get(id)?.botId): string {
    return botId ? terminalFileFor(this.d.cfg, botId, id) : path.join(this.terminals, `${id}.txt`);
  }

  private read(id: string, botId?: string) {
    try {
      return parseTerminal(fs.readFileSync(this.file(id, botId), "utf8"));
    } catch {
      return { header: {}, body: "", footer: null };
    }
  }

  private tail(body: string, id: string): string {
    const max = LIMITSC.shellOutputReturnChars;
    return body.length > max ? `…[earlier output truncated; full output in ${this.file(id)}]\n${body.slice(-max)}` : body;
  }

  private publish(botId: string): void {
    this.d.hub.publish({ channel: "async-tasks", payload: { botId, tasks: this.list(botId) } });
  }

  list(botId: string): AsyncTaskView[] {
    return [...this.recs.values()].filter((r) => r.botId === botId && r.background).map((r) => ({
      id: r.id, kind: "shell", botId, type: "shell", title: r.command.slice(0, 80), status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
    }));
  }

  /** Item 5: the terminal file is created fresh; a name the box pre-planted (a symlink) is unlinked, never followed. */
  private createTerminal(id: string, botId: string, text: string): void {
    createTerminalFile(this.file(id, botId), botOsUser(this.d.cfg, botId) ? 0o640 : 0o664, text); // bug #66: readable by the Bot's group, never writable
  }

  async run(botId: string, a: ShellArgs, o: { childId?: string } = {}): Promise<BotToolResult> {
    if (this.retired.has(botId)) return { text: "This Bot was deleted.", isError: true };
    const command = String(a.command ?? "");
    if (!command.trim()) return { text: "command is required.", isError: true };
    const key = cwdKey(botId, o.childId);
    const home = shellHome(this.d.cfg, botId);
    // Bug 231 round 1: a folder inside the Bot's own home is resolved AS the Bot (bothost can't enter it); one that
    // can't be resolved is refused, never run under its unchecked text.
    const raw = rawShellCwd(this.d.cfg.workspace, a.working_directory, this.lastCwd.get(key), home);
    let viaBot: string | null | undefined;
    if (this.d.realAsBot && botOsUser(this.d.cfg, botId) && raw.startsWith(`${home}/`)) viaBot = (await this.d.realAsBot(botId, [raw]))?.[0] ?? null;
    const { path: cwd, verified } = resolveShellCwdInfo(this.d.cfg.workspace, a.working_directory, this.lastCwd.get(key), home, (p) => (p === raw ? viaBot : undefined));
    if (!verified) return { text: `Not run: couldn't check the folder ${raw}. Use a folder that exists and that you can open.`, isError: true };
    // Item 4: Auto-review pins the canonical cwd into the call; a directory that resolves elsewhere now (a symlink
    // swapped in, or a non-canonical path) is not the one that was reviewed.
    if (typeof a.working_directory === "string" && a.working_directory.trim() && path.resolve(this.d.cfg.workspace, expandHome(a.working_directory, home)) !== cwd) {
      return { text: `Not run: ${a.working_directory} resolves to ${cwd}. Use the real directory as working_directory.`, isError: true };
    }
    const priv = !!botOsUser(this.d.cfg, botId);
    // Bug #66: bot-user ensure made the private dir with the Bot's group; if it is missing, 0750 fails safe (unreadable).
    fs.mkdirSync(terminalDirFor(this.d.cfg, botId), { recursive: true, mode: priv ? 0o750 : 0o2775 });
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const id = this.nextId();
    const t = this.now();
    this.createTerminal(id, botId, `---\npid: \ncwd: ${cwd}\ncommand: ${JSON.stringify(command)}\nstatus: running\nstarted_at: ${new Date(t).toISOString()}\n---\n`);
    // Item 3: cd -P into the reviewed directory and stop unless it is still the same real directory (no fallback).
    const real = realOr(cwd);
    const moved = "echo \"Shell: the working directory changed since it was reviewed; nothing ran.\" >&2; exit 97";
    const script = `cd -P -- ${q(cwd)} || { ${moved}; }\n[ "$(pwd -P)" = ${q(real)} ] || { ${moved}; }\n${command}\n__bot_ec=$?\nprintf '%s' "$(pwd -P)" > ${priv ? '"${BOT_SHELL_CWD_FILE:-/dev/null}"' : q(path.join(this.terminals, `${id}.cwd`))}\nexit $__bot_ec\n`;
    // Item 5: the script lives in the host-private run dir (0700), never in the box-writable terminals dir.
    const scriptFile = path.join(this.runDir, `${id}.sh`);
    const envFile = path.join(this.runDir, `${id}.env`);
    if (this.retired.has(botId)) return { text: "This Bot was deleted.", isError: true }; // deleted while we prepared
    fs.writeFileSync(scriptFile, script, { mode: 0o600 });
    fs.writeFileSync(envFile, envFileText(this.env(botId)), { mode: 0o600 });
    this.d.onWork?.(botId);
    const n = a.notify_on_output;
    const rec: Rec = {
      id, botId, command, startedAt: t, status: "running", endedAt: null, background: false, awaited: false, blocking: false, cwdKey: key,
      notify: n ? { re: new RegExp(n.pattern), reason: n.reason, debounceMs: Math.max(LIMITSC.shellNotifyDebounceMinMs, n.debounce_ms ?? 0), lastAt: 0, offset: 0 } : null,
    };
    this.recs.set(id, rec);
    this.d.pending.add({ kind: "shell", botId, taskId: id });
    const account = botOsUser(this.d.cfg, botId)?.name; // bug #66: the Bot's own account once migrated
    const start = account ? this.d.spawner.start(id, cwd, account, botId) : this.d.spawner.start(id, cwd);
    this.starting.set(id, start.catch(() => {}));
    try {
      await start;
    } finally {
      this.starting.delete(id);
      fs.rmSync(envFile, { force: true });
      fs.rmSync(scriptFile, { force: true });
    }
    // Item 6: deleted while the unit was starting — stop it (forgetBot waited for this start).
    if (this.retired.has(botId)) {
      if (this.recs.delete(id)) await this.d.spawner.stop(id).catch(() => {}); // unless forgetBot already stopped it
      this.d.pending.remove(id);
      return { text: "This Bot was deleted.", isError: true };
    }
    const block = a.block_until_ms ?? LIMITSC.shellDefaultBlockMs;
    // run() owns this record's completion while it blocks: tick() must not finish it and fire a
    // second, hidden "shell-done" revival for a command the Bot is about to be handed as a result.
    rec.blocking = block > 0;
    let f: Awaited<ReturnType<ShellService["waitFor"]>> = null;
    try {
      if (block > 0) f = await this.waitFor(id, block);
    } finally {
      rec.blocking = false;
    }
    if (f) {
      this.finish(rec, f.footer as Footer);
      this.d.pending.remove(id);
      // A non-zero exit code is a result, not a tool error.
      return { text: `${this.tail(f.body, id)}\n[exit code ${f.footer!.exitCode} · ${formatDuration(f.footer!.elapsedMs)} · cwd ${f.footer!.cwd}]` };
    }
    rec.background = true;
    this.publish(botId);
    const secs = Math.round(block / 1000);
    return { text: `${block > 0 ? `Still running after ${secs} s, so the command was moved to the background` : "Started in the background"} (task ${id}). Output streams to ${this.file(id)}. You'll be revived when it finishes; use AwaitShell to wait for it or to watch for a pattern.` };
  }

  private async waitFor(id: string, ms: number, pattern?: RegExp): Promise<ReturnType<ShellService["read"]> & { matched?: boolean } | null> {
    const until = this.now() + ms;
    for (;;) {
      const r = this.read(id);
      if (r.footer) return r;
      if (pattern && pattern.test(r.body)) return { ...r, matched: true };
      if (this.now() >= until) return null;
      await new Promise((res) => setTimeout(res, this.d.pollMs ?? 200));
    }
  }

  private finish(rec: Rec, f: Footer): void {
    rec.status = f.exitCode === 0 ? "done" : "error";
    rec.endedAt = f.endedAt;
    if (!this.retired.has(rec.botId)) this.lastCwd.set(rec.cwdKey ?? rec.botId, f.cwd);
  }

  async await(botId: string, a: { task_id: string; block_until_ms?: number; pattern?: string }): Promise<BotToolResult> {
    const rec = this.recs.get(a.task_id);
    if (!rec || rec.botId !== botId) return { text: `No background command ${a.task_id}.`, isError: true };
    const r = await this.waitFor(a.task_id, a.block_until_ms ?? LIMITSC.shellDefaultBlockMs, a.pattern ? new RegExp(a.pattern) : undefined);
    if (!r) return { text: `${a.task_id} is still running.\n${this.tail(this.read(a.task_id).body, a.task_id)}` };
    if (r.footer) {
      this.finish(rec, r.footer);
      rec.awaited = true;
      this.d.pending.remove(a.task_id);
      this.publish(botId);
      return { text: `${this.tail(r.body, a.task_id)}\n[${a.task_id} finished · exit code ${r.footer.exitCode} · ${formatDuration(r.footer.elapsedMs)}]` };
    }
    return { text: `Pattern matched; ${a.task_id} is still running.\n${this.tail(r.body, a.task_id)}` };
  }

  async tick(): Promise<void> {
    const t = this.now();
    for (const rec of this.recs.values()) {
      if (rec.status !== "running" || rec.blocking) continue; // a blocking run() reports this one itself
      const r = this.read(rec.id);
      if (rec.notify && !r.footer) {
        const fresh = r.body.slice(rec.notify.offset);
        const m = rec.notify.re.exec(fresh);
        if (m && t - rec.notify.lastAt >= rec.notify.debounceMs) {
          rec.notify.lastAt = t;
          rec.notify.offset = r.body.length;
          this.d.enqueueHidden(rec.botId, {
            source: "shell-notify", lane: "background", silenceAllowed: true,
            text: fillTemplate(loadPrompt("wakes/shell-notify.md"), { RESULTS: `Command \`${rec.command.slice(0, 200)}\` (${rec.id}): ${rec.notify.reason}\nMatched: ${m[0].slice(0, 200)}\nFull output: ${this.file(rec.id)}` }).trimEnd(),
          });
        }
      }
      if (r.footer) {
        this.finish(rec, r.footer);
        this.publish(rec.botId);
        if (!rec.awaited) {
          this.d.revivals.complete({ kind: "shell", botId: rec.botId, taskId: rec.id, block: `Command \`${rec.command.slice(0, 200)}\` (${rec.id}) — exit code ${r.footer.exitCode} after ${formatDuration(r.footer.elapsedMs)}.\nFull output: ${this.file(rec.id)}` });
        }
      } else if (t - rec.startedAt > LIMITSC.rewatchMaxMs) {
        rec.status = "error";
        rec.endedAt = t;
        await this.d.spawner.stop(rec.id).catch(() => {});
        this.d.revivals.complete({ kind: "shell", botId: rec.botId, taskId: rec.id, block: `Command \`${rec.command.slice(0, 200)}\` (${rec.id}) — stopped watching after 5 h; its status is unknown.\nFull output: ${this.file(rec.id)}` });
      }
    }
  }

  /** TOOL-11: after a host restart the units kept running; watch their files again for up to 5 h. */
  rewatchAtBoot(): void {
    for (const w of this.d.pending.list().filter((x) => x.kind === "shell")) {
      const cmd = this.read(w.taskId, w.botId).header.command ?? "";
      let command = cmd;
      try { command = JSON.parse(cmd) as string; } catch { /* keep raw */ }
      this.recs.set(w.taskId, { id: w.taskId, botId: w.botId, command, startedAt: w.createdAt, status: "running", endedAt: null, background: true, awaited: false, blocking: false, notify: null });
    }
  }

  /** Any Shell of this Bot still running or starting (foreground or background). */
  hasRunning(botId: string): boolean {
    return [...this.recs.values()].some((r) => r.botId === botId && r.status === "running");
  }

  async forgetBot(botId: string): Promise<void> {
    this.retired.add(botId);
    // Item 6: wait for starts already in flight; run() stops those units itself once they return.
    const ids = [...this.recs.values()].filter((r) => r.botId === botId).map((r) => r.id);
    await Promise.all(ids.map((id) => this.starting.get(id)).filter(Boolean));
    for (const k of [...this.lastCwd.keys()]) if (k === botId || k.startsWith(`${botId}\u0000`)) this.lastCwd.delete(k);
    for (const rec of [...this.recs.values()].filter((r) => r.botId === botId)) {
      if (rec.status === "running") await this.d.spawner.stop(rec.id).catch(() => {});
      this.recs.delete(rec.id);
    }
    this.d.pending.dropBot(botId);
  }
}
