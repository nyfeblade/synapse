import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GITHUB_DEVICE_URL, GITHUB_SCOPES, STRGH, type GitHubSignInEvent, type SseEvent } from "@synapse/shared";
import { GH, GitHubSignIn, parseAuthStatus, parseDeviceCode, redactTokens, type GhProc, type GhResult, type GhRunner } from "../../github/signin";
import { ShellGhRunner } from "../../github/gh-runner";
import { parseTokenScopes } from "../../github/signin";
import type { ShellSpawner } from "../../background/shell-spawner";
import { botUserName } from "../../walls/bot-uid";
import { tmpConfig } from "../helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real gh output, as the Bot's unit writes it (stdout and stderr share the terminal file).
const LOGIN_TTYLESS = "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser... ";
const LOGIN_OLD = "\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[1mB7C9-XK2P\u001b[0m\nPress Enter to open github.com in your browser... \n";
const LOGIN_NO_BROWSER = "! First copy your one-time code: 9F8E-7D6C\nPress Enter to open github.com in your browser... \n! Failed opening a web browser at https://github.com/login/device\n  exec: \"xdg-open\": executable file not found in $PATH\n  Please try entering the URL in your browser manually\n";
const LOGIN_OPEN_URL = "! First copy your one-time code: WXYZ-2345\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
const LOGIN_DONE = "✓ Authentication complete.\n- gh config set -h github.com git_protocol https\n✓ Configured git protocol\n✓ Logged in as octocat\n";
// The login script's own clean-config `gh auth status`, printed after gh auth login succeeds.
const CLEAN_STATUS = (scopes: string) => `github.com\n  ✓ Logged in to github.com account octocat (/tmp/tmp.x/hosts.yml)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: ${scopes}\n`;
const DEFAULT_SCOPES = "'gist', 'read:org', 'repo'";

const STATUS_NEW = "github.com\n  ✓ Logged in to github.com account octocat (/home/bots/bot-aaaaaaaaaaaa/.config/gh/hosts.yml)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
const STATUS_TWO = "github.com\n  ✓ Logged in to github.com account old-me (/h/hosts.yml)\n  - Active account: false\n  ✓ Logged in to github.com account new-me (/h/hosts.yml)\n  - Active account: true\n";
const STATUS_OLD = "github.com\n  ✓ Logged in to github.com as hubot (/home/x/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: *******************\n";
const STATUS_OUT = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n";
const STATUS_OUT_OLD = "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n";
const STATUS_BAD = "github.com\n  X Failed to log in to github.com account octocat (default)\n  - Active account: true\n  - The token in default is invalid.\n";

describe("parsing gh's device-flow output", () => {
  it.each([
    ["gh 2.x without a TTY", LOGIN_TTYLESS, "1A2B-3C4D"],
    ["older gh, coloured", LOGIN_OLD, "B7C9-XK2P"],
    ["no browser on the box", LOGIN_NO_BROWSER, "9F8E-7D6C"],
    ["'Open this URL' wording", LOGIN_OPEN_URL, "WXYZ-2345"],
  ])("%s", (_name, text, code) => {
    expect(parseDeviceCode(text)).toEqual({ code, url: GITHUB_DEVICE_URL });
  });
  it("no code yet is null", () => {
    expect(parseDeviceCode("")).toBeNull();
    expect(parseDeviceCode("Press Enter to open github.com in your browser...")).toBeNull();
  });
});

describe("parsing gh auth status", () => {
  it("signed in (gh 2.40+ 'account' wording)", () => expect(parseAuthStatus(0, STATUS_NEW)).toEqual({ signedIn: true, login: "octocat" }));
  it("signed in, several accounts: the active one", () => expect(parseAuthStatus(0, STATUS_TWO)).toEqual({ signedIn: true, login: "new-me" }));
  it("signed in (older 'as' wording)", () => expect(parseAuthStatus(0, STATUS_OLD)).toEqual({ signedIn: true, login: "hubot" }));
  it("signed out", () => {
    expect(parseAuthStatus(1, STATUS_OUT)).toEqual({ signedIn: false, login: null });
    expect(parseAuthStatus(1, STATUS_OUT_OLD)).toEqual({ signedIn: false, login: null });
  });
  it("an invalid token is signed out", () => expect(parseAuthStatus(1, STATUS_BAD)).toEqual({ signedIn: false, login: null }));
  it("reads the token's scopes (gh 2.40+ quoted, older plain, none)", () => {
    expect(parseTokenScopes(CLEAN_STATUS(DEFAULT_SCOPES))).toEqual(["gist", "read:org", "repo"]);
    expect(parseTokenScopes("  ✓ Token scopes: gist, read:org, repo\n")).toEqual(["gist", "read:org", "repo"]);
    expect(parseTokenScopes("  - Token scopes: none\n")).toEqual([]);
    expect(parseTokenScopes("✓ Logged in as octocat\n")).toBeNull();
    expect([...GITHUB_SCOPES].sort()).toEqual(["gist", "read:org", "repo"]);
  });
  it("redacts anything shaped like a GitHub token", () => {
    const t = redactTokens("x gho_abcdefghijklmnopqrstuvwxyz0123456789 y github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz z ghs_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(t).not.toMatch(/gho_a|github_pat_1|ghs_A/);
  });
});

/** A scripted gh, one process per call; the test drives each process's output and exit. */
class ScriptedGh implements GhRunner {
  calls: { botId: string; args: readonly string[]; o?: { login?: boolean } }[] = [];
  procs: Scripted[] = [];
  onStart: (botId: string, args: readonly string[], p: Scripted) => void = () => {};
  async start(botId: string, args: readonly string[], o?: { login?: boolean }): Promise<GhProc> {
    this.calls.push({ botId, args, ...(o ? { o } : {}) });
    const p = new Scripted();
    this.procs.push(p);
    this.onStart(botId, args, p);
    return p;
  }
}
class Scripted implements GhProc {
  out = "";
  cancelled = false;
  private resolve!: (r: GhResult) => void;
  done = new Promise<GhResult>((r) => { this.resolve = r; });
  output() { return this.out; }
  write(s: string) { this.out += s; }
  exit(code: number) { this.resolve({ code, output: this.out }); }
  async cancel() { this.cancelled = true; this.exit(130); }
}

function setup(o: { timeoutMs?: number; busy?: (botId: string) => boolean } = {}) {
  const gh = new ScriptedGh();
  const events: GitHubSignInEvent[] = [];
  const all: string[] = [];
  const svc = new GitHubSignIn({
    runner: gh, publish: (e: SseEvent) => { all.push(JSON.stringify(e)); if (e.channel === "github") events.push(e.payload); },
    pollMs: 5, codeWaitMs: 500, timeoutMs: o.timeoutMs ?? 60_000, ...(o.busy ? { busy: o.busy } : {}),
  });
  // Every short command answers at once; the login waits for the test.
  gh.onStart = (_b, args, p) => {
    const a = args.join(" ");
    if (a === GH.setupGit.join(" ")) p.exit(0);
    else if (a === GH.apiUser.join(" ")) { p.write("octocat\n"); p.exit(0); }
    else if (args[1] === "logout") p.exit(0);
  };
  return { gh, events, all, svc };
}
const loginOf = (gh: ScriptedGh, i = 0) => gh.procs.filter((_p, k) => gh.calls[k]!.args[1] === "login")[i]!;

describe("GitHubSignIn", () => {
  it("returns the code and URL, then signs in with the default scopes, sets up git and reads the login, all as that Bot", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    expect(await started).toEqual({ code: "1A2B-3C4D", url: GITHUB_DEVICE_URL });
    // Default gh scopes only (no workflow), and the login runs isolated (a clean gh config, see gh-runner.ts).
    expect(s.gh.calls[0]).toEqual({ botId: "bot1", args: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"], o: { login: true } });
    expect(s.events).toEqual([{ botId: "bot1", state: "waiting", code: "1A2B-3C4D", url: GITHUB_DEVICE_URL }]);
    loginOf(s.gh).write(LOGIN_DONE + CLEAN_STATUS(DEFAULT_SCOPES));
    loginOf(s.gh).exit(0);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toEqual({ botId: "bot1", state: "signed-in", login: "octocat" });
    expect(s.gh.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["auth login", "auth setup-git"]);
    expect(s.gh.calls.every((c) => c.botId === "bot1")).toBe(true);
  });

  it("a gh that exits before printing a code fails the start with its reason", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n");
    loginOf(s.gh).exit(1);
    await expect(started).rejects.toThrow(/api\.github\.com|githubstatus/);
  });

  it("a failed sign-in after the code says why", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    loginOf(s.gh).write("\nfailed to authenticate via web browser: access_denied\n");
    loginOf(s.gh).exit(1);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toMatchObject({ botId: "bot1", state: "failed" });
    expect((s.events[1] as { reason: string }).reason).toMatch(/access_denied/);
  });

  it("gh reporting an expired code is 'expired'", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    loginOf(s.gh).write("\nfailed to authenticate via web browser: this 'device_code' has expired (expired_token)\n");
    loginOf(s.gh).exit(1);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toMatchObject({ state: "expired" });
  });

  it("times out: cancels gh and says the code expired", async () => {
    const s = setup({ timeoutMs: 40 });
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toMatchObject({ botId: "bot1", state: "expired" });
    expect(loginOf(s.gh).cancelled).toBe(true);
    s.gh.onStart = (_b, args, p) => { if (args[1] === "status") { p.write(STATUS_OUT); p.exit(1); } };
    expect((await s.svc.status("bot1")).pending).toBeNull();
  });

  it("one flow per Bot: a new start cancels the waiting one, which then says nothing", async () => {
    const s = setup();
    const a = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh, 0).write(LOGIN_TTYLESS);
    await a;
    const b = s.svc.start("bot1");
    await wait(10);
    expect(loginOf(s.gh, 0).cancelled).toBe(true);
    loginOf(s.gh, 1).write(LOGIN_OPEN_URL);
    expect((await b).code).toBe("WXYZ-2345");
    await wait(20);
    expect(s.events.map((e) => e.state)).toEqual(["waiting", "waiting"]);
  });

  it("flows for different Bots are independent", async () => {
    const s = setup();
    const a = s.svc.start("bot1");
    const b = s.svc.start("bot2");
    await wait(10);
    loginOf(s.gh, 0).write(LOGIN_TTYLESS);
    loginOf(s.gh, 1).write(LOGIN_OPEN_URL);
    await Promise.all([a, b]);
    expect(loginOf(s.gh, 0).cancelled).toBe(false);
  });

  async function undone(out: string, reason: RegExp) {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    loginOf(s.gh).write(LOGIN_DONE + out);
    loginOf(s.gh).exit(0);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toMatchObject({ botId: "bot1", state: "failed" });
    expect((s.events[1] as { reason: string }).reason).toMatch(reason);
    expect(s.gh.calls.find((c) => c.args[1] === "logout")?.args).toEqual(["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
    expect(s.gh.calls.some((c) => c.args[1] === "setup-git")).toBe(false);
  }
  it("a token with an extra scope is logged out again and reported", () => undone(CLEAN_STATUS("'gist', 'read:org', 'repo', 'workflow'"), /unexpected permissions.*workflow/i));
  it("a token with an admin scope is logged out again and reported", () => undone(CLEAN_STATUS("'admin:org', 'gist', 'read:org', 'repo'"), /unexpected permissions.*admin:org/i));
  it("a token whose scopes can't be read is logged out again and reported", () => undone("✓ Logged in as octocat\n", /couldn't check/i));

  it("fewer scopes than the default are fine", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    loginOf(s.gh).write(LOGIN_DONE + CLEAN_STATUS("'repo'"));
    loginOf(s.gh).exit(0);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.events[1]).toMatchObject({ state: "signed-in" });
  });

  it("won't start while the Bot is working (a turn or a shell could race the sign-in as the same uid)", async () => {
    const s = setup({ busy: (id) => id === "bot1" });
    await expect(s.svc.start("bot1")).rejects.toThrow(STRGH.busy);
    expect(s.gh.calls).toEqual([]);
    const other = s.svc.start("bot2");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    expect((await other).code).toBe("1A2B-3C4D");
  });

  it("a pending sign-in is cancelled the moment the Bot starts working (a turn, a Shell or a subagent)", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    s.svc.botStartedWorking("bot2"); // another Bot: nothing happens
    expect(loginOf(s.gh).cancelled).toBe(false);
    s.svc.botStartedWorking("bot1");
    expect(loginOf(s.gh).cancelled).toBe(true);
    expect(s.events.at(-1)).toEqual({ botId: "bot1", state: "failed", reason: STRGH.cancelledByWork });
    loginOf(s.gh).write(LOGIN_DONE + CLEAN_STATUS(DEFAULT_SCOPES));
    await wait(20);
    expect(s.events.map((e) => e.state)).toEqual(["waiting", "failed"]);
    s.svc.botStartedWorking("bot1"); // nothing pending: quiet
    expect(s.events).toHaveLength(2);
  });

  it("two starts at once: exactly one gh stays alive, the other is cancelled", async () => {
    const s = setup();
    const a = s.svc.start("bot1");
    const b = s.svc.start("bot1");
    const aOutcome = a.then(() => null, (e: Error) => e.message);
    await wait(10);
    expect(loginOf(s.gh, 0).cancelled).toBe(true);
    expect(loginOf(s.gh, 1).cancelled).toBe(false);
    loginOf(s.gh, 1).write(LOGIN_TTYLESS);
    expect(await aOutcome).toBe(STRGH.cancelled);
    expect((await b).code).toBe("1A2B-3C4D");
    expect(s.gh.procs.filter((p, k) => s.gh.calls[k]!.args[1] === "login" && !p.cancelled)).toHaveLength(1);
  });

  it("status parses gh auth status and shows a waiting code", async () => {
    const s = setup();
    s.gh.onStart = (_b, args, p) => { if (args[1] === "status") { p.write(STATUS_NEW); p.exit(0); } };
    expect(await s.svc.status("bot1")).toEqual({ signedIn: true, login: "octocat", pending: null });
    expect(s.gh.calls[0]).toEqual({ botId: "bot1", args: ["auth", "status", "--hostname", "github.com"] });
    s.gh.onStart = (_b, args, p) => { if (args[1] === "status") { p.write(STATUS_OUT); p.exit(1); } };
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    expect(await s.svc.status("bot1")).toEqual({ signedIn: false, login: null, pending: { code: "1A2B-3C4D", url: GITHUB_DEVICE_URL } });
  });

  it("sign out logs that account out non-interactively and cancels a waiting flow", async () => {
    const s = setup();
    let signedIn = true;
    s.gh.onStart = (_b, args, p) => {
      if (args[1] === "status") { p.write(signedIn ? STATUS_NEW : STATUS_OUT); p.exit(signedIn ? 0 : 1); }
      if (args[1] === "logout") { signedIn = false; p.exit(0); }
    };
    expect(await s.svc.signOut("bot1")).toEqual({ signedIn: false, login: null, pending: null });
    expect(s.gh.calls.find((c) => c.args[1] === "logout")!.args).toEqual(["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
    expect(s.events.at(-1)).toEqual({ botId: "bot1", state: "signed-out" });
  });

  it("no token ever reaches an event", async () => {
    const s = setup();
    const started = s.svc.start("bot1");
    await wait(10);
    loginOf(s.gh).write(LOGIN_TTYLESS);
    await started;
    loginOf(s.gh).write("\nerror: token gho_abcdefghijklmnopqrstuvwxyz0123456789 rejected\n");
    loginOf(s.gh).exit(1);
    await vi_waitFor(() => s.events.length === 2);
    expect(s.all.join("\n")).not.toMatch(/gho_[A-Za-z0-9]{10}/);
  });
});

describe("ShellGhRunner runs gh as the Bot's own account", () => {
  it("starts a bot-shell unit under the Bot's account with a token-free env, and reads its output", async () => {
    const cfg = { ...tmpConfig(), perBotUid: true, botHomes: "/home/bots" };
    const starts: unknown[][] = [];
    let script = "", env = "";
    const spawner: ShellSpawner = {
      async start(id, cwd, account, botId) {
        starts.push([id, cwd, account, botId]);
        script = fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.sh`), "utf8");
        env = fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.env`), "utf8");
        const term = path.join(cfg.workspace, ".host-out", "terminals", botId!, `${id}.txt`);
        setTimeout(() => fs.appendFileSync(term, `${STATUS_NEW}\n---\nexit_code: 0\nelapsed_ms: 5\nended_at: 1\ncwd: /\n---\n`), 10);
      },
      async stop() {},
      async status() { return "running"; },
    };
    const runner = new ShellGhRunner({ cfg, spawner, pollMs: 5 });
    const p = await runner.start("bot1", GH.status);
    const r = await p.done;
    expect(r).toEqual({ code: 0, output: STATUS_NEW });
    const acct = botUserName("bot1");
    expect(starts).toEqual([[expect.stringMatching(/^shell-gh-[a-f0-9]+$/), `/home/bots/${acct}`, acct, "bot1"]]);
    expect(script).toContain("/usr/bin/gh 'auth' 'status' '--hostname' 'github.com'");
    expect(script).toMatch(/unset GH_TOKEN GITHUB_TOKEN/);
    expect(env).toContain(`HOME="/home/bots/${acct}"`);
    expect(env).not.toMatch(/OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN/);
    // Nothing is left behind: the script, the env file and the transcript are gone.
    expect(fs.readdirSync(path.join(cfg.hostPrivate, "run"))).toEqual([]);
    expect(fs.readdirSync(path.join(cfg.workspace, ".host-out", "terminals", "bot1"))).toEqual([]);
  });

  it("refuses when the box has no per-Bot accounts (never runs gh as a shared uid)", async () => {
    const cfg = { ...tmpConfig(), perBotUid: false };
    const spawner = { start: async () => { throw new Error("must not start"); }, stop: async () => {}, status: async () => "stopped" as const };
    await expect(new ShellGhRunner({ cfg, spawner }).start("bot1", GH.status)).rejects.toThrow(/own account/);
  });

  it("cancel stops the unit, settles and removes its terminal file", async () => {
    const cfg = { ...tmpConfig(), perBotUid: true, botHomes: "/home/bots" };
    const stopped: string[] = [];
    const spawner: ShellSpawner = { async start() {}, async stop(id) { stopped.push(id); }, async status() { return "running"; } };
    const p = await new ShellGhRunner({ cfg, spawner, pollMs: 5 }).start("bot1", GH.login, { login: true });
    const dir = path.join(cfg.workspace, ".host-out", "terminals", "bot1");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    await p.cancel();
    expect((await p.done).code).not.toBe(0);
    expect(stopped).toHaveLength(1);
    await vi_waitFor(() => fs.readdirSync(dir).length === 0);
  });

  it("the sign-in runs gh with a fresh, empty gh config (never the Bot's config.yml) and no proxies, then saves hosts.yml", async () => {
    const cfg = { ...tmpConfig(), perBotUid: true, botHomes: "/home/bots" };
    let script = "";
    const spawner: ShellSpawner = {
      async start(id) { script = fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.sh`), "utf8"); },
      async stop() {}, async status() { return "running"; },
    };
    const p = await new ShellGhRunner({ cfg, spawner, pollMs: 5 }).start("bot1", GH.login, { login: true });
    await p.cancel();
    expect(script).toMatch(/d="\$\(mktemp -d\)"/);
    expect(script).toMatch(/export GH_CONFIG_DIR="\$d"/);
    expect(script).toMatch(/unset [^\n]*HTTPS_PROXY[^\n]*https_proxy[^\n]*ALL_PROXY/);
    expect(script).toMatch(/http_unix_socket/);
    // The clean-config status (the scope check reads it), then the login is saved into the Bot's own config.
    expect(script.indexOf("/usr/bin/gh 'auth' 'login'")).toBeLessThan(script.indexOf("/usr/bin/gh auth status --hostname github.com"));
    expect(script).toMatch(/install -m 600 "\$d\/hosts\.yml" "\$HOME\/\.config\/gh\/hosts\.yml"/);
    // S3: the Bot's own folder to clone into and push from (0700 in its 0700 home), made if it is missing.
    expect(script).toContain('[ -d "$HOME/code" ] || mkdir -m 700 "$HOME/code"');
  });

  it("sweeps gh units and files a previous host left behind, and nothing else", async () => {
    const cfg = { ...tmpConfig(), perBotUid: true, botHomes: "/home/bots" };
    const dir = path.join(cfg.workspace, ".host-out", "terminals", "bot1");
    const run = path.join(cfg.hostPrivate, "run");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(run, { recursive: true });
    for (const f of ["shell-gh-abc123.txt", "shell-7.txt"]) fs.writeFileSync(path.join(dir, f), "");
    for (const f of ["shell-gh-abc123.sh", "shell-gh-abc123.env", "shell-7.sh"]) fs.writeFileSync(path.join(run, f), "");
    const stopped: string[] = [];
    const spawner: ShellSpawner = { async start() {}, async stop(id) { stopped.push(id); }, async status() { return "stopped"; } };
    await new ShellGhRunner({ cfg, spawner }).sweep();
    expect(stopped).toEqual(["shell-gh-abc123"]);
    expect(fs.readdirSync(dir)).toEqual(["shell-7.txt"]);
    expect(fs.readdirSync(run)).toEqual(["shell-7.sh"]);
  });
});

async function vi_waitFor(ok: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(5);
  }
}
