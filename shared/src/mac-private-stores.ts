import { parseShell, shPath } from "./shell-parse";

/**
 * Private-store hardening: the Mac's private stores (a browser's saved logins and cookies, Mail, Messages, Safari,
 * SSH private keys) as a kernel-level deny in the command sandbox. The text rules in full-auto.ts card a command that
 * NAMES a store, but a wildcard, `find -exec`, `xargs` or a python `open()` spells it where they can't see; inside the
 * sandbox the read fails however it's written. A card-approved single plain read of one store (`cat <file>`) runs
 * unwrapped for that one call, like an approved hand-off.
 *
 * Every rule is a regex in the subset that the sandbox profile language (SBPL) and JavaScript read the same way —
 * literals, `[xX]` classes, `[^/]`, `(a|b)`, `?`, `+`, `.*`, `^`, `$` — so the profile the executor builds and the
 * matcher below (used by the policy, the executor and the tests) can't disagree. Below home, letters match either
 * case (APFS folds case). Pure strings: no node imports.
 */

/** Folders whose whole contents are private (relative to home). Reads and writes are denied. */
export const MAC_PRIVATE_STORE_DIRS = [
  "Library/Safari", "Library/Cookies", "Library/Mail", "Library/Messages",
  "Library/Containers/com.apple.Safari", "Library/Containers/com.apple.mail", "Library/Containers/com.apple.iChat",
  "Library/Containers/com.apple.MobileSMS", "Library/Containers/com.apple.imessage",
] as const;
/** Chromium-family store files (Chrome, Edge, Brave, Arc, Vivaldi, Opera …), anywhere under ~/Library/Application Support. */
export const MAC_CHROMIUM_STORE_FILES = ["Cookies", "Login Data", "Login Data For Account", "Web Data", "Safe Browsing Cookies", "Extension Cookies"] as const;
/** Firefox-family store files, anywhere under ~/Library. */
export const MAC_FIREFOX_STORE_FILES = ["logins.json", "logins-backup.json", "key3.db", "key4.db", "cookies.sqlite", "cookies.sqlite-wal", "cookies.sqlite-shm", "signons.sqlite", "cert9.db"] as const;
/**
 * Where the browsers keep their profiles (relative to home). Never written from inside the sandbox, so a profile
 * folder can't be renamed out from under the store rules (and a native-messaging host, which the browser starts
 * outside the sandbox, can't be planted).
 */
export const MAC_BROWSER_ROOTS = [
  "Library/Application Support/Google", "Library/Application Support/Chromium", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Arc", "Library/Application Support/Vivaldi",
  "Library/Application Support/com.operasoftware.Opera", "Library/Application Support/Firefox", "Library/Application Support/LibreWolf",
  "Library/Application Support/zen", "Library/Application Support/Waterfox",
] as const;
/** In ~/.ssh everything is private except these, which stay readable (never writable). */
const SSH_PUBLIC = ["config", "known_hosts", "known_hosts.old", "authorized_keys", "authorized_keys2"] as const;
/**
 * The folders above the stores (relative to home; "" is home itself). The folder itself can't be renamed or
 * re-permissioned from inside the sandbox (a moved parent would carry a store out from under a path rule);
 * creating and changing things INSIDE it is untouched.
 */
const LOCKED_PARENTS = ["", "Library", "Library/Application Support", "Library/Containers", ".ssh"] as const;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A literal path as a regex that matches it in either case, in the SBPL/JS common subset. */
export function macCaseFoldRe(s: string): string {
  return [...s].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : esc(ch))).join("");
}
const trim = (h: string): string => h.replace(/\/+$/, "");

export interface MacPrivateStoreRules {
  /** file-read* and file-write* denied. */
  deny: string[];
  /** file-read* allowed again after `deny` (later SBPL rules win): the public files in ~/.ssh and the folder itself. */
  allowRead: string[];
  /** file-write* denied: the store parents themselves (exact) and the browser roots (whole). */
  writeLock: string[];
}

/**
 * The rules for each spelling of home (its lexical and on-disk forms). Home is matched as spelled (the kernel checks
 * the on-disk spelling, which the caller passes); everything below it matches in either case. One regex per store,
 * since the profile reader refuses a string over about 1 KB.
 */
export function macPrivateStoreRules(homes: readonly string[]): MacPrivateStoreRules {
  const out: MacPrivateStoreRules = { deny: [], allowRead: [], writeLock: [] };
  const suffix = `(-${macCaseFoldRe("journal")}|-${macCaseFoldRe("wal")})?`;
  for (const raw of new Set(homes.map(trim))) {
    const h = esc(raw);
    out.deny.push(
      ...MAC_PRIVATE_STORE_DIRS.map((d) => `^${h}/${macCaseFoldRe(d)}(/|$)`),
      ...MAC_CHROMIUM_STORE_FILES.map((f) => `^${h}/${macCaseFoldRe("Library/Application Support")}/.+/${macCaseFoldRe(f)}${suffix}$`),
      ...MAC_FIREFOX_STORE_FILES.map((f) => `^${h}/${macCaseFoldRe("Library")}/.+/${macCaseFoldRe(f)}$`),
      `^${h}/${macCaseFoldRe(".ssh")}/.+`,
    );
    out.allowRead.push(
      `^${h}/${macCaseFoldRe(".ssh")}/?$`,
      `^${h}/${macCaseFoldRe(".ssh")}/[^/]+${macCaseFoldRe(".pub")}$`,
      ...SSH_PUBLIC.map((f) => `^${h}/${macCaseFoldRe(".ssh")}/${macCaseFoldRe(f)}$`),
    );
    out.writeLock.push(
      ...LOCKED_PARENTS.map((d) => `^${h}${d ? `/${macCaseFoldRe(d)}` : ""}/?$`),
      ...MAC_BROWSER_ROOTS.map((d) => `^${h}/${macCaseFoldRe(d)}(/|$)`),
    );
  }
  return out;
}

/** Tests only: the same rule shapes over neutral stand-in folders (a stand-in store and its parent). */
export function macStandInStoreRules(dirs: readonly string[]): MacPrivateStoreRules {
  const out: MacPrivateStoreRules = { deny: [], allowRead: [], writeLock: [] };
  for (const d of new Set(dirs.map(trim))) {
    const parent = d.slice(0, d.lastIndexOf("/"));
    out.deny.push(`^${esc(parent)}/${macCaseFoldRe(d.slice(parent.length + 1))}(/|$)`);
    out.writeLock.push(`^${esc(parent)}/?$`);
  }
  return out;
}

/** Is this absolute path (as the kernel would see it) a private store the sandbox denies reading? */
export function macPrivateStorePath(abs: string, home: string, rules: MacPrivateStoreRules = macPrivateStoreRules([home])): boolean {
  const p = abs.normalize("NFC");
  return rules.deny.some((r) => new RegExp(r).test(p)) && !rules.allowRead.some((r) => new RegExp(r).test(p));
}

/**
 * Programs whose single plain read of one file may run unwrapped once its card is approved. None of them can write
 * a file, run another program, or read a file named by a flag (sqlite3, plutil, xxd, hexdump -f, shasum -c, file -f
 * and grep -f can, so they aren't here).
 */
const PLAIN_READERS = /^(cat|head|tail|wc|strings|od|ls|stat)$/;
const COUNT_OK = /^(head|tail)$/;

/**
 * The one store a command reads, when the WHOLE command is a single plain read of it — `cat <store>`, `head -n 20
 * <store>`: one simple command from PLAIN_READERS, no pipes, redirects, substitutions, wrappers, globs or variables,
 * and exactly one path, spelled from / or ~, which is a store. Such a command, card-approved, runs outside the sandbox
 * for that one call; anything else stays inside, where the kernel denies the read. `realpath` (the Mac's) must agree:
 * a symlink named like a store that points elsewhere doesn't qualify.
 */
export function macPrivateStoreRead(
  command: string,
  ctx: { home: string; cwd?: string | null; realpath?: (p: string) => string; isStore?: (abs: string) => boolean },
): string | null {
  const isStore = ctx.isStore ?? ((p: string) => macPrivateStorePath(p, ctx.home));
  const p = parseShell(command, { cwd: ctx.cwd ?? ctx.home, home: ctx.home });
  if (p.opaque.length > 0 || p.cmds.length !== 1 || p.compound || p.hasPipe || p.hasRedirect || p.hasSubstitution || p.background) return null;
  const c = p.cmds[0]!;
  if (!PLAIN_READERS.test(c.program) || c.argv[0]?.text !== c.program || c.wrappers.length > 0 || c.assigns.length > 0 || c.argsUnknown || c.redirects.length > 0 || c.stdin !== null || c.inlineCode.length > 0) return null;
  let store: string | null = null;
  for (const w of c.argv.slice(1)) {
    // No variables at all, even ones the parser knows ($HOME): the shell that runs it expands them from its own env.
    if (w.dynamic || w.glob || w.procSubst !== null || w.text !== w.literal || w.literal.includes("$")) return null;
    if (w.text.startsWith("-")) continue;
    if (COUNT_OK.test(c.program) && /^\d+$/.test(w.text)) continue;
    // Spelled from / or ~ only, so the Mac's policy and its executor (whose working folders are worked out apart)
    // always resolve it to the same file.
    if (w.headQuoted ? !w.text.startsWith("/") : !/^(\/|~\/)/.test(w.text)) return null;
    const abs = shPath(w, c.cwd ?? ctx.cwd ?? ctx.home, ctx.home);
    if (!abs || store !== null || !isStore(abs)) return null;
    store = abs;
  }
  if (!store) return null;
  if (ctx.realpath) {
    let real: string | null = null;
    try { real = ctx.realpath(store); } catch { /* missing: the read fails on its own */ }
    if (real !== null && !isStore(real)) return null;
  }
  return store;
}
