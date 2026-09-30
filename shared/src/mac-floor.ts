/**
 * The Mac floor patterns, shared by the host's static pass (host/review/mac-floor.ts) and the Mac's own
 * local-exec policy (app/src/coordinator/local-exec), so both sides agree on what always needs a card.
 * Pure regex/text code: no node imports (the renderer imports @synapse/shared too).
 *
 * Final secfix item 2: every pattern is case-insensitive (APFS is), and a glob, brace or tilde expansion
 * in a path under ~ (or ~/Library) is zsh-opaque: the static text can't say which file it names.
 */
import { inOrder } from "./linear-text";

/** Bug 433: curl|wget|fetch, then on the same stretch (no newline, `;` or `&` between) a pipe into a shell. */
const pipeToShell = (t: string): boolean => inOrder(t, [/\b(curl|wget|fetch)\b/i, /\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|c|tc|fi)?sh\b/i], /[\n;&]/);
/** The other pipe-to-shell shapes. Bug 433: `sh\s+(-c\s+)?["']?\s*<\(` let two runs of spaces split one run every way
 *  (quadratic on a long one); this spelling matches the same text. */
const PIPE_TO_SHELL_MORE = /\b(ba|z)?sh\s+(?:-c\s+)?(?:["']\s*)?<\(\s*(curl|wget)|\b(source|\.)\s+<\(\s*(curl|wget)|\beval\s+["']?\$\(\s*(curl|wget)/i;

/** A floor pattern: a regex, or (bug 433) a linear-time test for what a backtracking regex used to find. */
export const MAC_FLOOR: [RegExp | ((text: string) => boolean), string, "F7" | "F8" | "F9"][] = [
  [/(^|[^\w])\.ssh(\/|\b|$)/i, "mac_ssh_keys", "F7"],
  [/Library\/Keychains/i, "mac_keychain", "F7"],
  [/(^|[\s;&|(`{]|\$\()(sudo\s+)?security(\s|$)/i, "mac_security_cli", "F7"],
  [/Library\/Application(\\ |\s|%20|\*|\?)?Support|Application Support/i, "mac_app_support", "F8"],
  [/Library\/Launch(Agents|Daemons)|(^|[\s;&|(])(sudo\s+)?(launchctl|crontab)\b/i, "mac_persistence", "F8"],
  [/(^|[\s/'"=:<>~])\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|profile|inputrc)\b|\/etc\/(zshrc|zprofile|zshenv|profile|bashrc)\b/i, "mac_shell_rc", "F8"],
  [(t) => pipeToShell(t) || PIPE_TO_SHELL_MORE.test(t), "mac_pipe_to_shell", "F9"],
  [/(^|[\s;&|(`]|\$\()(sudo\s+)?(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|tftp|telnet|ssh|rsync|sendmail|mail|mutt|osascript)(\s|$)/i, "mac_network_send", "F7"],
  [/\b(urllib|requests\.(get|post|put)|http\.client|httplib|socket\.|fetch\(|XMLHttpRequest|Net::HTTP|LWP::|IO::Socket|open-uri|net\.connect|https?\.request)/i, "mac_network_send", "F7"],
];

/** zsh-specific expansions: glob qualifiers that run code ((e:…) (+func)), =cmd path expansion, ${(flags)…}. */
export const ZSH_OPAQUE = /\([^()\n]*\be:|\(\+\w|(^|[\s;&|(])=[A-Za-z_./]/;
/** `${(flags)…}`: what `/\$\{\([^)]*\)/` found (a `)` anywhere after the first `${(`), without its quadratic retries. */
function zshParamFlags(text: string): boolean {
  const i = text.indexOf("${(");
  return i >= 0 && text.indexOf(")", i + 3) >= 0;
}

const GLOB = /[*?[\]{}]/;
const NON_ASCII_LETTER = /(?![\x00-\x7f])\p{L}/u;
/** A word that may name a place under the user's home: anything but a flag. Final secfix round 2 (ruling A): an
 *  absolute (/U?ers/…) or variable-led ($PWD/…) glob word reaches home as easily as ~/… or a relative one. */
const UNDER_HOME = /^[^-]/;

/**
 * Final secfix item 2: true when some path word would be expanded by zsh before the command sees it —
 * ~name / ~+ / ~- / ~1 (named-directory and stack expansion), or a glob/brace char in a word under ~.
 * Words that start with a quote are left alone (zsh doesn't expand inside quotes).
 */
export function macPathExpansion(text: string): boolean {
  for (const raw of text.split(/[\s;&|()<>`]+/)) {
    const w = raw.replace(/^[A-Za-z_][A-Za-z0-9_]*=|^--?[A-Za-z0-9-]+=/, "");
    if (!w) continue;
    // Final secfix round 2 (ruling A): a quote next to a glob (".s"?h) still globs in zsh.
    if (/['"]/.test(w) && GLOB.test(w)) return true;
    if (w.startsWith("'") || w.startsWith("\"")) continue;
    if (/^~[^/]/.test(w)) return true;
    if (GLOB.test(w) && UNDER_HOME.test(w)) return true;
  }
  return false;
}

/** The floor categories (and signal names) a piece of text hits. */
export function macFloorHits(text: string): { signals: string[]; floors: Set<"F7" | "F8" | "F9"> } {
  const signals: string[] = [];
  const floors = new Set<"F7" | "F8" | "F9">();
  for (const [re, signal, f] of MAC_FLOOR) if (typeof re === "function" ? re(text) : re.test(text)) { signals.push(signal); floors.add(f); }
  return { signals, floors };
}

/** zsh-opaque: a zsh-only construct (commands only) or a path expansion the static text can't resolve. */
export function macOpaque(text: string, o: { command?: boolean } = {}): boolean {
  // Final secfix round 2 (ruling A): a non-ASCII letter can case-fold onto an ASCII one on APFS (U+017F ſ → s,
  // U+212A Kelvin → k), so the static text can't say which file it names.
  return NON_ASCII_LETTER.test(text) || (o.command !== false && (ZSH_OPAQUE.test(text) || zshParamFlags(text))) || macPathExpansion(text);
}

// Final secfix round 2 (ruling A): the grant criterion is now macAutoRunEligible (./mac-autorun), an allowlist by location.
