import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import fs from "node:fs";
import path from "node:path";
import { botUserName } from "../../walls/bot-uid";
import { benchDir } from "./repo";
import { benchBotName, NONCE_RE, type BoxEvent, type BoxState, type SynapseBox, type UsageRow } from "./synapse";

/**
 * The real box: the gateway over HTTP (commands) + SSE (events), reached the way
 * box/check-gateway.sh and app/walk/gateway.ts reach it, plus `orb -m box -u root` for the
 * workspace copy and the read-only usage.db query. Constructing it does nothing; the runner
 * refuses to use it unless BENCH_REAL=1.
 */

const BOX_NODE_MODULES = process.env.BENCH_BOX_NODE_MODULES ?? "/opt/bothost/boxtest/node_modules";
const USAGE_DB = "/home/box/.host/usage.db";
const AGENTS_ROOT = "/home/box/agent-data/agents"; // host/config.ts dataRoot default on the box
const MAX_BOTS = 50; // shared/src/limits.ts maxBots (read-only mirror; that file is not ours to touch)

function resolveOrb(): string {
  if (process.env.ORB) return process.env.ORB;
  for (const p of ["/Applications/OrbStack.app/Contents/MacOS/bin/orb", "/usr/local/bin/orb"]) if (fs.existsSync(p)) return p;
  return "orb";
}

function orb(args: string[], o: { user?: "root" | "box"; input?: Buffer; timeoutMs?: number } = {}): Buffer {
  return execFileSync(resolveOrb(), ["-m", process.env.BOX_MACHINE ?? "box", "-u", o.user ?? "root", ...args], { env: scrubClaudeLogin(process.env), 
    input: o.input, maxBuffer: 512 * 1024 * 1024, timeout: o.timeoutMs ?? 120_000, stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

const sh = (script: string, o: { user?: "root" | "box"; input?: Buffer } = {}) => orb(["sh", "-c", script], o).toString("utf8");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** listAgents returns BotSummary: the name is under `profile` (reading `.name` gave "undefined" and blocked every cleanup). */
type AgentRow = { id: string; profile?: { name?: string } };
const agentName = (a: AgentRow): string => String(a.profile?.name ?? "");

/**
 * The workspace's node_modules: a real folder the Bot owns, with one link per package of the shared install.
 * A link to the whole shared folder made vite write its temp config into the bothost-owned .vite-temp (EACCES),
 * which the CLI never hits on the Mac. vite's own temp/cache folders are left out so vitest makes them here.
 */
export function linkNodeModulesScript(repo: string, shared: string): string {
  const nm = `${repo}/node_modules`;
  return `set -e; rm -rf ${q(nm)}; mkdir -p ${q(nm)}; for e in ${q(shared)}/* ${q(shared)}/.[!.]*; do [ -e "$e" ] || continue; case "\${e##*/}" in .vite|.vite-temp|.cache) continue;; esac; ln -s "$e" ${q(nm)}/; done`;
}

/**
 * Bug 231: the repo in the Bot's own ~/code, as a real copy of the shared install: a link out of the Bot's closed tree
 * (review/static.ts botOwns) would keep `npm test` off the review fast path, which a Bot's own `npm install` never hits.
 */
export function copyNodeModulesScript(repo: string, shared: string): string {
  const nm = `${repo}/node_modules`;
  return `set -e; rm -rf ${q(nm)}; mkdir -p ${q(nm)}; for e in ${q(shared)}/* ${q(shared)}/.[!.]*; do [ -e "$e" ] || continue; case "\${e##*/}" in .vite|.vite-temp|.cache) continue;; esac; cp -a "$e" ${q(nm)}/; done`;
}

/**
 * Per-Bot OS accounts (#66): git refuses a repo another uid owns ("dubious ownership"), so the bench repo belongs
 * to the bench Bot's own account, as a repo it cloned itself would; `box` when the Bot has no account. In the Bot's
 * ~/code (bug 231) the group is the Bot's private one, as for a repo it made itself.
 */
export function repoOwnerScript(root: string, botId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(botId)) throw new Error(`bad bot id ${botId}`);
  const user = botUserName(botId);
  if (root.startsWith("/home/bots/")) return `chown -R ${q(`${user}:${user}`)} ${q(root)}`;
  return `owner=box; if getent passwd ${q(user)} >/dev/null 2>&1; then owner=${q(user)}; fi; chown -R "$owner":bots ${q(root)}`;
}

const remoteRoot = (nonce: string) => {
  if (!NONCE_RE.test(nonce)) throw new Error(`bad nonce ${nonce}`);
  return `/workspace/bench-${nonce}`;
};

/**
 * Bug 231: where the bench repo goes, printed by a root script on the box. A Bot with its own account works in its
 * private ~/code, as every Bot now does: /home/bots/<account>/code/bench-<nonce> (~/code made 0700 and the Bot's own if
 * missing; a link there is refused). A box without per-Bot accounts keeps /workspace/bench-<nonce>.
 */
export function benchRootScript(nonce: string, botId: string): string {
  const ws = remoteRoot(nonce);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(botId)) throw new Error(`bad bot id ${botId}`);
  const u = q(botUserName(botId));
  return `set -e; if ent="$(getent passwd ${u})"; then home="$(printf '%s' "$ent" | cut -d: -f6)"; case "$home" in /home/bots/bot-*) ;; *) exit 3;; esac; `
    + `[ ! -L "$home/code" ] || exit 3; [ -d "$home/code" ] || install -d -o ${u} -g ${u} -m 700 "$home/code"; echo "$home/code/bench-${nonce}"; else echo ${q(ws)}; fi`;
}

/** The root benchRootScript printed, checked before anything is written or removed there. */
export function checkBenchRoot(root: string, nonce: string): string {
  const r = root.trim();
  if (r === remoteRoot(nonce) || new RegExp(`^/home/bots/bot-[0-9a-f]{12}/code/bench-${nonce}$`).test(r)) return r;
  throw new Error(`unexpected bench root ${JSON.stringify(r)}`);
}

export class GatewayBox implements SynapseBox {
  readonly real = true;
  private base = "";
  private token = "";
  private names = new Map<string, string>();
  /** Bug 231: each session's repo root (the Bot's ~/code or /workspace), by nonce. */
  private roots = new Map<string, string>();
  private rootOf(nonce: string): string { return this.roots.get(nonce) ?? remoteRoot(nonce); }

  private connect(): void {
    if (this.base) return;
    const routeEnv = fs.readFileSync(path.resolve(benchDir(), "..", "..", "..", "box", "route.env"), "utf8");
    const env = Object.fromEntries(routeEnv.split("\n").map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]])) as Record<string, string>;
    if (env.GATEWAY_ROUTE === "ssh-tunnel") throw new Error("bench: the ssh-tunnel route is not supported");
    const info = JSON.parse(orb(["cat", "/home/box/.host/gateway.json"]).toString("utf8")) as { port: number; token: string };
    const host = env.GATEWAY_ROUTE === "orb-hostname" ? env.GATEWAY_HOST || `${process.env.BOX_MACHINE ?? "box"}.orb.local` : env.GATEWAY_HOST || "127.0.0.1";
    this.base = `http://${host}:${info.port}`;
    this.token = info.token;
  }

  async call(cmd: string, args: Record<string, unknown>): Promise<any> {
    this.connect();
    // No Origin header: the gateway 403s any request that carries one.
    const r = await fetch(`${this.base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${cmd}: ${j.error?.code ?? r.status} ${j.error?.message ?? ""}`);
    return j.result;
  }

  async subscribe(fn: (ev: BoxEvent) => void): Promise<() => void> {
    this.connect();
    const ac = new AbortController();
    const res = await fetch(`${this.base}/events`, { headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`/events returned ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try { fn(JSON.parse(data) as BoxEvent); } catch { /* not JSON: ignore */ }
          }
        }
      } catch { /* aborted */ }
    })();
    return () => ac.abort();
  }

  async state(): Promise<BoxState> {
    const { agents } = (await this.call("listAgents", {})) as { agents: AgentRow[] };
    for (const a of agents) this.names.set(a.id, agentName(a));
    const maxScreens = sh("grep -E '^MAX_SCREENS=' /etc/bothost.env 2>/dev/null || true").trim() || null;
    let nodeModulesOk = false;
    try {
      sh(`test -r ${q(`${BOX_NODE_MODULES}/vitest/vitest.mjs`)} && test -r ${q(`${BOX_NODE_MODULES}/typescript/bin/tsc`)}`, { user: "box" });
      nodeModulesOk = true;
    } catch { /* missing or unreadable as box */ }
    return { botIds: agents.map((a) => a.id), botCount: agents.length, maxBots: MAX_BOTS, maxScreens, nodeModulesOk, nodeModulesPath: BOX_NODE_MODULES };
  }

  async createBot(name: string, model: string): Promise<string> {
    const { id } = (await this.call("createAgent", { name, model, isKickstartRequested: false })) as { id: string };
    this.names.set(id, name);
    return id;
  }

  async enableEngineering(id: string): Promise<void> {
    await this.call("setAgentEngineeringMode", { id, enabled: true });
  }

  /** Deletes only a Bot whose CURRENT name is bench-<8 chars>: never a user's Bot. */
  async deleteBot(id: string): Promise<void> {
    const { agents } = (await this.call("listAgents", {})) as { agents: AgentRow[] };
    const bot = agents.find((a) => a.id === id);
    if (!bot) return;
    const name = agentName(bot);
    const m = /^bench-([a-z0-9]{8})$/.exec(name);
    if (!m || name !== benchBotName(m[1]!)) throw new Error(`refusing to delete Bot ${id} named "${name}": not a bench Bot`);
    await this.call("deleteAgent", { id });
  }

  async pushRepo(localDir: string, nonce: string, botId: string): Promise<string> {
    const root = checkBenchRoot(sh(benchRootScript(nonce, botId)), nonce);
    this.roots.set(nonce, root);
    const home = root.startsWith("/home/bots/");
    const repo = `${root}/ledger`;
    const tar = execFileSync("tar", ["-C", localDir, "--exclude", "./node_modules", "-czf", "-", "."], { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 256 * 1024 * 1024 });
    const nm = home ? copyNodeModulesScript(repo, BOX_NODE_MODULES) : linkNodeModulesScript(repo, BOX_NODE_MODULES);
    sh(`set -e; mkdir -p ${q(repo)}; tar -xzf - -C ${q(repo)} --warning=no-unknown-keyword; ${nm}; ${repoOwnerScript(root, botId)}; ${home ? `chmod -R go-w ${q(root)}` : `chmod -R g+rwX ${q(root)}`}`, { input: tar });
    return repo;
  }

  async pullRepo(nonce: string, localDir: string): Promise<void> {
    const repo = `${this.rootOf(nonce)}/ledger`;
    const tar = orb(["tar", "-C", repo, "--exclude=./node_modules", "-czf", "-", "."]);
    fs.mkdirSync(localDir, { recursive: true });
    execFileSync("tar", ["-xzf", "-", "-C", localDir], { env: scrubClaudeLogin(process.env), input: tar });
  }

  async removeWorkspace(nonce: string): Promise<void> {
    sh(`rm -rf ${q(this.rootOf(nonce))}`);
    this.roots.delete(nonce);
  }

  /** usage.db rows for one Bot since a time, read-only. */
  async usage(botId: string, sinceMs: number): Promise<UsageRow[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error(`bad bot id ${botId}`);
    const sql = `SELECT model, startedAt, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, numTurns, status, purpose FROM runs WHERE botId='${botId}' AND startedAt >= ${Math.floor(sinceMs)} ORDER BY startedAt`;
    const js = `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(${JSON.stringify(USAGE_DB)}, { readOnly: true }); console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`;
    const out = orb(["node", "--input-type=module", "-e", js]).toString("utf8").trim();
    return JSON.parse(out || "[]") as UsageRow[];
  }

  /** The bench Bot's current session file (bug-log 75), read-only; called before the Bot is deleted. */
  async transcript(botId: string): Promise<string | null> {
    // Only ever a bench Bot's own session: never a user's conversation.
    const name = this.names.get(botId) ?? "";
    if (!/^bench-[a-z0-9]{8}$/.test(name)) throw new Error(`refusing to read the session of Bot ${botId} named "${name}": not a bench Bot`);
    const out = orb(["node", "--input-type=module", "-e", transcriptScript(botId)]).toString("utf8").trim();
    const r = JSON.parse(out || "null") as { text: string } | null;
    return r?.text ?? null;
  }
}

/**
 * Node source run on the box as root: the Bot's session id from its store (kv "brain"), then that session's
 * .jsonl in the shared config dir or the Bot's own home (per-Bot uids, walls/bot-uid.ts cliSessionFile).
 */
export function transcriptScript(botId: string, where: { agents: string; boxHome: string; botHomes: string } = { agents: AGENTS_ROOT, boxHome: "/home/box", botHomes: "/home/bots" }): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error(`bad bot id ${botId}`);
  const store = `${where.agents}/${botId}/store.db`;
  return `import { DatabaseSync } from "node:sqlite"; import fs from "node:fs"; import path from "node:path";
const db = new DatabaseSync(${JSON.stringify(store)}, { readOnly: true });
const row = db.prepare("SELECT value FROM kv WHERE key = 'brain'").get();
const sid = row ? JSON.parse(row.value).sessionId : null;
let text = null;
if (typeof sid === "string" && /^[0-9a-f-]{36}$/.test(sid)) {
  const homes = ${JSON.stringify(where.botHomes)};
  const roots = [${JSON.stringify(where.boxHome + "/.claude/projects")}, ...(fs.existsSync(homes) ? fs.readdirSync(homes).map((u) => path.join(homes, u, ".claude", "projects")) : [])];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r)) { const f = path.join(r, d, sid + ".jsonl"); if (!text && fs.existsSync(f)) text = fs.readFileSync(f, "utf8"); }
  }
}
console.log(JSON.stringify(text === null ? null : { text }));`;
}
