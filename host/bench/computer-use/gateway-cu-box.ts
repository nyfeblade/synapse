import { execFileSync } from "node:child_process";
import { GatewayBox } from "../coding/gateway-box";
import { isBenchCuName, NONCE_RE, type CuBox } from "./box";
import type { Mode } from "./metrics";
import { PAGES, SERVER_JS, type CuTask, type PromptCtx } from "./tasks";

export { isBenchCuName };

/**
 * The real box for the computer-use bench. Gateway calls, SSE and usage.db go through the coding
 * bench's fixed GatewayBox (BotSummary names under profile.name); files, the local site server and
 * read-only reads go through `orb -m box`. Constructing it does nothing; the runner refuses to use it
 * unless BENCH_REAL=1.
 */

const DATA_ROOT = "/home/box/agent-data/agents"; // host/config.ts dataRoot default on the box
const THUNAR_XML = "/home/box/.config/xfce4/xfconf/xfce-perchannel-xml/thunar.xml";

function resolveOrb(): string {
  if (process.env.ORB) return process.env.ORB;
  for (const p of ["/Applications/OrbStack.app/Contents/MacOS/bin/orb", "/usr/local/bin/orb"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch { /* next */ }
  }
  return "orb";
}
function orb(args: string[], o: { user?: "root" | "box"; input?: Buffer } = {}): string {
  return execFileSync(resolveOrb(), ["-m", process.env.BOX_MACHINE ?? "box", "-u", o.user ?? "root", ...args], {
    input: o.input, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"],
  }).toString("utf8");
}
const sh = (script: string, o: { user?: "root" | "box"; input?: Buffer } = {}) => orb(["sh", "-c", script], o);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const root = (nonce: string) => {
  if (!NONCE_RE.test(nonce)) throw new Error(`bad nonce ${nonce}`);
  return `/workspace/bench-cu-${nonce}`;
};
const safeRel = (rel: string) => {
  if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`bad path ${rel}`);
  return rel;
};
type AgentRow = { id: string; profile?: { name?: string } };

export class GatewayCuBox implements CuBox {
  readonly real = true;
  private gw = new GatewayBox();
  private port = 0;

  call = (cmd: string, args: Record<string, unknown>): Promise<any> => this.gw.call(cmd, args);
  subscribe: CuBox["subscribe"] = (fn) => this.gw.subscribe(fn);
  usage: CuBox["usage"] = (botId, since) => this.gw.usage(botId, since);

  async listBots() {
    const { agents } = (await this.call("listAgents", {})) as { agents: AgentRow[] };
    return agents.map((a) => ({ id: a.id, name: String(a.profile?.name ?? "") }));
  }

  async createBot(name: string, model: string): Promise<string> {
    if (!isBenchCuName(name)) throw new Error(`refusing to create ${name}: not a bench-cu name`);
    const { id } = (await this.call("createAgent", { name, model, isKickstartRequested: false })) as { id: string };
    return id;
  }

  async setPerception(id: string, mode: Mode): Promise<void> {
    await this.call("setAgentComputerPerception", { id, mode });
  }

  /** Deletes only a Bot whose CURRENT name is bench-cu-<8 chars>: never a user's Bot, never a coding-bench Bot. */
  async deleteBot(id: string): Promise<void> {
    const bot = (await this.listBots()).find((b) => b.id === id);
    if (!bot) return;
    if (!isBenchCuName(bot.name)) throw new Error(`refusing to delete Bot ${id} named "${bot.name}": not a computer-use bench Bot`);
    await this.call("deleteAgent", { id });
  }

  async childTranscripts(botId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error(`bad bot id ${botId}`);
    const js = `import { DatabaseSync } from "node:sqlite"; import fs from "node:fs";
const db = new DatabaseSync(${JSON.stringify(`${DATA_ROOT}/${botId}/store.db`)}, { readOnly: true });
const row = db.prepare("SELECT value FROM kv WHERE key = 'brain.childSessionFiles'").get();
const files = row ? JSON.parse(row.value).map((x) => x.file) : [];
console.log(JSON.stringify(files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8"))));`;
    return JSON.parse(orb(["node", "--input-type=module", "-e", js]).trim() || "[]") as string[];
  }

  async setup(nonce: string, tasks: CuTask[]): Promise<PromptCtx> {
    const r = root(nonce);
    this.port = 18_000 + Math.floor(Math.random() * 2_000);
    sh(`set -e; install -d -o box -g bots -m 2775 ${q(r)} ${q(`${r}/site`)} ${q(`${r}/desk`)}`);
    const put = (p: string, content: string) => sh(`cat > ${q(p)}`, { user: "box", input: Buffer.from(content) });
    put(`${r}/server.mjs`, SERVER_JS);
    for (const t of tasks) if (t.page) put(`${r}/site/${t.page}`, PAGES[t.page]!);
    for (const t of tasks) await this.resetTask(nonce, t);
    sh(`cd ${q(r)} && nohup node server.mjs ${this.port} ${q(r)} > server.log 2>&1 & echo $! > ${q(`${r}/server.pid`)}`, { user: "box" });
    sh(`for i in $(seq 1 50); do curl -fs http://127.0.0.1:${this.port}/${tasks.find((t) => t.page)?.page ?? "x.html"} >/dev/null && exit 0; sleep 0.1; done; exit 0`, { user: "box" });
    return { base: `http://127.0.0.1:${this.port}`, desk: `${r}/desk` };
  }

  async resetTask(nonce: string, task: CuTask): Promise<void> {
    const desk = `${root(nonce)}/desk`;
    // D3: xfconfd caches settings and rewrites thunar.xml, so stop it before dropping the property [unverified on the box].
    if (task.xfconf) sh(`pkill -u box -x xfconfd || true; sleep 0.5; [ -f ${q(THUNAR_XML)} ] && sed -i '/name="misc-single-click"/d' ${q(THUNAR_XML)} || true`);
    for (const rel of task.watch ?? []) sh(`rm -f ${q(`${desk}/${safeRel(rel)}`)}`, { user: "box" });
    for (const [rel, content] of Object.entries(task.files ?? {})) {
      const p = `${desk}/${safeRel(rel)}`;
      sh(`mkdir -p "$(dirname ${q(p)})" && cat > ${q(p)}`, { user: "box", input: Buffer.from(content) });
    }
  }

  async submissions(nonce: string) {
    return JSON.parse(sh(`cat ${q(`${root(nonce)}/submissions.json`)} 2>/dev/null || echo '{}'`) || "{}") as Record<string, Record<string, unknown>[]>;
  }

  async readFiles(nonce: string, rels: string[]) {
    const out: Record<string, string | null> = {};
    for (const rel of rels) {
      const p = `${root(nonce)}/desk/${safeRel(rel)}`;
      const v = sh(`if [ -f ${q(p)} ]; then printf 1; cat ${q(p)}; else printf 0; fi`);
      out[rel] = v.startsWith("1") ? v.slice(1) : null;
    }
    return out;
  }

  async xfconf(): Promise<string | null> {
    const v = sh(`if [ -f ${q(THUNAR_XML)} ]; then printf 1; cat ${q(THUNAR_XML)}; else printf 0; fi`);
    return v.startsWith("1") ? v.slice(1) : null;
  }

  async teardown(nonce: string): Promise<void> {
    const r = root(nonce);
    sh(`[ -f ${q(`${r}/server.pid`)} ] && kill "$(cat ${q(`${r}/server.pid`)})" 2>/dev/null; rm -rf ${q(r)}`);
  }
}
