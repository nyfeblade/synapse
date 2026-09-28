import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentRef, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import type { HostConfig } from "../../config";
import { classifyTool } from "../../review/classify";
import { BOT_DATA_PATHS, wallHit, type BotDataPath } from "../../walls/registry";
import { botUserName } from "../../walls/bot-uid";
import { tmpConfig } from "../helpers";

/**
 * Bug #61 guard tests, declaration style: the registry (walls/registry.ts) declares every per-Bot data path as
 * host-private, box-private or shared-with-a-reason; these tests derive their cases from it, never from a list here.
 */

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

function rootDir(cfg: HostConfig, e: BotDataPath): string {
  return e.root === "proc" ? "/proc" : (cfg as unknown as Record<string, string>)[e.root]!;
}
/** A concrete file inside `e`, owned by `owner`. */
function sample(cfg: HostConfig, e: BotDataPath, owner: string): string {
  if (e.root === "proc") return "/proc/4242/environ";
  return path.join(rootDir(cfg, e), ...e.pattern.map((s) => (s === "{bot}" ? owner : s === "{account}" ? botUserName(owner) : s === "*" ? "alpha" : s)), "note.txt");
}
const PRIVATE = BOT_DATA_PATHS.filter((e) => e.cls.kind !== "shared");
const SHARED = BOT_DATA_PATHS.filter((e) => e.cls.kind === "shared");

function tools(p: string): [string, Record<string, unknown>][] {
  return [
    ["Read", { file_path: p }], ["Glob", { pattern: "**/*", path: p }], ["Grep", { pattern: "x", path: p }],
    ["Edit", { file_path: p, old_string: "a", new_string: "b" }], ["Write", { file_path: p, content: "x" }],
    ["Bash", { command: `cat '${p}' | head -5` }], ["mcp__bot__Shell", { command: `tail -n 20 ${p}` }],
  ];
}
const classify = (cfg: HostConfig, botId: string, toolName: string, input: Record<string, unknown>) =>
  classifyTool({ toolName, input, toolUseId: "t" }, { workspace: cfg.workspace, hostPrivate: cfg.hostPrivate, botId, walls: cfg } as Parameters<typeof classifyTool>[1]);

describe("Bot walls: the tool guard (bug #61)", () => {
  const cfg = tmpConfig();

  it("the registry declares each private path with its strength and each shared one with a reason", () => {
    for (const e of BOT_DATA_PATHS) {
      if (e.cls.kind === "shared") expect(e.cls.reason.length, e.key).toBeGreaterThan(20);
      if (e.cls.kind === "box-private") expect(e.cls.stronger.length, e.key).toBeGreaterThan(20);
      if (e.cls.kind === "box-private") expect(e.cls.perBotUid.length, e.key).toBeGreaterThan(20); // bug #66
      if (e.cls.kind === "bot-private") expect(e.cls.how.length, e.key).toBeGreaterThan(20);
      if (e.cls.kind === "host-private") expect(e.cls.how.length, e.key).toBeGreaterThan(5);
    }
  });

  it.each(PRIVATE.map((e) => [e.key, e] as const))("a Bot's tool call can't read another Bot's %s", (_k, e) => {
    const p = sample(cfg, e, B);
    for (const [tool, input] of tools(p)) expect(classify(cfg, A, tool, input).hardDeny, `${tool} ${p}`).toMatch(/another Bot|private/);
  });

  it("a recursive search from a folder that holds other Bots' private data is refused", () => {
    for (const p of [path.join(cfg.workspace, ".host-out"), path.join(cfg.workspace, ".host-out", "uploads"), cfg.claudeConfigDir]) {
      expect(classify(cfg, A, "Grep", { pattern: "x", path: p }).hardDeny, p).toBeTruthy();
      expect(classify(cfg, A, "Glob", { pattern: "**", path: p }).hardDeny, p).toBeTruthy();
    }
  });

  it("Bash can't name another Bot's private path through ~, $HOME or a glob", () => {
    const home = (p: string) => p.replace(cfg.boxHome, "~");
    const cmds = [
      `cat ${path.join(cfg.workspace, ".host-out", "uploads")}/*/secret.pdf`,
      "cat /proc/*/environ",
      "strings /proc/1234/environ",
      `ls ${home(path.join(cfg.boxHome, ".chrome-screens", "2"))}`,
      `sqlite3 "$HOME/chrome-profile/Default/Cookies" .dump`,
    ];
    for (const command of cmds) expect(classify(cfg, A, "Bash", { command }).hardDeny, command).toBeTruthy();
  });

  it("bug #66, migrated: a Bot's ~ is its own home; another Bot's home is walled by name, ~ or glob", () => {
    const on = { ...cfg, perBotUid: true };
    const mine = path.join(on.botHomes, botUserName(A)), theirs = path.join(on.botHomes, botUserName(B));
    for (const command of [`cat ~/chrome-profile/Default/Cookies`, `ls \$HOME/.claude/projects/-workspace`, `cat ${mine}/notes.md`]) {
      expect(classify(on, A, "Bash", { command }).hardDeny, command).toBeNull();
    }
    for (const command of [`cat ${theirs}/.claude/projects/-workspace/s.jsonl`, `ls ~/../${botUserName(B)}`, `cat ${on.botHomes}/*/chrome-profile/Default/Cookies`]) {
      expect(classify(on, A, "Bash", { command }).hardDeny, command).toBeTruthy();
    }
    expect(classify(on, A, "Read", { file_path: path.join(theirs, "x") }).hardDeny).toBeTruthy();
  });

  // must-not-fire
  it.each(PRIVATE.filter((e) => e.pattern.includes("{bot}") || e.pattern.includes("{account}")).map((e) => [e.key, e] as const))("a Bot can still reach its own %s", (_k, e) => {
    const p = sample(cfg, e, A);
    for (const [tool, input] of tools(p)) expect(classify(cfg, A, tool, input).hardDeny, `${tool} ${p}`).toBeNull();
  });

  it.each(SHARED.map((e) => [e.key, e] as const))("a Bot can still read the shared %s, including a teammate's part", (_k, e) => {
    const p = sample(cfg, e, B);
    for (const [tool, input] of tools(p).filter(([t]) => t === "Read" || t === "Glob" || t === "Grep" || t === "Bash")) {
      expect(classify(cfg, A, tool, input).hardDeny, `${tool} ${p}`).toBeNull();
    }
  });

  it("ordinary work is untouched: the workspace, /proc/self, ps", () => {
    for (const [tool, input] of [
      ["Grep", { pattern: "TODO", path: cfg.workspace }], ["Glob", { pattern: "**/*.ts" }], ["Read", { file_path: "/proc/self/environ" }],
      ["Bash", { command: "ps aux | grep node" }], ["Bash", { command: "cat /proc/cpuinfo /proc/self/status" }], ["Bash", { command: `ls ${cfg.workspace}` }],
    ] as [string, Record<string, unknown>][]) expect(classify(cfg, A, tool, input).hardDeny, `${tool} ${JSON.stringify(input)}`).toBeNull();
  });
});

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function start() {
  const cfg = tmpConfig();
  app = await createHostApp(cfg);
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result as T;
  };
  const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
  return { cfg, api, tail };
}

function walk(dir: string, out: string[] = []): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    out.push(p);
    if (d.isDirectory()) walk(p, out);
  }
  return out;
}

describe("Bot walls: the data on disk (bug #61)", () => {
  it("every host-private path is walled by the OS: some folder on its way down has no group or other bits", async () => {
    const { cfg, api } = await start();
    const ids = [(await api<{ id: string }>("createAgent", { name: "Ada", isKickstartRequested: false })).id, (await api<{ id: string }>("createAgent", { name: "Bea", isKickstartRequested: false })).id];
    for (const e of BOT_DATA_PATHS.filter((x) => x.cls.kind === "host-private")) {
      const target = sample(cfg, e, ids[1]!);
      const base = rootDir(cfg, e);
      const chain = [base, ...path.relative(base, path.dirname(target)).split("/").filter(Boolean).map((_s, i, a) => path.join(base, ...a.slice(0, i + 1)))];
      fs.mkdirSync(path.dirname(target), { recursive: true }); // as the host would, so every folder on the chain exists
      const walled = chain.some((d) => (fs.statSync(d).mode & 0o077) === 0);
      expect(walled, `${e.key}: ${chain.map((d) => `${d} ${(fs.statSync(d).mode & 0o777).toString(8)}`).join(", ")}`).toBe(true);
    }
  });

  it("every per-Bot path the host writes is declared under that Bot, and a Bot's staged upload is its own", async () => {
    const { cfg, api, tail } = await start();
    const id = (await api<{ id: string }>("createAgent", { name: "Ada", isKickstartRequested: false })).id;
    const up = await api<{ attachment: AttachmentRef }>("uploadAttachment", { id, uploadId: "u1", name: "notes.md", mime: "text/markdown", size: 7, offset: 0, chunkBase64: Buffer.from("# Notes").toString("base64"), final: true });
    await api("sendPrompt", { id, text: "remember: The user's landlord is Mark Ellis.", clientNonce: crypto.randomUUID(), attachmentIds: [up.attachment.attachmentId] });
    const t = Date.now() + 6000;
    while (!((await tail(id)).length > 2 && app!.services.runner.isIdle(id))) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); }

    expect(up.attachment.boxPath).toBeTruthy();
    const hit = wallHit(cfg, up.attachment.boxPath!);
    expect({ key: hit?.entry.key, owner: hit?.ownerId }).toEqual({ key: "uploads", owner: id });

    const found = [cfg.dataRoot, cfg.workspace, cfg.claudeConfigDir].flatMap((r) => walk(r)).filter((p) => p.split("/").includes(id));
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      const h = wallHit(cfg, p);
      expect(h?.entry.pattern.includes("{bot}") && h.ownerId === id, `${p} → ${h?.entry.key ?? "undeclared"}`).toBe(true);
    }
  });
});

describe("Bot walls: what Bots are told (bug #61)", () => {
  it("no prompt points a Bot at a walled path, or tells it to read teammates' folders", async () => {
    const { loadConfig } = await import("../../config");
    const prod = loadConfig({});
    const dir = path.join(__dirname, "..", "..", "prompts");
    const files = walk(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/\/home\/box\/[^\s"'`)]+/g)) {
        const h = wallHit(prod, m[0].replace(/\{\{[^}]+\}\}/g, A));
        expect(h === null || h.entry.cls.kind === "shared", `${path.relative(dir, f)}: ${m[0]} → ${h?.entry.key}`).toBe(true);
      }
      expect(text, path.relative(dir, f)).not.toMatch(/\{\{AGENTS_ROOT\}\}|read them to see what a teammate knows/);
    }
  });
});

describe("Bot walls: in-place migration on host start (bug #61)", () => {
  it("re-stages flat uploads under their Bot, parks unowned ones host-private, loses nothing, and is idempotent", async () => {
    const { migrateLegacyStaging } = await import("../../walls/migrate");
    const cfg = tmpConfig();
    const flat = path.join(cfg.workspace, ".host-out", "uploads");
    const spills = path.join(cfg.workspace, ".host-out", "mcp-output");
    fs.mkdirSync(flat, { recursive: true });
    fs.mkdirSync(spills, { recursive: true });
    fs.writeFileSync(path.join(flat, "shared.md"), "both");
    fs.writeFileSync(path.join(flat, "orphan.md"), "nobody");
    fs.writeFileSync(path.join(spills, "linear-list-1.txt"), "spill");
    for (const id of [A, B]) {
      const dir = path.join(cfg.dataRoot, "agents", id, "attachments");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ s: { attachmentId: "s", name: "shared.md", boxPath: path.join(flat, "shared.md") } }));
    }
    expect(migrateLegacyStaging(cfg)).toEqual({ moved: 2, parked: 2 });
    for (const id of [A, B]) {
      const idx = JSON.parse(fs.readFileSync(path.join(cfg.dataRoot, "agents", id, "attachments", "index.json"), "utf8"));
      expect(idx.s.boxPath).toBe(path.join(flat, id, "shared.md"));
      expect(fs.readFileSync(idx.s.boxPath, "utf8")).toBe("both");
    }
    expect(fs.readdirSync(flat).sort()).toEqual([A, B].sort());
    expect(fs.readdirSync(spills)).toEqual([]);
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "walled", "uploads", "orphan.md"), "utf8")).toBe("nobody");
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "walled", "mcp-output", "linear-list-1.txt"), "utf8")).toBe("spill");
    expect(migrateLegacyStaging(cfg)).toEqual({ moved: 0, parked: 0 });
  });
});
