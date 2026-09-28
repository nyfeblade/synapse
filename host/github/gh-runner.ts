import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STRGH } from "@synapse/shared";
import { buildBotEnv } from "../brain/spawn-options";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { ShellSpawner } from "../background/shell-spawner";
import { createTerminalFile, envFileText, parseTerminal, terminalDirFor, terminalFileFor } from "../background/shells";
import { botOsUser } from "../walls/bot-uid";
import type { GhProc, GhResult, GhRunner } from "./signin";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Bug-log 195: runs /usr/bin/gh as the Bot's own OS account through the existing root helper bot-shell (a transient
 * systemd unit under the Bot's uid, stdin /dev/null, its output appended to the Bot's private terminal file, which
 * the host owns and reads). Never as bothost, root or the shared uid box: a box without per-Bot accounts refuses.
 * The unit's env is the Bot env baseline with no secrets (buildBotEnv, token null), and the script clears any GitHub
 * token variable so gh uses (and writes) the Bot's own hosts.yml. The transcript is deleted once gh exits.
 */
export class ShellGhRunner implements GhRunner {
  constructor(private d: { cfg: HostConfig; spawner: ShellSpawner; pollMs?: number }) {}

  /** Host start: stop any gh unit a previous host left running and remove its transcript and run files. */
  async sweep(): Promise<void> {
    const { cfg, spawner } = this.d;
    const ls = (dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } };
    const root = path.join(cfg.workspace, ".host-out", "terminals");
    for (const bot of ls(root)) {
      for (const f of ls(path.join(root, bot))) {
        const m = /^(shell-gh-[a-f0-9]+)\.txt$/.exec(f);
        if (!m) continue;
        await spawner.stop(m[1]!).catch(() => {});
        fs.rmSync(path.join(root, bot, f), { force: true });
      }
    }
    const run = path.join(cfg.hostPrivate, "run");
    for (const f of ls(run)) if (/^shell-gh-[a-f0-9]+\.(sh|env)$/.test(f)) fs.rmSync(path.join(run, f), { force: true });
  }

  async start(botId: string, args: readonly string[], o: { login?: boolean } = {}): Promise<GhProc> {
    const { cfg, spawner } = this.d;
    const u = botOsUser(cfg, botId);
    if (!u) throw new GatewayError("GITHUB_NO_ACCOUNT", STRGH.needsOwnAccount, 409);
    const id = `shell-gh-${randomBytes(6).toString("hex")}`;
    fs.mkdirSync(terminalDirFor(cfg, botId), { recursive: true, mode: 0o750 });
    const runDir = path.join(cfg.hostPrivate, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const term = terminalFileFor(cfg, botId, id);
    createTerminalFile(term, 0o640, `---\ncommand: gh ${args.slice(0, 2).join(" ")}\nstatus: running\n---\n`);
    const gh = `/usr/bin/gh ${args.map(q).join(" ")}`;
    const script = [
      "unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST GH_CONFIG_DIR GH_DEBUG",
      // No proxy and no custom CA: gh talks to github.com itself.
      "unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR",
      // No browser on the box is opened for the Bot: the user opens GitHub on their Mac. No colours, no prompts.
      "export GH_BROWSER=true BROWSER=true GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 GH_SPINNER_DISABLED=1 NO_COLOR=1 CLICOLOR=0",
      'cd "$HOME" || exit 97',
      ...(o.login ? loginScript(gh) : [gh]),
      "",
    ].join("\n");
    const scriptFile = path.join(runDir, `${id}.sh`);
    const envFile = path.join(runDir, `${id}.env`);
    fs.writeFileSync(scriptFile, script, { mode: 0o600 });
    fs.writeFileSync(envFile, envFileText(buildBotEnv({ cfg, botId, asBot: botId })), { mode: 0o600 });
    try {
      await spawner.start(id, u.home, u.name, botId);
    } catch (e) {
      fs.rmSync(term, { force: true });
      throw e;
    } finally {
      fs.rmSync(envFile, { force: true });
      fs.rmSync(scriptFile, { force: true });
    }

    const pollMs = this.d.pollMs ?? 250;
    let body = "";
    let cancelled = false;
    let settle!: (r: GhResult) => void;
    const done = new Promise<GhResult>((r) => { settle = r; });
    const read = () => { try { return parseTerminal(fs.readFileSync(term, "utf8")); } catch { return null; } };
    void (async () => {
      let n = 0;
      for (;;) {
        const t = read();
        if (t) body = t.body;
        if (t?.footer) { settle({ code: t.footer.exitCode, output: body }); break; }
        if (cancelled) { settle({ code: 130, output: body }); break; }
        // A unit that died without its footer (stopped from outside) settles too.
        if (++n % 8 === 0 && (await spawner.status(id).catch(() => "stopped")) === "stopped") {
          const last = read();
          settle(last?.footer ? { code: last.footer.exitCode, output: last.body } : { code: 143, output: last?.body ?? body });
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      fs.rmSync(term, { force: true });
    })();
    return {
      output: () => body,
      done,
      cancel: async () => {
        cancelled = true;
        await spawner.stop(id).catch(() => {});
      },
    };
  }
}

/**
 * Security review (bug 195): the Bot owns ~/.config/gh/config.yml, where `http_unix_socket` (or a proxy) could put
 * something between gh and github.com and ask the device flow for more. So the sign-in runs with a FRESH, empty gh
 * config (GH_CONFIG_DIR = a new mktemp dir), checks that nothing was planted in it, prints the clean config's
 * `gh auth status` (the host checks the token's scopes against GITHUB_SCOPES from it) and only then saves hosts.yml
 * into the Bot's own config. The fresh dir is removed however the script ends.
 */
function loginScript(gh: string): string[] {
  return [
    'd="$(mktemp -d)" || exit 97',
    "trap 'rm -rf -- \"$d\"' EXIT",
    "trap 'exit 143' TERM",
    'export GH_CONFIG_DIR="$d"',
    gh,
    "ec=$?",
    '[ "$ec" -eq 0 ] || exit "$ec"',
    // gh writes an empty `http_unix_socket:` itself; a value in it is something else's.
    `if sed -n 's/^[[:space:]]*http_unix_socket:[[:space:]]*//p' "$d/config.yml" 2>/dev/null | tr -d "\\"' \\t" | grep -q '^[^#]'; then echo "the gh config changed during sign-in, so it wasn't saved" >&2; exit 98; fi`,
    "/usr/bin/gh auth status --hostname github.com || exit 99",
    "umask 077",
    'mkdir -p "$HOME/.config/gh" && install -m 600 "$d/hosts.yml" "$HOME/.config/gh/hosts.yml" || { echo "couldn\'t save the GitHub sign-in" >&2; exit 96; }',
    // S3: the Bot's own folder to clone into and push from (the git shim uses the sign-in only in Bot-owned repos).
    '[ -d "$HOME/code" ] || mkdir -m 700 "$HOME/code"',
  ];
}

/**
 * FUZZ/E2E (and the look harness): a pretend gh per Bot, so the flow can be driven without a box and without ever
 * touching a real gh login on the machine running the suite. A sign-in completes after `signInMs`.
 */
export class FakeGhRunner implements GhRunner {
  private who = new Map<string, string>();
  constructor(private o: { signInMs?: number; login?: string } = {}) {}

  async start(botId: string, args: readonly string[]): Promise<GhProc> {
    let out = "";
    let settle!: (r: GhResult) => void;
    const done = new Promise<GhResult>((r) => { settle = r; });
    const login = this.o.login ?? "synapse-fuzz";
    const cmd = args.slice(0, 2).join(" ");
    let timer: NodeJS.Timeout | undefined;
    if (cmd === "auth login") {
      out = "! First copy your one-time code: F4K3-C0DE\nPress Enter to open github.com in your browser... \n";
      timer = setTimeout(() => { this.who.set(botId, login); out += `✓ Authentication complete.\n✓ Logged in as ${login}\ngithub.com\n  ✓ Logged in to github.com account ${login} (hosts.yml)\n  - Token scopes: 'gist', 'read:org', 'repo'\n`; settle({ code: 0, output: out }); }, this.o.signInMs ?? 8000);
    } else if (cmd === "auth status") {
      const l = this.who.get(botId);
      settle(l ? { code: 0, output: `github.com\n  ✓ Logged in to github.com account ${l} (hosts.yml)\n  - Active account: true\n` } : { code: 1, output: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n" });
    } else if (cmd === "auth logout") {
      this.who.delete(botId);
      settle({ code: 0, output: "" });
    } else if (cmd === "api user") {
      settle({ code: 0, output: `${this.who.get(botId) ?? login}\n` });
    } else {
      settle({ code: 0, output: "" });
    }
    return { output: () => out, done, cancel: async () => { clearTimeout(timer); settle({ code: 130, output: out }); } };
  }
}
