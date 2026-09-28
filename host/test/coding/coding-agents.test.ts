import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { AsyncQueue } from "../../util/async-queue";
import { CodingAgents, type ChildFactory, repoName, umaskGit } from "../../coding/coding-agents";
import { classifyTool } from "../../review/classify";
import { codingAgentRule } from "../../coding/review-rule";
import { createCodingAgentTool } from "../../tools/coding-agent-tool";

function originRepo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "origin-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: r });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "README.md"), "hi\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return r;
}

let ws: string;
let pushed: string[];
let feeds: AsyncQueue<{ type: string; [k: string]: unknown }>[];
let changes: string[];
let done: string[];
const fakeChild: ChildFactory = (o) => {
  const q = new AsyncQueue<{ type: string; [k: string]: unknown }>();
  feeds.push(q);
  pushed.push(`cwd:${path.basename(o.cwd)}`, o.prompt);
  // NOTE: AsyncQueue (host/util/async-queue.ts, Task 2) exposes end(), not close(); the CodingChild
  // interface's close() is implemented here by calling the queue's actual method.
  return { push: (t) => pushed.push(t), interrupt: async () => void pushed.push("<interrupt>"), close: () => q.end(), messages: q };
};
const mk = (extra: Partial<ConstructorParameters<typeof CodingAgents>[0]> = {}) => new CodingAgents({
  workspace: ws, registryFile: path.join(ws, ".reg.json"), now: () => Date.now(), git: umaskGit, child: fakeChild, model: () => "claude-sonnet-5",
  onChange: (a) => changes.push(a.status), onDone: (a) => done.push(`${a.id}:${a.status}`), ...extra,
});
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  pushed = []; feeds = []; changes = []; done = [];
});

describe("coding agent (TOOL-20)", () => {
  it("names repos from URLs and paths", () => {
    expect(repoName("https://github.com/alex/garden-app.git")).toBe("garden-app");
    expect(repoName("alex/garden-app")).toBe("garden-app");
  });

  it("launch clones into /workspace/repos, makes a worktree on a new branch, and starts a session there", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "Fix the README typo", title: "README fix" });
    expect(a).toMatchObject({ botId: "b1", title: "README fix", status: "running", branch: expect.stringMatching(/^bots\/readme-fix-/) });
    expect(fs.existsSync(path.join(ws, "repos", path.basename(a.repo), ".git"))).toBe(true);
    expect(execFileSync("git", ["-C", a.worktree, "branch", "--show-current"]).toString().trim()).toBe(a.branch);
    expect(pushed[0]).toBe(`cwd:${path.basename(a.worktree)}`);
    expect(pushed[1]).toContain("Fix the README typo");
  });

  it("records the transcript, finishes on result, finds the PR link, and revives the Bot once", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "t" });
    feeds[0]!.push({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
    feeds[0]!.push({ type: "result", subtype: "success", result: "Done. Opened https://github.com/alex/garden-app/pull/42" });
    await new Promise((r) => setTimeout(r, 30));
    expect(agents.get(a.id)).toMatchObject({ status: "done", prUrl: "https://github.com/alex/garden-app/pull/42" });
    expect(fs.readFileSync(agents.dumpPath(a.id), "utf8").trim().split("\n")).toHaveLength(2);
    expect(done).toEqual([`${a.id}:done`]);
  });

  it("reply interrupts then pushes; interrupt:false only queues; cancel ends it", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "t" });
    await agents.reply(a.id, "also update the tests");
    await agents.reply(a.id, "and the docs", false);
    expect(pushed.slice(-3)).toEqual(["<interrupt>", "also update the tests", "and the docs"]);
    agents.cancel(a.id);
    expect(agents.get(a.id)!.status).toBe("cancelled");
  });

  it("steers at 90% of the wall clock and times out at 100% (ORIG-15)", async () => {
    const agents = mk({ wallClockMs: 100 });
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "t" });
    await new Promise((r) => setTimeout(r, 95));
    expect(pushed.at(-1)).toMatch(/almost out of time/);
    await new Promise((r) => setTimeout(r, 40));
    expect(agents.get(a.id)!.status).toBe("timed-out");
    expect(done).toEqual([`${a.id}:timed-out`]);
  });

  it("caps concurrent agents per Bot (§5.1 background children: 4 per Bot)", async () => {
    const agents = mk({ maxPerBot: 1 });
    const origin = originRepo();
    await agents.launch("b1", { repo: `file://${origin}`, task: "t" });
    await expect(agents.launch("b1", { repo: `file://${origin}`, task: "t2" })).rejects.toThrow(/at most 1/);
  });

  // task-24 fix round 1, finding 2: the running-agent count was read before the async
  // prepareWorktree() await, and the agent was only inserted into `this.agents` after that await.
  // Two launch() calls issued in the same tick (e.g. two tool_use blocks in one assistant turn) must
  // not both pass the cap check and exceed maxPerBot.
  it("does not let two launch() calls issued in the same tick both pass the per-Bot cap (§5.1)", async () => {
    const agents = mk({ maxPerBot: 1 });
    const origin = originRepo();
    const results = await Promise.allSettled([
      agents.launch("b1", { repo: `file://${origin}`, task: "t1" }),
      agents.launch("b1", { repo: `file://${origin}`, task: "t2" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringMatching(/at most 1/) });
    expect(agents.list("b1").filter((a) => a.status === "running")).toHaveLength(1);
  });

  it("launch and reply are reviewed as cloud_agent; cancel and delete always ask", () => {
    const o = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
    const launch = classifyTool({ toolName: "mcp__bot__CodingAgent", input: { action: "launch", repo: "alex/app", task: "fix" }, toolUseId: "t" }, o);
    expect(launch).toMatchObject({ surface: "cloud_agent", target: { action: "coding_agent_launch" } });
    expect(classifyTool({ toolName: "mcp__bot__CodingAgent", input: { action: "list" }, toolUseId: "t" }, o).surface).toBeNull();
    const del = classifyTool({ toolName: "mcp__bot__CodingAgent", input: { action: "delete", agent_id: "x", confirm: true }, toolUseId: "t" }, o);
    expect(codingAgentRule({ surface: del.surface, target: del.target } as never)).toMatch(/confirm/i);
    expect(codingAgentRule({ surface: launch.surface, target: launch.target } as never)).toBeNull();
  });

  // mcpfix (implementer-rules.md): every new bot tool's schema must survive the real MCP tools/list
  // pipeline — the Agent SDK's bundled JSON-schema driver crashes on zod 4.6's z.record() processor,
  // which fails the whole server's tools/list. CodingAgent uses no z.record(), so this must list clean.
  it("lists CodingAgent over MCP tools/list without crashing the server (mcpfix)", async () => {
    const agents = mk();
    const tool = createCodingAgentTool({ botId: "b1", slot: () => null, agents, bots: null as never, now: () => 0, cardIds: new Map() });
    const server = toSdkMcpServer({ botTools: () => [tool] } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["CodingAgent"]);
    } finally {
      await client.close();
    }
  });
});
