import fs from "node:fs";
import path from "node:path";

/**
 * Bug 234: an unsandboxed run never goes through the user's login shell or their PATH (a sandboxed Bot could have
 * planted an `open` in /opt/homebrew/bin or a function in ~/.zshenv). It runs `/bin/zsh -f` with this fixed PATH,
 * plus — for an exempt tool — only the directory the tool itself resolved to, which the card shows.
 */
export const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Where a CLI the user installed usually lives, searched after the coordinator's own PATH (a packaged app's is bare). */
function extraDirs(home: string): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.bun/bin`, `${home}/.npm-global/bin`, `${home}/.cargo/bin`, "/usr/bin", "/bin"];
}

function executable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** The absolute path a tool name (or path) runs as, or null. */
export function resolveTool(name: string, o: { home: string; envPath?: string }): string | null {
  if (!name) return null;
  if (name.includes("/")) return path.isAbsolute(name) && executable(name) ? name : null;
  const dirs = searchDirs(o.home, o.envPath);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (executable(p)) return p;
  }
  return null;
}

/**
 * Bug 235: the exempt tool itself is pinned. It runs by its realpath (the card shows it), its PATH is FIXED_PATH plus
 * only its shebang interpreter's realpath dir, and realpath + size + mtime (the interpreter's too) must be the same at
 * exec as when its card was shown — the tool lives where a sandboxed Bot could otherwise swap it.
 */
export interface FilePin { realpath: string; size: number; mtimeMs: number }
export interface ToolPin extends FilePin { name: string; interpreter: FilePin | null }

const realOf = (p: string): string | null => { try { return fs.realpathSync.native(p); } catch { return null; } };
function filePin(p: string): FilePin | null {
  const real = realOf(p);
  if (!real) return null;
  try { const st = fs.statSync(real); return st.isFile() ? { realpath: real, size: st.size, mtimeMs: st.mtimeMs } : null; } catch { return null; }
}

/** A script's interpreter, from its shebang (`#!/usr/bin/env node` resolves `node` like a tool), as an absolute path. */
function shebangInterpreter(real: string, o: { home: string; envPath?: string }): string | null {
  let head = "";
  try {
    const fd = fs.openSync(real, "r");
    try { const b = Buffer.alloc(256); head = b.subarray(0, fs.readSync(fd, b, 0, 256, 0)).toString("latin1"); } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (!head.startsWith("#!")) return null;
  const words = head.slice(2).split("\n")[0]!.trim().split(/\s+/);
  if (!words[0]) return null;
  if (path.basename(words[0]) === "env") {
    const name = words.slice(1).find((w) => !w.startsWith("-"));
    return name ? resolveTool(name, o) : null;
  }
  return path.isAbsolute(words[0]) ? words[0] : null;
}

export function pinTool(name: string, o: { home: string; envPath?: string }): ToolPin | null {
  const resolved = resolveTool(name, o);
  const pin = resolved ? filePin(resolved) : null;
  if (!pin) return null;
  const interp = shebangInterpreter(pin.realpath, o);
  return { name, ...pin, interpreter: interp ? filePin(interp) : null };
}

export function samePin(a: ToolPin | null | undefined, b: ToolPin | null | undefined): boolean {
  const eq = (x: FilePin | null | undefined, y: FilePin | null | undefined) => (!x && !y) || (!!x && !!y && x.realpath === y.realpath && x.size === y.size && x.mtimeMs === y.mtimeMs);
  return !!a && !!b && a.name === b.name && eq(a, b) && eq(a.interpreter, b.interpreter);
}

/** The PATH a pinned tool's run gets: the fixed system dirs, plus only its interpreter's realpath dir. */
export function pinnedPath(pin: ToolPin | null): string {
  // Bug 236: AFTER the fixed dirs, so nothing in the interpreter's dir can shadow a system command (its dir is also
  // write-denied in the sandbox: exemptInstallTrees).
  const dir = pin?.interpreter ? path.dirname(pin.interpreter.realpath) : null;
  return dir && !FIXED_PATH.split(":").includes(dir) ? `${FIXED_PATH}:${dir}` : FIXED_PATH;
}

/** Every directory an exempt tool name is looked up in (the coordinator's PATH, then the usual install places). */
export function searchDirs(home: string, envPath?: string): string[] {
  return [...new Set([...(envPath ?? process.env.PATH ?? "").split(":").filter((d) => path.isAbsolute(d)), ...extraDirs(home)])];
}

/** Kept for callers that only need the old shape; a pinned run uses pinnedPath. */
export function unsandboxedPath(resolved: string | null): string {
  return resolved ? `${path.dirname(resolved)}:${FIXED_PATH}` : FIXED_PATH;
}

/** Bug 239: the exempt tools (swift, xcodebuild, playwright, electron + their npx/node) AND claude and codex, which no
 *  longer run unwrapped but are still protected: the user's own Terminal runs them outside any sandbox. */
const EXEMPT_TOOL_NAMES = ["claude", "codex", "npx", "playwright", "electron", "swift", "xcodebuild", "node"];
const ownedByUser = (p: string): boolean => { try { return fs.lstatSync(p).uid === process.getuid?.(); } catch { return false; } };

/**
 * Bug 235: what the command sandbox must never write, so an exempt tool can't be swapped from inside it: Claude's
 * native install (~/.local/share/claude, ~/.local/bin/claude), each exempt tool's link and realpath, the npm global
 * package dir a tool lives in, and its interpreter. Only user-owned places (root-owned ones can't be written anyway),
 * and never a whole shared bin dir like /opt/homebrew/bin.
 */
export function exemptInstallTrees(home: string, envPath?: string): { subpaths: string[]; literals: string[] } {
  const h = home.replace(/\/+$/, "");
  const subpaths = new Set<string>([`${h}/.local/share/claude`]);
  const literals = new Set<string>([`${h}/.local/bin/claude`]);
  // Bug 236: a NEW file that would shadow an exempt tool (a `claude` dropped into /opt/homebrew/bin ahead of the real
  // one) is denied too: every search dir × exempt name, whether or not it exists yet. Never the dir as a whole.
  for (const d of searchDirs(home, envPath)) for (const name of EXEMPT_TOOL_NAMES) literals.add(path.join(d, name));
  for (const name of EXEMPT_TOOL_NAMES) {
    const link = resolveTool(name, { home, envPath });
    if (!link) continue;
    const pin = pinTool(name, { home, envPath });
    for (const p of [link, pin?.realpath, pin?.interpreter?.realpath]) {
      if (!p || !ownedByUser(p)) continue;
      const pkg = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(p)?.[1];
      if (pkg) subpaths.add(pkg);
      else literals.add(p);
    }
    // Bug 236: the interpreter's whole directory (a `git` planted beside node would otherwise be on the run's PATH).
    const interpDir = pin?.interpreter ? path.dirname(pin.interpreter.realpath) : null;
    if (interpDir && !FIXED_PATH.split(":").includes(interpDir) && !extraDirs(home).includes(interpDir) && ownedByUser(interpDir)) subpaths.add(interpDir); // never a shared bin dir
  }
  return { subpaths: [...subpaths], literals: [...literals] };
}
