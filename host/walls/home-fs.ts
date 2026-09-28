import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../config";
import type { Exec } from "../computer/x-exec";
import type { DevCommandFs } from "../review/static";
import { botOsUser } from "./bot-uid";

/**
 * Bug 231 round 1: the review gate's view INSIDE a Bot's 0700 home. bothost can't enter it (EACCES), so the fast path
 * (review/static.ts closedAncestor/botOwns/gitReadTrusted) could never prove a ~/code tree was the Bot's own and every
 * command there went to the model. The root helper box/files/bot-fs-query answers read-only queries AS the Bot, in one
 * batch per gate decision; the gate then judges from that snapshot. Anything the snapshot can't answer is a miss, and a
 * miss is never "not there": it throws, and the gate fails closed (model review). /workspace stays on plain fs.
 */

export const FS_QUERY_HELPER = "/usr/local/libexec/bot-fs-query";

export type FsOp = "lstat" | "realpath" | "ls" | "read";
export interface FsStat { u: number; g: number; m: number; l: boolean }
/** The helper could not read it (EACCES and the like): unverifiable, never "not there". */
export interface FsErr { err: true }
export type LsResult = { n: [string, FsStat | FsErr | null, string | null, FsStat | FsErr | null][]; more: boolean } | FsErr | null;
export type ReadResult = { t: string } | { big: true } | { denied: true } | FsErr | null;
export type FsAnswer = FsStat | FsErr | string | LsResult | ReadResult | null;
/** One batch of queries as the Bot; null = the helper is unavailable or refused (the caller fails closed). */
export type FsQuery = (botId: string, ops: [FsOp, string][]) => Promise<FsAnswer[] | null>;

/** The box's FsQuery: one `sudo -n bot-fs-query <account> <botId>` per batch, JSON over stdin/stdout, 3 s timeout. */
export function sudoFsQuery(cfg: Pick<HostConfig, "perBotUid" | "botHomes">, exec: Exec, o: { timeoutMs?: number; log?(m: string): void } = {}): FsQuery {
  return async (botId, ops) => {
    const u = botOsUser(cfg, botId);
    if (!u || ops.length === 0) return ops.length === 0 ? [] : null;
    const r = await exec("sudo", ["-n", FS_QUERY_HELPER, u.name, botId], { input: Buffer.from(JSON.stringify({ ops })), timeoutMs: o.timeoutMs ?? 3_000 });
    if (r.code !== 0) { o.log?.(`bot-fs-query failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`); return null; }
    try {
      const out = JSON.parse(r.stdout.toString("utf8")) as { r?: unknown };
      return Array.isArray(out.r) && out.r.length === ops.length ? (out.r as FsAnswer[]) : null;
    } catch {
      return null;
    }
  };
}

/** A query the snapshot could not answer. The gate catches it and sends the command to the model. */
export class HomeFsMiss extends Error {
  constructor(readonly op: FsOp, readonly p: string) { super(`home fs miss: ${op} ${p}`); }
}

const key = (op: FsOp, p: string) => `${op}\0${p}`;

/** What the helper answered for one Bot, plus what those answers imply (a folder listing gives its entries' lstat). */
export class HomeSnapshot {
  private m = new Map<string, FsAnswer>();
  /** True once a helper call failed: every remaining miss stays a miss. */
  failed = false;
  calls = 0;
  constructor(readonly home: string) {}

  has(op: FsOp, p: string): boolean { return this.m.has(key(op, p)) || this.absent(p); }
  get(op: FsOp, p: string): FsAnswer | undefined { return this.m.has(key(op, p)) ? this.m.get(key(op, p)) : this.absent(p) ? null : undefined; }

  /** Not there, by a complete listing of its folder (answered, readable, not cut short) that doesn't name it. */
  private absent(p: string): boolean {
    const l = this.m.get(key("ls", path.dirname(p)));
    return !!l && typeof l === "object" && "n" in l && !l.more && !l.n.some((e) => e[0] === path.basename(p));
  }

  add(op: FsOp, p: string, a: FsAnswer): void {
    this.m.set(key(op, p), a);
    if (op === "ls" && a && typeof a === "object" && "n" in a) {
      const parentReal = this.m.get(key("realpath", p));
      for (const [name, s, real, rs] of a.n) {
        const c = `${p}/${name}`;
        if (!this.m.has(key("lstat", c))) this.m.set(key("lstat", c), s);
        if (s && "l" in s && s.l) {
          if (!this.m.has(key("realpath", c))) this.m.set(key("realpath", c), real);
          if (real && !this.m.has(key("lstat", real))) this.m.set(key("lstat", real), rs);
        } else if (s && typeof parentReal === "string" && !this.m.has(key("realpath", c))) {
          this.m.set(key("realpath", c), `${parentReal}/${name}`);
        }
      }
    }
  }

  /** Runs a batch through the helper and records the answers (deduplicated, missing ones only). */
  async fetch(query: FsQuery, botId: string, ops: [FsOp, string][]): Promise<void> {
    const want = [...new Map(ops.filter(([op, p]) => !this.has(op, p)).map((o) => [key(o[0], o[1]), o] as const)).values()];
    if (want.length === 0 || this.failed) return;
    // realpath first, so an ls in the same batch can derive its entries' real paths
    want.sort((a, b) => (a[0] === "realpath" ? 0 : 1) - (b[0] === "realpath" ? 0 : 1));
    this.calls++;
    const r = await query(botId, want).catch(() => null);
    if (!r) { this.failed = true; return; }
    want.forEach(([op, p], i) => this.add(op, p, r[i] ?? null));
  }
}

/** Inside the home, not the home itself (bothost can lstat and realpath the home: its parent is 0711). */
export function inHome(home: string, p: string): boolean {
  return p.startsWith(`${home}/`);
}

/**
 * The DevCommandFs the gate judges with for a Bot that has a home: inside the home every answer comes from the
 * snapshot; elsewhere from `base` (plain fs as bothost). `record` mode (the dry run that decides what to fetch) notes
 * each miss and answers as if absent; `strict` mode throws HomeFsMiss on a miss.
 */
export class SnapshotFs implements DevCommandFs {
  readonly misses: [FsOp, string][] = [];
  constructor(private snap: HomeSnapshot, private base: DevCommandFs, private mode: "record" | "strict") {}
  get home(): string { return this.snap.home; }

  private in(p: string): boolean { return inHome(this.snap.home, path.resolve(p)); }
  private look(op: FsOp, p: string): { hit: boolean; v: FsAnswer | undefined } {
    const r = path.resolve(p);
    if (this.snap.has(op, r)) return { hit: true, v: this.snap.get(op, r) };
    if (this.mode === "strict") throw new HomeFsMiss(op, r);
    this.misses.push([op, r]);
    return { hit: false, v: undefined };
  }

  stat(p: string): { uid: number; gid: number; mode: number; link: boolean } | null {
    if (!this.in(p)) return this.base.stat?.(p) ?? null;
    const s = this.look("lstat", p).v as FsStat | FsErr | null | undefined;
    if (s && "err" in s) { if (this.mode === "strict") throw new HomeFsMiss("lstat", path.resolve(p)); return null; }
    return s ? { uid: s.u, gid: s.g, mode: s.m, link: s.l } : null;
  }
  realpath(p: string): string | null {
    if (!this.in(p)) return this.base.realpath(p);
    const v = this.look("realpath", p).v;
    if (v && typeof v === "object") { if (this.mode === "strict") throw new HomeFsMiss("realpath", path.resolve(p)); return null; } // unreadable
    return typeof v === "string" ? v : null;
  }
  exists(p: string): boolean {
    if (!this.in(p)) return this.base.exists(p);
    const s = this.stat(p);
    return !!s && (!s.link || this.realpath(p) !== null);
  }
  list(p: string): string[] | null {
    if (!this.in(p)) return this.base.list?.(p) ?? null;
    const v = this.look("ls", p).v as LsResult | undefined;
    if (v && ("err" in v || v.more)) { if (this.mode === "strict") throw new HomeFsMiss("ls", path.resolve(p)); return null; }
    return v ? v.n.map((e) => e[0]) : null;
  }
  readFile(p: string): string | null {
    if (!this.in(p)) return this.base.readFile(p);
    const v = this.look("read", p).v as ReadResult | undefined;
    if (v && !("t" in v)) { if (this.mode === "strict") throw new HomeFsMiss("read", path.resolve(p)); return null; } // too big or not allowed: unverifiable
    return v ? v.t : null;
  }
}

/**
 * The first batch for a command whose folders reach into the home: for every folder from each seed up to (not
 * including) the home, what the fast path reads of a work tree root, so one helper call answers a typical decision.
 */
export function seedOps(home: string, dirs: string[]): [FsOp, string][] {
  const ops: [FsOp, string][] = [];
  const seen = new Set<string>();
  for (const d0 of dirs) {
    for (let d = path.resolve(d0); inHome(home, d); d = path.dirname(d)) {
      if (seen.has(d)) break;
      seen.add(d);
      const git = `${d}/.git`;
      ops.push(["realpath", d], ["lstat", d], ["ls", d], ["read", `${d}/package.json`], ["read", git], ["ls", git], ["read", `${git}/config`],
        ["ls", `${git}/info`], ["read", `${git}/info/attributes`], ["ls", `${git}/hooks`], ["read", `${d}/.gitattributes`],
        ["ls", `${d}/node_modules`], ["ls", `${d}/node_modules/.bin`],
        ...["src", "test", "tests", "__tests__", "spec", "config"].map((s): [FsOp, string] => ["ls", `${d}/${s}`]));
    }
  }
  return ops;
}

/**
 * Real paths for a Bot: inside its home through bot-fs-query (as the Bot), elsewhere plain fs. A failed helper call
 * answers null for the home paths (unverifiable), never their text.
 */
export function botRealpaths(cfg: Pick<HostConfig, "perBotUid" | "botHomes">, query: FsQuery, plain: (p: string) => string | null) {
  return async (botId: string, paths: string[]): Promise<(string | null)[] | null> => {
    const home = botOsUser(cfg, botId)?.home;
    const mine = [...new Set(home ? paths.map((p) => path.resolve(p)).filter((p) => inHome(home, p)) : [])];
    const got = mine.length ? await realpathsAsBot(query, botId, mine) : [];
    const by = new Map<string, string | null>();
    mine.forEach((p, i) => by.set(p, got ? got[i] ?? null : null));
    return paths.map((p) => (home && inHome(home, path.resolve(p)) ? by.get(path.resolve(p)) ?? null : plain(p)));
  };
}

/** A path's real path (null = none) and whether anything is there at all (lstat; unreadable counts as there). */
export interface PathInfo { real: string | null; exists: boolean }

/** Plain fs, as bothost (paths it can read: /workspace/repos, FUZZ, tests). */
export function plainPathInfo(p: string): PathInfo {
  let real: string | null = null;
  try { real = fs.realpathSync(p); } catch { /* none */ }
  try { fs.lstatSync(p); return { real, exists: true }; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { real, exists: !(code === "ENOENT" || code === "ENOTDIR") };
  }
}

/** PathInfo for a Bot: inside its home as the Bot (bot-fs-query), elsewhere plain fs; null = the helper failed. */
export function botPathInfo(cfg: Pick<HostConfig, "perBotUid" | "botHomes">, query: FsQuery) {
  return async (botId: string, paths: string[]): Promise<PathInfo[] | null> => {
    const home = botOsUser(cfg, botId)?.home;
    const mine = [...new Set(home ? paths.map((p) => path.resolve(p)).filter((p) => inHome(home, p)) : [])];
    const by = new Map<string, PathInfo>();
    if (mine.length) {
      const r = await query(botId, mine.flatMap((p): [FsOp, string][] => [["realpath", p], ["lstat", p]])).catch(() => null);
      if (!r) return null;
      mine.forEach((p, i) => by.set(p, { real: typeof r[2 * i] === "string" ? (r[2 * i] as string) : null, exists: r[2 * i + 1] !== null }));
    }
    return paths.map((p) => by.get(path.resolve(p)) ?? plainPathInfo(p));
  };
}

/** Real paths of `paths` as the Bot sees them (null = missing or unverifiable), for callers outside the gate. */
export async function realpathsAsBot(query: FsQuery, botId: string, paths: string[]): Promise<(string | null)[] | null> {
  const r = await query(botId, paths.map((p) => ["realpath", p] as [FsOp, string])).catch(() => null);
  return r ? r.map((x) => (typeof x === "string" ? x : null)) : null;
}
