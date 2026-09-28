import { GITHUB_DEVICE_URL, GITHUB_SCOPES, GITHUB_SIGNIN_TIMEOUT_MS, STRGH, type GitHubSignInEvent, type GitHubStatusView, type SseEvent } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { log } from "../util/log";

/**
 * Bug-log 195: "Sign in to GitHub" for one Bot. The user's click runs GitHub's normal browser device flow with the
 * Bot's own `gh`, as the Bot's own OS account (github/gh-runner.ts), so the login lands in that Bot's
 * ~/.config/gh/hosts.yml and its gh just works from then on. The host only ever sees gh's human output (the one-time
 * code, "Logged in as …"); the token stays in the Bot's home and is scrubbed from anything this module emits or logs.
 * A gateway command from the user's own click, so no approval card: the approval gate only sees Bot tool calls.
 */

export interface GhResult { code: number; output: string }
/** One gh process running as a Bot. `output()` is everything it printed so far (stdout and stderr). */
export interface GhProc { output(): string; done: Promise<GhResult>; cancel(): Promise<void> }
/** `login`: the device-flow sign-in, run with a fresh gh config and saved into the Bot's own (gh-runner.ts). */
export interface GhRunner { start(botId: string, args: readonly string[], o?: { login?: boolean }): Promise<GhProc> }

export const GH = {
  // --insecure-storage: the box has no keyring, so the login is the Bot's hosts.yml (0600 in its 0700 home).
  // gh's default scopes only (GITHUB_SCOPES): never workflow, which would let a Bot push .github/workflows.
  login: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"],
  status: ["auth", "status", "--hostname", "github.com"],
  logout: (user: string | null) => ["auth", "logout", "--hostname", "github.com", ...(user ? ["--user", user] : [])],
  setupGit: ["auth", "setup-git", "--hostname", "github.com"],
  apiUser: ["api", "user", "--jq", ".login"],
} as const satisfies Record<string, readonly string[] | ((u: string | null) => string[])>;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const strip = (t: string) => t.replace(ANSI, "").replace(/\r/g, "");

/** Anything shaped like a GitHub token (classic gh*_ and fine-grained github_pat_) becomes "[redacted]". */
export function redactTokens(t: string): string {
  return t.replace(/\bgh[opusr]_[A-Za-z0-9]{16,}\b/g, "[redacted]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
}

/** gh prints "! First copy your one-time code: XXXX-XXXX" (and, in some versions, the device URL) on stderr. */
export function parseDeviceCode(text: string): { code: string; url: string } | null {
  const t = strip(text);
  const m = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(t);
  if (!m) return null;
  // The only device page this flow uses is github.com's own; gh may name it or just say "github.com".
  return { code: m[1]!.toUpperCase(), url: GITHUB_DEVICE_URL };
}

/** `gh auth status --hostname github.com`: signed in only on exit 0 with a "✓ Logged in" line (the active one wins). */
export function parseAuthStatus(exitCode: number, text: string): { signedIn: boolean; login: string | null } {
  if (exitCode !== 0) return { signedIn: false, login: null };
  const lines = strip(text).split("\n");
  let first: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /✓\s*Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(lines[i]!);
    if (!m) continue;
    first ??= m[1]!;
    const next = lines.slice(i + 1).find((l) => /Active account:|Logged in to|Failed to log in/.test(l));
    if (next && /Active account:\s*true/.test(next)) return { signedIn: true, login: m[1]! };
  }
  return first ? { signedIn: true, login: first } : { signedIn: false, login: null };
}

/** The "Token scopes:" line of `gh auth status` ('a', 'b' in gh 2.40+, a, b before; "none"); null when absent. */
export function parseTokenScopes(text: string): string[] | null {
  const m = /Token scopes:[ \t]*(.*)$/m.exec(strip(text));
  if (!m) return null;
  const v = m[1]!.trim();
  if (!v || /^none$/i.test(v)) return [];
  return v.split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
}

/** The account a finished sign-in names: the clean status line, else gh login's own "Logged in as". */
function signedInLogin(output: string): string | null {
  const a = parseAuthStatus(0, output).login;
  if (a) return a;
  return /✓\s*Logged in as ([A-Za-z0-9-]{1,39})\b/.exec(strip(output))?.[1] ?? null;
}

/** The line that says what went wrong: gh's last meaningful line, without the code prompt, tokens scrubbed. */
function reasonOf(output: string): string {
  const lines = strip(output).split("\n").map((l) => l.trim()).filter((l) => l && !/one-time code|Press Enter|Open this URL|Please try entering|Failed opening a web browser|^exec: /.test(l));
  return redactTokens(lines.at(-1) ?? "gh exited without saying why").slice(0, 200);
}

interface Flow { proc: GhProc | null; code: string | null; url: string | null; over: boolean; timer?: NodeJS.Timeout }

export interface GitHubSignInDeps {
  runner: GhRunner;
  publish(e: SseEvent): void;
  timeoutMs?: number;
  /** How long gh may take to print the code. */
  codeWaitMs?: number;
  pollMs?: number;
  /**
   * Security re-check N2: the sign-in runs as the Bot's uid, so a Bot process already running (a turn, a shell, a
   * subagent) could race the fresh gh config or write into the unit's output. Sign-in starts only on an idle Bot.
   */
  busy?(botId: string): boolean;
}

export class GitHubSignIn {
  private flows = new Map<string, Flow>();
  constructor(private d: GitHubSignInDeps) {}

  private emit(p: GitHubSignInEvent): void {
    // Belt and braces: the only free text is a reason, and it was scrubbed already.
    const payload = JSON.parse(redactTokens(JSON.stringify(p))) as GitHubSignInEvent;
    this.d.publish({ channel: "github", payload });
  }

  private async run(botId: string, args: readonly string[], timeoutMs = 60_000): Promise<GhResult> {
    const p = await this.d.runner.start(botId, [...args]);
    let t: NodeJS.Timeout | undefined;
    const late = new Promise<GhResult>((r) => { t = setTimeout(() => { void p.cancel(); r({ code: 124, output: `gh ${args[0]} ${args[1]} timed out` }); }, timeoutMs); });
    try { return await Promise.race([p.done, late]); } finally { clearTimeout(t); }
  }

  /** Ends a waiting flow quietly (a new start, a sign-out, a deleted Bot). */
  cancel(botId: string): void {
    const f = this.flows.get(botId);
    if (!f) return;
    this.flows.delete(botId);
    f.over = true;
    clearTimeout(f.timer);
    void f.proc?.cancel().catch(() => {});
  }

  /**
   * Security re-check S2: a pending sign-in is cancelled the moment its Bot starts working (a turn, a Shell, a
   * subagent), since that process would run as the same uid as the flow. Wired from the runner and both services.
   */
  botStartedWorking(botId: string): void {
    if (!this.flows.has(botId)) return;
    this.cancel(botId);
    this.emit({ botId, state: "failed", reason: STRGH.cancelledByWork });
  }

  async start(botId: string): Promise<{ code: string; url: string }> {
    if (this.d.busy?.(botId)) throw new GatewayError("GITHUB_BOT_BUSY", STRGH.busy, 409);
    this.cancel(botId);
    // Held before the await, so a second start while this gh is still starting cancels it, not orphans it.
    const flow: Flow = { proc: null, code: null, url: null, over: false };
    this.flows.set(botId, flow);
    let proc: GhProc;
    try {
      proc = await this.d.runner.start(botId, GH.login, { login: true });
    } catch (e) {
      if (this.flows.get(botId) === flow) this.flows.delete(botId);
      throw e;
    }
    flow.proc = proc;
    if (flow.over) {
      void proc.cancel().catch(() => {});
      throw new GatewayError("GITHUB_SIGNIN_FAILED", STRGH.cancelled);
    }
    const st: { exited: GhResult | null } = { exited: null };
    void proc.done.then((r) => { st.exited = r; });
    const pollMs = this.d.pollMs ?? 250;
    const giveUp = Date.now() + (this.d.codeWaitMs ?? 30_000);
    let got: { code: string; url: string } | null = null;
    for (;;) {
      got = parseDeviceCode(proc.output());
      if (got || flow.over) break;
      if (st.exited || Date.now() > giveUp) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!got) {
      const why = st.exited && !flow.over ? reasonOf(st.exited.output) : flow.over ? STRGH.cancelled : STRGH.noCode;
      if (this.flows.get(botId) === flow) this.cancel(botId);
      log.warn("github sign-in did not start", { botId, reason: why });
      throw new GatewayError("GITHUB_SIGNIN_FAILED", why);
    }
    flow.code = got.code;
    flow.url = got.url;
    this.emit({ botId, state: "waiting", ...got });
    flow.timer = setTimeout(() => {
      if (this.flows.get(botId) !== flow) return;
      this.cancel(botId);
      this.emit({ botId, state: "expired", reason: STRGH.expired });
    }, this.d.timeoutMs ?? GITHUB_SIGNIN_TIMEOUT_MS);
    flow.timer.unref?.();
    void proc.done.then((r) => this.finish(botId, flow, r));
    return got;
  }

  private async finish(botId: string, flow: Flow, r: GhResult): Promise<void> {
    if (flow.over || this.flows.get(botId) !== flow) return;
    this.flows.delete(botId);
    flow.over = true;
    clearTimeout(flow.timer);
    if (r.code !== 0) {
      const reason = reasonOf(r.output);
      log.warn("github sign-in failed", { botId, reason });
      this.emit(/expired|expired_token/i.test(reason) ? { botId, state: "expired", reason: STRGH.expired } : { botId, state: "failed", reason });
      return;
    }
    // Signed in. The token must carry gh's default scopes and nothing more (read from the login script's own
    // clean-config `gh auth status`); anything else, or no way to tell, is undone at once.
    let login = signedInLogin(r.output);
    const scopes = parseTokenScopes(r.output);
    const allowed: readonly string[] = GITHUB_SCOPES;
    const extra = scopes?.filter((x) => !allowed.includes(x)) ?? [];
    if (!scopes || extra.length) {
      await this.run(botId, GH.logout(login), 30_000).catch(() => null);
      const reason = scopes ? STRGH.unexpectedScopes(extra) : STRGH.scopesUnchecked;
      log.warn("github sign-in had unexpected permissions; logged out", { botId, reason });
      this.emit({ botId, state: "failed", reason });
      return;
    }
    // git over https uses gh as its credential helper (the git shim passes exactly that one through).
    const git = await this.run(botId, GH.setupGit).catch((e: unknown) => ({ code: 1, output: String(e) }));
    if (git.code !== 0) log.warn("gh auth setup-git failed", { botId, reason: reasonOf(git.output) });
    if (!login) {
      const who = await this.run(botId, GH.apiUser).catch(() => ({ code: 1, output: "" }));
      login = who.code === 0 ? /^[A-Za-z0-9-]{1,39}$/.exec(strip(who.output).trim())?.[0] ?? null : null;
    }
    log.info("github signed in", { botId, login });
    this.emit({ botId, state: "signed-in", login });
  }

  async status(botId: string): Promise<GitHubStatusView> {
    const f = this.flows.get(botId);
    const r = await this.run(botId, GH.status, 30_000);
    return { ...parseAuthStatus(r.code, r.output), pending: f?.code && f.url ? { code: f.code, url: f.url } : null };
  }

  async signOut(botId: string): Promise<GitHubStatusView> {
    this.cancel(botId);
    const before = await this.status(botId);
    if (before.signedIn) {
      const r = await this.run(botId, GH.logout(before.login), 30_000);
      if (r.code !== 0) throw new GatewayError("GITHUB_SIGNOUT_FAILED", reasonOf(r.output));
    }
    this.emit({ botId, state: "signed-out" });
    return this.status(botId);
  }
}

export function createGitHubCommands(d: { signIn: GitHubSignIn; botExists(id: string): boolean }): CommandHandlers {
  const bot = (id: unknown): string => {
    if (typeof id !== "string" || !d.botExists(id)) throw new GatewayError("NOT_FOUND", "No such Bot", 404);
    return id;
  };
  return {
    getGitHubStatus: (a) => d.signIn.status(bot(a.id)),
    startGitHubSignIn: (a) => d.signIn.start(bot(a.id)),
    signOutGitHub: (a) => d.signIn.signOut(bot(a.id)),
  };
}
