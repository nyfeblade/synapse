import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GatewayBox, linkNodeModulesScript, repoOwnerScript, transcriptScript } from "../../../bench/coding/gateway-box";
import { tmpDir } from "../../../bench/coding/repo";

const made: string[] = [];
afterAll(() => { for (const d of made) { try { execFileSync("chmod", ["-R", "u+w", d]); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); } });

/** A GatewayBox whose gateway is a stub answering like the real one: listAgents returns BotSummary (name under profile). */
function stubBox(agents: { id: string; name: string }[]) {
  const box = new GatewayBox();
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  box.call = async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "listAgents") return { agents: agents.map((a) => ({ id: a.id, profile: { name: a.name, title: "", description: "" }, running: false })), activeAgentId: null };
    if (cmd === "deleteAgent") return { activeAgentId: null };
    throw new Error(`unexpected ${cmd}`);
  };
  return { box, calls };
}

describe("GatewayBox bench Bot lookup (2026-09-21 run: every deleteBot refused a real bench Bot as named \"undefined\")", () => {
  it("deletes a bench Bot, reading its name from BotSummary.profile.name", async () => {
    const { box, calls } = stubBox([{ id: "b1", name: "bench-abcd1234" }, { id: "u1", name: "Research" }]);
    await box.deleteBot("b1");
    expect(calls.filter((c) => c.cmd === "deleteAgent")).toEqual([{ cmd: "deleteAgent", args: { id: "b1" } }]);
  });

  it("still refuses a user's Bot, and says its real name", async () => {
    const { box, calls } = stubBox([{ id: "u1", name: "Research" }, { id: "u2", name: "bench-abcd1234-copy" }]);
    await expect(box.deleteBot("u1")).rejects.toThrow(/named "Research": not a bench Bot/);
    await expect(box.deleteBot("u2")).rejects.toThrow(/not a bench Bot/);
    expect(calls.some((c) => c.cmd === "deleteAgent")).toBe(false);
  });
});

describe("box workspace node_modules (2026-09-21 run: vitest hit EACCES on the shared, bothost-owned node_modules/.vite-temp)", () => {
  it("is a writable per-workspace folder whose packages link to the shared install, so vitest can write its temp config", () => {
    const root = tmpDir("nm");
    made.push(root);
    const shared = path.join(root, "shared", "node_modules");
    fs.mkdirSync(path.join(shared, "vitest"), { recursive: true });
    fs.writeFileSync(path.join(shared, "vitest", "vitest.mjs"), "");
    fs.mkdirSync(path.join(shared, ".bin"), { recursive: true });
    fs.mkdirSync(path.join(shared, "@types", "node"), { recursive: true });
    fs.mkdirSync(path.join(shared, ".vite-temp"));
    fs.mkdirSync(path.join(shared, ".vite"));
    execFileSync("chmod", ["-R", "a-w", shared]); // the shared install is not the Bot's to write
    const repo = path.join(root, "ws", "ledger");
    fs.mkdirSync(repo, { recursive: true });

    execFileSync("sh", ["-c", linkNodeModulesScript(repo, shared)]);

    const nm = path.join(repo, "node_modules");
    expect(fs.lstatSync(nm).isDirectory(), "a real folder, not a link to the shared one").toBe(true);
    expect(fs.realpathSync(path.join(nm, "vitest"))).toBe(fs.realpathSync(path.join(shared, "vitest")));
    expect(fs.existsSync(path.join(nm, "vitest", "vitest.mjs"))).toBe(true);
    expect(fs.realpathSync(path.join(nm, "@types"))).toBe(fs.realpathSync(path.join(shared, "@types")));
    expect(fs.lstatSync(path.join(nm, ".bin")).isSymbolicLink()).toBe(true);
    // vite's own temp/cache folders are never shared: vitest creates them in the workspace, where the Bot may write.
    expect(fs.existsSync(path.join(nm, ".vite-temp"))).toBe(false);
    expect(fs.existsSync(path.join(nm, ".vite"))).toBe(false);
    fs.mkdirSync(path.join(nm, ".vite-temp"));
    fs.writeFileSync(path.join(nm, ".vite-temp", "vitest.config.ts.timestamp.mjs"), "export default {}");
  });
});

/**
 * 2026-09-22T13-25-32-918Z regression: with per-Bot OS accounts live (#66), the pushed bench repo was owned by
 * `box`, so git in the Bot (uid bot-<hex>) refused it as "dubious ownership". T03 and T10 each spent calls on it,
 * two Haiku reviews and a declined approval card (`git config --global --add safe.directory …`). The repo now
 * belongs to the bench Bot's own account, like a repo the Bot cloned itself; `box` when there is none.
 */
describe("GatewayBox repo owner (per-Bot OS accounts)", () => {
  it("chowns the pushed repo to the Bot's own account when it exists, else box, group bots either way", () => {
    const s = repoOwnerScript("/workspace/bench-abcd1234", "4e04d6af-4606-4e05-b27b-fa32e187c127");
    expect(s).toContain("bot-42f55c4c6570"); // walls/bot-uid.ts botUserName of that id
    expect(s).toMatch(/getent passwd 'bot-42f55c4c6570'/);
    expect(s).toMatch(/chown -R "\$owner":bots '\/workspace\/bench-abcd1234'/);
    expect(s).toMatch(/owner=box/);
    expect(() => repoOwnerScript("/workspace/bench-abcd1234", "x'; rm -rf /")).toThrow(/bad bot id/);
  });

  it("runs as written: the Bot's account when getent knows it, box otherwise", () => {
    const run = (known: boolean) => {
      const dir = tmpDir("owner");
      made.push(dir);
      fs.writeFileSync(path.join(dir, "getent"), `#!/bin/sh\n${known ? "echo \"$2:x:1:1::/:/bin/false\"" : "exit 2"}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "chown"), `#!/bin/sh\necho "$@" > ${JSON.stringify(path.join(dir, "out"))}\n`, { mode: 0o755 });
      execFileSync("sh", ["-c", repoOwnerScript("/r", "b1")], { env: { PATH: `${dir}:/usr/bin:/bin` } });
      return fs.readFileSync(path.join(dir, "out"), "utf8").trim();
    };
    expect(run(true)).toMatch(/^-R bot-[0-9a-f]{12}:bots \/r$/);
    expect(run(false)).toBe("-R box:bots /r");
  });
});

describe("GatewayBox.transcript (bug-log 75: the session file is read before the Bot is deleted)", () => {
  it("finds the Bot's session file from its store, in the shared config dir or the Bot's own home", () => {
    const root = tmpDir("gw-transcript");
    made.push(root);
    const agents = path.join(root, "agents"), boxHome = path.join(root, "box"), botHomes = path.join(root, "bots");
    const sid = "0f1e2d3c-4b5a-4968-8776-655443322110";
    fs.mkdirSync(path.join(agents, "b1"), { recursive: true });
    const mk = `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(${JSON.stringify(path.join(agents, "b1", "store.db"))});
db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); db.prepare("INSERT INTO kv VALUES ('brain', ?)").run(JSON.stringify({ sessionId: ${JSON.stringify(sid)} }));`;
    execFileSync("node", ["--input-type=module", "-e", mk]);
    const where = { agents, boxHome, botHomes };
    const read = () => JSON.parse(execFileSync("node", ["--input-type=module", "-e", transcriptScript("b1", where)]).toString("utf8").trim());
    expect(read()).toBeNull();
    const own = path.join(botHomes, "bot-b1", ".claude", "projects", "-workspace");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, `${sid}.jsonl`), "{\"type\":\"assistant\"}\n");
    expect(read()).toEqual({ text: "{\"type\":\"assistant\"}\n" });
    expect(() => transcriptScript("../x")).toThrow(/bad bot id/);
  });

  it("refuses to read any Bot that is not a bench Bot", async () => {
    const box = new GatewayBox();
    await expect(box.transcript("user-bot")).rejects.toThrow(/not a bench Bot/);
  });
});
