import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_LOGIN_VARS, MAC_CLAUDE_CONFIG_DIR, SENTINEL_API_KEY, SENTINEL_BASE_URL, assertNoClaudeLogin, claudeEnv, scrubClaudeLogin } from "@synapse/shared";

/**
 * synapse-public: the Bots' claude on this Mac reaches Anthropic only with the Anthropic API key (a per-run token for
 * the coordinator's key proxy). Review round 3 (S6): the list of login variables and the env builder are the shared
 * ones (shared/src/claude-env.ts), so the Mac and the box can never disagree; this file only adds the Mac's parts.
 */
export const MAC_LOGIN_SCRUB = CLAUDE_LOGIN_VARS;
export const MAC_SENTINEL_KEY = SENTINEL_API_KEY;
export const MAC_SENTINEL_BASE_URL = SENTINEL_BASE_URL;

/** A copy of `env` with every Claude sign-in removed (the shared list). */
export function scrubMacLogin<E extends Record<string, string | undefined>>(env: E): E {
  return scrubClaudeLogin(env);
}

/**
 * Review round 3 (S6): THE env of every run the executor starts, wrapped or not. It goes through the shared claudeEnv,
 * so every login variable is deleted and a runtime check proves none survived:
 *  - `grant` (this run's key-proxy token): the token and its base URL, plus the Savings prompt-cache TTL;
 *  - no grant: the dead sentinel pair (a claude the command parser missed can't fall back to a stored login);
 *  - `claudeConfigDir`: the app-owned config dir a wrapped claude uses, or the empty one an exempt tool gets.
 */
export function macRunEnv(base: Record<string, string | undefined>, o: { grant?: { token: string; baseUrl: string } | null; claudeConfigDir?: string; cacheTtl?: "5m" | "1h" }): Record<string, string> {
  const env = claudeEnv(base, o.grant ? { apiKey: o.grant.token, baseUrl: o.grant.baseUrl } : { apiKey: null });
  if (o.claudeConfigDir) env.CLAUDE_CONFIG_DIR = o.claudeConfigDir;
  if (o.grant) env.CLAUDE_CODE_PROMPT_CACHE_TTL = o.cacheTtl ?? "1h";
  assertNoClaudeLogin(env, { apiKey: env.ANTHROPIC_API_KEY });
  return env;
}

/** Kept for callers that only need the dead pair on an env (every login var gone first). */
export function withLoginSentinel<E extends Record<string, string | undefined>>(env: E): E {
  return macRunEnv(env, {}) as unknown as E;
}

/**
 * Review round 3 (S2c): the claude config dir an exempt (unsandboxed) tool gets: empty, app-owned, 0700, in userData.
 * A claude such a tool starts finds no settings, no login file there; with the sentinel key it can't sign in either.
 */
export const CLAUDE_EMPTY_CONFIG_DIR = "claude-empty";
export function emptyClaudeConfigDir(userData: string): string {
  const d = path.join(userData, CLAUDE_EMPTY_CONFIG_DIR);
  try {
    const st = fs.lstatSync(d);
    if (!st.isDirectory()) { fs.rmSync(d, { force: true }); fs.mkdirSync(d, { mode: 0o700 }); }
  } catch {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(d, 0o700);
  // Anything a previous run left there goes, so it is empty again for this one (plain files and links only; a link is
  // removed itself, never followed).
  for (const n of fs.readdirSync(d)) {
    const f = path.join(d, n);
    try { const st = fs.lstatSync(f); if (st.isFile() || st.isSymbolicLink()) fs.unlinkSync(f); } catch { /* gone */ }
  }
  return d;
}

/** Security review S2: a Claude login command in a Bot's run (the API key is the only sign-in). */
export const MAC_CLAUDE_LOGIN_REFUSED_MSG = "Bots can't sign claude in to a Claude account on this Mac. claude uses the Anthropic API key from Settings → Account.";
/**
 * claude's own sign-in subcommands (auth + login, the /login slash command, the long-lived token setup). Review round 3
 * (S2): this is ONLY a friendly early message for the plain spellings. It is not the defence: quoting, variables, a
 * copied binary or base64 get past any pattern. What holds is where the credential lives: every run carries the dead
 * sentinel key, the sandbox read-denies every Claude login file and the keychain, and exempt tools get an empty config.
 */
const LOGIN_COMMAND = /\bclaude\b[^;&|\n]*?(?:\bauth\s+login\b|(?:^|\s|['"])\/login\b|\bsetup[-]token\b)/;
export function isClaudeLoginCommand(command: string): boolean {
  return LOGIN_COMMAND.test(command);
}

/** The Bots-only Claude login token an older install kept in the app's data folder (before synapse-public). */
export const LEGACY_MAC_CLAUDE_TOKEN_FILE = "mac-claude-token.bin";
/** The login file claude writes into its config dir (here: only ever the app-owned MAC_CLAUDE_CONFIG_DIR, never ~/.claude). */
const CREDENTIALS_FILE = ".credentials.json";

/**
 * Review round 3 (D3): remove one entry without a check-then-act race. It is first renamed to a trash name in the same
 * directory (rename acts on the entry itself: a link is moved, never its target); then the trash name is lstat'ed: a
 * link is unlinked (only the link), a plain file removed, anything else (a directory planted there) left as it is.
 * True if something was removed.
 */
const trashName = (): string => `.synapse-retire-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.trash`;
function retire(f: string): boolean {
  const trash = path.join(path.dirname(f), trashName());
  try { fs.renameSync(f, trash); } catch { return false; } // none (or not ours to move)
  try {
    const st = fs.lstatSync(trash);
    if (st.isSymbolicLink() || st.isFile()) { fs.unlinkSync(trash); return true; }
  } catch { /* gone meanwhile */ }
  return false;
}

/**
 * Review round 3 re-review (D3): the app-owned config dir is itself renamed to a trash name first (rename moves the
 * entry, a link is never followed), and only then is the moved entry looked at. A link (or a file) planted where the
 * dir belongs is unlinked, only the link; a real directory has its login file retired and is moved back to its name.
 * Nothing is lstat'ed before the move, so a swap for a link to ~/.claude between a check and the move can't happen:
 * there is no check before the move, and the move of a link carries only the link.
 */
function retireConfigDirLogin(dir: string): boolean {
  const trash = path.join(path.dirname(dir), trashName());
  try { fs.renameSync(dir, trash); } catch { return false; } // no config dir (or not ours to move)
  let st: fs.Stats;
  try { st = fs.lstatSync(trash); } catch { return false; }
  if (!st.isDirectory()) {
    try { fs.unlinkSync(trash); } catch { /* gone meanwhile */ }
    return st.isFile() || st.isSymbolicLink();
  }
  const removed = retire(path.join(trash, CREDENTIALS_FILE));
  try { fs.renameSync(trash, dir); } catch {
    // Something took the name meanwhile: the moved dir is ours, a real directory (links inside are removed, never followed).
    try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* left for the next start */ }
  }
  return removed;
}

/**
 * Migration (synapse-public; security review S2, S5, round 3 D3): the old Bots-only Claude login goes when the
 * coordinator starts: the token file in the app's data folder and any leftover `mac-claude-token.bin.*.tmp` beside it,
 * and a `.credentials.json` in the app-owned config dir (`home/.synapse/claude-mac`). Each is renamed away first, then
 * only the link or the plain file is removed: nothing is ever followed into the user's ~/.claude, and the keychain is
 * never touched. True if anything was removed.
 */
export function retireMacClaudeLogin(userData: string, home: string = os.homedir()): boolean {
  let removed = retire(path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE));
  let names: string[] = [];
  try { names = fs.readdirSync(userData); } catch { /* no data folder yet */ }
  for (const n of names) if (n.startsWith(`${LEGACY_MAC_CLAUDE_TOKEN_FILE}.`) && n.endsWith(".tmp") && retire(path.join(userData, n))) removed = true;
  if (retireConfigDirLogin(path.join(home, MAC_CLAUDE_CONFIG_DIR))) removed = true;
  return removed;
}
