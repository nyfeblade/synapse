import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../config";
import type { Exec } from "../computer/x-exec";
import { botOsUser, BOT_HOMES } from "./bot-uid";

/**
 * The file tools' way to a Bot's files (spec 2026-09-29 §3). With per-Bot accounts, every request goes through the root
 * helper box/files/bot-file, which runs it AS the Bot (the kernel is the wall). Before the box migrates (every Bot runs
 * as `box`) or off the box (tests, FUZZ), `localBotFile` runs the same protocol in this process ("same-uid") behind the
 * same path rules, checked on the real path after every link is resolved.
 *
 * Protocol (box/files/bot-file-worker.py is the other implementation; both are tested against the same cases):
 *   read  {path, offset?, limit?}      -> {ok, kind: "text", text, lines, total, sha, cut?} | {ok, kind: "image", mime, data, sha}
 *   write {path, content, expect}      -> {ok, sha, created}
 *   edit  {path, old, new, all, expect} -> {ok, sha, count}
 *   glob  {path, pattern}               -> {ok, kind: "paths", paths, cut?}
 *   grep  {path, pattern, glob?, mode?, ignoreCase?, context?, limit?} -> {ok, kind: "grep", text, matches, files, cut?}
 *   failure                             -> {ok: false, error}
 *
 * glob and grep walk the folder as the Bot: a link is never followed into a folder, a linked file counts only when its
 * real path passes the same walls, `.git` is skipped, and `node_modules` is skipped unless the pattern names it.
 */
export const BOT_FILE_HELPER = "/usr/local/libexec/bot-file";

export type BotFileRequest =
  | { op: "read"; path: string; offset?: number; limit?: number }
  | { op: "write"; path: string; content: string; expect: string | null }
  | { op: "edit"; path: string; old: string; new: string; all: boolean; expect: string | null }
  | { op: "glob"; path: string; pattern: string }
  | { op: "grep"; path: string; pattern: string; glob?: string; mode?: GrepMode; ignoreCase?: boolean; context?: number; limit?: number };
export type GrepMode = "files" | "content" | "count";
export type BotFileAnswer =
  | { ok: true; kind: "text"; text: string; lines: number; total: number; sha: string; cut?: true }
  | { ok: true; kind: "image"; mime: "image/png" | "image/jpeg" | "image/webp"; data: string; sha: string }
  | { ok: true; sha: string; created?: boolean; count?: number }
  | { ok: true; kind: "paths"; paths: string[]; cut?: true }
  | { ok: true; kind: "grep"; text: string; matches: number; files: number; cut?: true }
  | { ok: false; error: string };
export type BotFileRunner = (botId: string, req: BotFileRequest) => Promise<BotFileAnswer>;

/** The box: one `sudo -n bot-file <account> <botId>` per request, JSON over stdin/stdout. */
export function sudoBotFile(cfg: Pick<HostConfig, "perBotUid" | "botHomes">, exec: Exec, o: { timeoutMs?: number; log?(m: string): void } = {}): BotFileRunner {
  return async (botId, req) => {
    const u = botOsUser(cfg, botId);
    if (!u) return { ok: false, error: "This Bot has no account of its own yet." };
    const r = await exec("sudo", ["-n", BOT_FILE_HELPER, u.name, botId], { input: Buffer.from(JSON.stringify(req)), timeoutMs: o.timeoutMs ?? 35_000 });
    if (r.code !== 0) { o.log?.(`bot-file failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`); return { ok: false, error: "The file couldn't be reached." }; }
    try { return JSON.parse(r.stdout.toString("utf8")) as BotFileAnswer; } catch { return { ok: false, error: "The file couldn't be reached." }; }
  };
}

const MAX_TEXT = 256 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_WRITE = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 2000;
const LINE_MAX = 2000;
const IMAGES: Record<string, "image/png" | "image/jpeg" | "image/webp"> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const ALWAYS_DENY = ["/proc", "/sys", "/dev"];

/** Glob and Grep limits (the worker has the same). */
export const SEARCH_LIMITS = {
  /** Entries looked at in one walk; past it the answer is cut. */
  walkMax: 50_000,
  /** Paths Glob returns. */
  globMax: 1000,
  /** Grep skips files larger than this. */
  grepFileBytes: 2 * 1024 * 1024,
  /** Grep's answer text. */
  outputMax: 64 * 1024,
  /** A matched line is cut to this many characters. */
  lineMax: 500,
  contextMax: 10,
  /** Default output lines (content) and paths (files, count). */
  contentLimit: 250,
  filesLimit: 1000,
  limitMax: 5000,
} as const;

const RE_SPECIAL = new Set([..."\\^$.|?*+()[]{}/"]);
const escapeRe = (s: string) => [...s].map((c) => (RE_SPECIAL.has(c) ? `\\${c}` : c)).join("");

/**
 * A glob as a regular expression over a slash-separated path relative to the searched folder: `**\/` any folders (or
 * none), `**` anything, `*` anything but a slash, `?` one character but a slash, `{a,b}` either, `[abc]` / `[!abc]` a
 * character class. box/files/bot-file-worker.py builds the same expression.
 */
export function globRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 3; } else { re += ".*"; i += 2; }
      continue;
    }
    if (c === "*") { re += "[^/]*"; i++; continue; }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) { re += `(?:${pattern.slice(i + 1, end).split(",").map(escapeRe).join("|")})`; i = end + 1; continue; }
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end > i) {
        const body = pattern.slice(i + 1, end);
        re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end + 1;
        continue;
      }
    }
    re += escapeRe(c);
    i++;
  }
  return new RegExp(`^${re}$`);
}

interface Found { abs: string; rel: string; real: string; mtime: number; size: number }
const byRel = (a: Found, b: Found) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const newestFirst = (a: Found, b: Found) => b.mtime - a.mtime || byRel(a, b);

class Refused extends Error {}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);

/** Real path of `p`, or of its nearest existing ancestor joined with the rest (a file about to be created). */
function realOf(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * The same-uid fallback. `deny`: the host's private folder, the Bots' private folders, the managed skills tree (and in
 * tests, other Bots' homes via `botHomes` + `ownHome`). Everything is checked on the real path, links resolved.
 */
export function localBotFile(o: { deny: string[]; botHomes?: string; ownHome?(botId: string): string | null }): BotFileRunner {
  const homes = o.botHomes ?? BOT_HOMES;
  const check = (botId: string, real: string) => {
    for (const d of [...ALWAYS_DENY, ...o.deny.filter(Boolean)]) {
      if (under(real, d) || (fs.existsSync(d) && under(real, fs.realpathSync(d)))) throw new Refused("That path is off limits.");
    }
    const own = o.ownHome?.(botId) ?? null;
    if (under(real, homes) && !(own && under(real, own))) throw new Refused("That path is another Bot's.");
  };
  const resolve = (botId: string, p: unknown): string => {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || p.length > 4096) throw new Refused("file_path must be an absolute path.");
    const real = realOf(p);
    check(botId, real);
    return real;
  };
  const current = (real: string): Buffer | null => {
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { return null; }
    if (st.isDirectory()) throw new Refused("That is a folder, not a file.");
    return fs.readFileSync(real);
  };
  const guardExpect = (expect: string | null, before: Buffer | null) => {
    if (before === null) return;
    if (!expect) throw new Refused("File has not been read yet. Read it first before writing to it.");
    if (expect !== sha(before)) throw new Refused("File has been modified since it was read. Read it again before writing to it.");
  };
  const writeAtomic = (botId: string, real: string, data: Buffer) => {
    const d = path.dirname(real);
    fs.mkdirSync(d, { recursive: true });
    check(botId, fs.realpathSync(d));
    let mode = 0o664;
    try { mode = fs.statSync(real).mode & 0o777; } catch { /* new file */ }
    const tmp = path.join(d, `.bot-file-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmp, data, { flag: "wx", mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, real);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  };
  const read = (botId: string, req: Extract<BotFileRequest, { op: "read" }>): BotFileAnswer => {
    const real = resolve(botId, req.path);
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { throw new Refused("File does not exist."); }
    if (st.isDirectory()) throw new Refused("That is a folder, not a file.");
    if (!st.isFile()) throw new Refused("That is not a regular file.");
    const mime = IMAGES[path.extname(real).toLowerCase()];
    if (mime) {
      if (st.size > MAX_IMAGE) throw new Refused("The image is larger than 5 MB.");
      const data = fs.readFileSync(real);
      return { ok: true, kind: "image", mime, data: data.toString("base64"), sha: sha(data) };
    }
    const all = fs.readFileSync(real);
    const cutBytes = all.length > MAX_TEXT;
    const data = cutBytes ? all.subarray(0, MAX_TEXT) : all;
    const lines = data.toString("utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const offset = Math.max(1, Math.floor(Number(req.offset) || 1));
    const limit = Math.max(1, Math.min(Math.floor(Number(req.limit) || DEFAULT_LIMIT), DEFAULT_LIMIT));
    const chosen = lines.slice(offset - 1, offset - 1 + limit);
    const text = chosen.map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l}`).join("\n");
    return { ok: true, kind: "text", text, lines: chosen.length, total: lines.length, sha: sha(all), ...(cutBytes || offset - 1 + limit < lines.length ? { cut: true as const } : {}) };
  };
  const write = (botId: string, req: Extract<BotFileRequest, { op: "write" }>): BotFileAnswer => {
    const real = resolve(botId, req.path);
    if (typeof req.content !== "string") throw new Refused("content must be text.");
    const data = Buffer.from(req.content, "utf8");
    if (data.length > MAX_WRITE) throw new Refused("The content is larger than 10 MB.");
    const before = current(real);
    guardExpect(req.expect, before);
    writeAtomic(botId, real, data);
    return { ok: true, sha: sha(data), created: before === null };
  };
  const edit = (botId: string, req: Extract<BotFileRequest, { op: "edit" }>): BotFileAnswer => {
    const real = resolve(botId, req.path);
    if (typeof req.old !== "string" || typeof req.new !== "string") throw new Refused("old_string and new_string must be text.");
    if (req.old === req.new) throw new Refused("old_string and new_string are the same.");
    const before = current(real);
    if (before === null) {
      if (req.old === "") { const data = Buffer.from(req.new, "utf8"); writeAtomic(botId, real, data); return { ok: true, sha: sha(data), count: 1 }; }
      throw new Refused("File does not exist.");
    }
    guardExpect(req.expect, before);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
    const n = req.old ? text.split(req.old).length - 1 : 0;
    if (n === 0) throw new Refused("old_string was not found in the file.");
    if (n > 1 && !req.all) throw new Refused(`old_string appears ${n} times. Give more context to make it unique, or set replace_all.`);
    const after = req.all ? text.split(req.old).join(req.new) : text.replace(req.old, () => req.new);
    const data = Buffer.from(after, "utf8");
    writeAtomic(botId, real, data);
    return { ok: true, sha: sha(data), count: req.all ? n : 1 };
  };
  /** The walls as a predicate (for a walk: nothing thrown, the deny list resolved once). */
  const wallsFor = (botId: string) => {
    const deny = [...ALWAYS_DENY, ...o.deny.filter(Boolean)].flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch { return [d]; } });
    const own = o.ownHome?.(botId) ?? null;
    const top = homes.replace(/\/+$/, "");
    // The folder of all homes may be walked through (to reach the Bot's own); another Bot's home never.
    return (real: string) => !deny.some((d) => under(real, d)) && !(under(real, homes) && real !== top && !(own && under(real, own)));
  };
  /** Every file under a folder, as the Bot may see it: links never followed into a folder, a linked file by its real path. */
  const walk = (botId: string, given: string, real: string, nodeModules: boolean): { files: Found[]; cut: boolean } => {
    const ok = wallsFor(botId);
    const files: Found[] = [];
    const stack: [string, string, string][] = [[given, real, ""]];
    let seen = 0;
    while (stack.length) {
      const [dir, dirReal, rel] = stack.pop()!;
      let names: string[];
      try { names = fs.readdirSync(dirReal).sort(); } catch { continue; }
      const sub: [string, string, string][] = [];
      for (const n of names) {
        if (++seen > SEARCH_LIMITS.walkMax) return { files, cut: true };
        if (n === ".git" || (n === "node_modules" && !nodeModules)) continue;
        const p = path.join(dirReal, n);
        let st: fs.Stats;
        let r = p;
        try {
          st = fs.lstatSync(p);
          if (st.isSymbolicLink()) { r = fs.realpathSync(p); st = fs.statSync(r); if (!st.isFile()) continue; }
        } catch { continue; }
        if (!ok(r)) continue;
        const relN = rel ? `${rel}/${n}` : n;
        if (st.isDirectory()) sub.push([path.join(dir, n), p, relN]);
        else if (st.isFile()) files.push({ abs: path.join(dir, n), rel: relN, real: r, mtime: st.mtimeMs, size: st.size });
      }
      for (const d of sub.reverse()) stack.push(d);
    }
    return { files, cut: false };
  };
  const searchRoot = (botId: string, p: unknown): { given: string; real: string; st: fs.Stats } => {
    // A search may start at the folder of all homes itself (it walks through to the Bot's own); anything else is walled
    // exactly as for Read.
    const top = homes.replace(/\/+$/, "");
    const real = typeof p === "string" && p.startsWith("/") && !p.includes("\0") && realOf(p) === top ? top : resolve(botId, p);
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { throw new Refused("Path does not exist."); }
    return { given: path.resolve(p as string), real, st };
  };
  const glob = (botId: string, req: Extract<BotFileRequest, { op: "glob" }>): BotFileAnswer => {
    const { given, real, st } = searchRoot(botId, req.path);
    if (!st.isDirectory()) throw new Refused("path must be a folder.");
    let pat = typeof req.pattern === "string" ? req.pattern : "";
    if (pat.startsWith("/")) {
      if (!pat.startsWith(`${given}/`)) throw new Refused("pattern must be relative to path.");
      pat = pat.slice(given.length + 1);
    }
    pat = pat.replace(/^(\.\/)+/, "");
    if (!pat || pat.length > 1000) throw new Refused("pattern is required.");
    const re = globRegex(pat);
    const w = walk(botId, given, real, pat.includes("node_modules"));
    const hits = w.files.filter((f) => re.test(f.rel)).sort(newestFirst);
    const cut = w.cut || hits.length > SEARCH_LIMITS.globMax;
    return { ok: true, kind: "paths", paths: hits.slice(0, SEARCH_LIMITS.globMax).map((h) => h.abs), ...(cut ? { cut: true as const } : {}) };
  };
  const grep = (botId: string, req: Extract<BotFileRequest, { op: "grep" }>): BotFileAnswer => {
    const { given, real, st } = searchRoot(botId, req.path);
    if (typeof req.pattern !== "string" || !req.pattern || req.pattern.length > 1000) throw new Refused("pattern is required.");
    let rx: RegExp;
    try { rx = new RegExp(req.pattern, req.ignoreCase ? "i" : ""); } catch { throw new Refused(`Invalid regular expression: ${req.pattern}`); }
    const mode: GrepMode = req.mode === "content" || req.mode === "count" ? req.mode : "files";
    const ctx = Math.max(0, Math.min(Math.floor(Number(req.context) || 0), SEARCH_LIMITS.contextMax));
    const limit = Math.max(1, Math.min(Math.floor(Number(req.limit) || (mode === "content" ? SEARCH_LIMITS.contentLimit : SEARCH_LIMITS.filesLimit)), SEARCH_LIMITS.limitMax));
    const g = typeof req.glob === "string" && req.glob ? req.glob : null;
    let cut = false;
    let files: Found[];
    if (st.isDirectory()) {
      const w = walk(botId, given, real, (g ?? "").includes("node_modules"));
      cut = w.cut;
      const gre = g ? globRegex(g) : null;
      files = w.files.filter((f) => !gre || gre.test(g!.includes("/") ? f.rel : path.posix.basename(f.rel))).sort(byRel);
    } else if (st.isFile()) {
      files = [{ abs: given, rel: path.basename(given), real, mtime: st.mtimeMs, size: st.size }];
    } else throw new Refused("That is not a regular file.");
    const out: string[] = [];
    let bytes = 0;
    let matches = 0;
    const hitFiles: { f: Found; n: number }[] = [];
    const emit = (line: string): boolean => {
      if (out.length >= limit || bytes + line.length + 1 > SEARCH_LIMITS.outputMax) { cut = true; return false; }
      out.push(line);
      bytes += line.length + 1;
      return true;
    };
    const clip = (l: string) => (l.length > SEARCH_LIMITS.lineMax ? `${l.slice(0, SEARCH_LIMITS.lineMax)}…` : l);
    for (const f of files) {
      if (f.size > SEARCH_LIMITS.grepFileBytes) continue;
      let buf: Buffer;
      try { buf = fs.readFileSync(f.real); } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const lines = buf.toString("utf8").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const hit: number[] = [];
      lines.forEach((l, i) => { if (rx.test(l)) hit.push(i); });
      if (!hit.length) continue;
      matches += hit.length;
      hitFiles.push({ f, n: hit.length });
      if (mode !== "content" || cut) continue;
      const show = new Set<number>();
      for (const i of hit) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) show.add(j);
      const isHit = new Set(hit);
      let prev = -2;
      for (const j of [...show].sort((a, b) => a - b)) {
        if (ctx > 0 && prev !== -2 && j !== prev + 1 && !emit("--")) break;
        if (ctx > 0 && prev === -2 && out.length && !emit("--")) break;
        if (!emit(`${f.abs}${isHit.has(j) ? ":" : "-"}${j + 1}${isHit.has(j) ? ":" : "-"}${clip(lines[j]!)}`)) break;
        prev = j;
      }
    }
    if (mode === "files") {
      for (const h of hitFiles.map((x) => x.f).sort(newestFirst)) if (!emit(h.abs)) break;
    } else if (mode === "count") {
      for (const h of hitFiles) if (!emit(`${h.f.abs}:${h.n}`)) break;
    }
    return { ok: true, kind: "grep", text: out.join("\n"), matches, files: hitFiles.length, ...(cut ? { cut: true as const } : {}) };
  };
  return async (botId, req) => {
    try {
      if (req.op === "read") return read(botId, req);
      if (req.op === "write") return write(botId, req);
      if (req.op === "edit") return edit(botId, req);
      if (req.op === "glob") return glob(botId, req);
      if (req.op === "grep") return grep(botId, req);
      return { ok: false, error: "bad op" };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, error: e.message };
      if (e instanceof TypeError && /decode/i.test(e.message)) return { ok: false, error: "The file is not UTF-8 text." };
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return { ok: false, error: "Permission denied." };
      if (code === "ENOENT") return { ok: false, error: "File does not exist." };
      return { ok: false, error: `The file couldn't be used (${code ?? "error"}).` };
    }
  };
}

/** The runner a host uses: the helper with per-Bot accounts on the box, else the same-uid fallback. */
export function botFileFor(cfg: HostConfig, exec: Exec, o: { onBox: boolean; log?(m: string): void }): BotFileRunner {
  if (cfg.perBotUid && o.onBox) return sudoBotFile(cfg, exec, o);
  const agents = path.join(cfg.dataRoot, "agents");
  const transcripts = path.join(cfg.dataRoot, "agent-transcripts");
  return localBotFile({
    deny: [cfg.hostPrivate, agents, transcripts, ...(cfg.ccManagedDir ? [cfg.ccManagedDir] : [])],
    ...(cfg.botHomes ? { botHomes: cfg.botHomes } : {}),
    ownHome: (botId) => botOsUser(cfg, botId)?.home ?? null,
  });
}
