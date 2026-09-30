import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHarness, waitFor, type Harness } from "./harness";

/**
 * Wave 3: the ACP client against a fake ACP agent (a real child process speaking ACP v1 over stdio). Everything
 * the vendor CLI asks for is answered by Synapse: permission by the real approval gate, files by bot-file behind the
 * walls, terminals by the Bot's own Shell tool through the gate.
 */
const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.close(); vi.restoreAllMocks(); });
const harness = async (...a: Parameters<typeof makeHarness>) => { const h = await makeHarness(...a); open.push(h); return h; };
const RM = "rm -rf /workspace/old";
const exec = (command: string) => ({ tool: { kind: "execute", title: `Run ${command}`, rawInput: { command } }, ask: true });
const perms = (h: Harness) => h.agentLog().filter((e) => e.ev === "permission").map((e) => e.answer);

describe("ACP client: a turn", () => {
  it("round-trips a prompt: the agent's reply streams to the typing indicator and is sent as the Bot's message", async () => {
    const h = await harness("acp", { plan: [{ when: "hello", steps: [{ say: "Hi, I'm here." }] }] });
    await h.send("hello");
    await h.untilIdle();
    expect(h.replies()).toEqual(["Hi, I'm here."]);
    const deltas = h.events.filter((e) => e.kind === "send_message_delta").map((e) => (e as { partialJson: string }).partialJson).join("");
    expect(JSON.parse(`${deltas}"}`)).toEqual({ content: "Hi, I'm here." });
    const init = h.agentLog().find((e) => e.ev === "initialize")!.params as Record<string, unknown>;
    expect(init).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const sn = h.agentLog().find((e) => e.ev === "session/new")!.params as Record<string, unknown>;
    expect(sn).toEqual({ cwd: h.cfg.workspace, mcpServers: [] });
    // Metering: a turn with no tokens and no cost (the vendor plan), on the vendor's model.
    expect(h.bots.sessionId(h.id)).toMatch(/^prov-acp-/);
  });

  it("keeps one process and one vendor session across turns; the first prompt carries the Bot's context once", async () => {
    const h = await harness("acp", { plan: [{ when: "alpha-q", steps: [{ say: "first" }] }, { when: "bravo-q", steps: [{ say: "second" }] }] });
    await h.send("alpha-q");
    await h.untilIdle();
    await h.send("bravo-q");
    await h.untilIdle();
    expect(h.replies()).toEqual(["first", "second"]);
    const log = h.agentLog();
    expect(log.filter((e) => e.ev === "initialize")).toHaveLength(1);
    expect(log.filter((e) => e.ev === "session/new")).toHaveLength(1);
    const prompts = log.filter((e) => e.ev === "prompt").map((e) => String(e.text));
    expect(prompts[0]).toContain("<system-reminder>");
    expect(prompts[1]).not.toContain("<system-reminder>");
  });

  it("vendor tool calls show in the transcript; narration before a tool is not the reply", async () => {
    const h = await harness("acp", { plan: [{ when: "list", steps: [{ say: "Let me look." }, exec("ls /workspace"), { say: "Two files." }] }] });
    await h.send("list");
    await h.untilIdle();
    expect(h.replies()).toEqual(["Two files."]);
    const starts = h.events.filter((e) => e.kind === "tool_start").map((e) => (e as { name: string }).name);
    expect(starts).toContain("Bash");
    expect(h.events.some((e) => e.kind === "tool_end" && (e as { name: string }).name === "Bash")).toBe(true);
  });
});

describe("ACP client: permission requests go only through the approval gate", () => {
  it("the reviewer allows: no card, allow_once", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec("ls /workspace"), { say: "done" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "yes" } }]);
    expect(h.cards()).toEqual([]);
    expect(h.gateLog[0]).toMatch(/^pre Bash .*"decision":"allow"/);
  });

  it("the reviewer blocks → a card; Allow once → allow_once, the command runs", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec(RM), { say: "deleted" }] }] });
    await h.send("go");
    await h.waitCard();
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "once");
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "yes" } }]);
    expect(h.agentLog().filter((e) => e.ev === "ran")).toEqual([expect.objectContaining({ command: RM })]);
    expect(h.cards()[0]).toMatchObject({ status: "approved", command: RM });
    expect(h.replies()).toEqual(["deleted"]);
  });

  it("the user denies → reject_once, the command never runs", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec(RM), { say: "ok, I won't" }] }] });
    await h.send("go");
    await h.waitCard();
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "deny");
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
    expect(h.agentLog().filter((e) => e.ev === "ran")).toEqual([]);
    expect(h.cards()[0]).toMatchObject({ status: "denied" });
  });

  it("Always allow adds Synapse's own rule, but the vendor only ever gets allow_once", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec(RM), { say: "deleted" }] }] });
    await h.send("go");
    await h.waitCard();
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "always");
    await h.untilIdle();
    expect(h.cards()[0]).toMatchObject({ status: "always" });
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "yes" } }]);
  });

  it("a floor rule denies before any review (UI automation), with no card", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec("xdotool key a"), { say: "can't" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
    expect(h.cards()).toEqual([]);
    expect(h.gateLog[0]).toContain("\"decision\":\"deny\"");
  });

  it("an allow with no allow_once on offer is refused (allow_always would stop the vendor asking)", async () => {
    const options = [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "No", kind: "reject_once" }];
    const h = await harness("acp", { plan: [{ when: "go", steps: [{ ...exec("ls"), options }, { say: "x" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
  });

  it("an unknown or unmappable kind is denied without a gate call (fail closed)", async () => {
    // 0.1.6: five refusals of the same shown step in a row would trip the 5.7 loop guard at the fourth (see the next
    // test), so the five kinds run as two turns.
    const h = await harness("acp", { plan: [
      { when: "go", steps: [
        { tool: { kind: "switch_mode", title: "Switch to auto-approve", rawInput: { mode: "yolo" } }, ask: true },
        { tool: { kind: "other", title: "Mystery" }, ask: true },
        { tool: { title: "No kind at all" }, ask: true },
        { say: "ok" },
      ] },
      { when: "more", steps: [
        { tool: { kind: "brand_new_kind", title: "?" }, ask: true },
        { tool: { kind: "execute", title: "Run something", rawInput: {} }, ask: true },
        { say: "ok" },
      ] },
    ] });
    await h.send("go");
    await h.untilIdle();
    await h.send("more");
    await h.untilIdle();
    expect(perms(h)).toEqual(Array(5).fill({ outcome: { outcome: "selected", optionId: "no" } }));
    expect(h.gateLog.filter((l) => !l.includes("SendMessage"))).toEqual([]);
  });

  it("a vendor that keeps asking for refused steps is stopped by the loop guard (5.7, 0.1.6)", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [
      ...Array.from({ length: 6 }, () => ({ tool: { kind: "other", title: "Mystery" }, ask: true })),
      { say: "never" },
    ] }] });
    await h.send("go");
    await waitFor(() => h.runner.loopStopped(h.id));
    await waitFor(() => !h.runner.isRunning(h.id));
    const answers = perms(h);
    expect(answers.slice(0, 4)).toEqual(Array(4).fill({ outcome: { outcome: "selected", optionId: "no" } }));
    expect(answers.length).toBeLessThanOrEqual(5);
    expect(h.replies()).not.toContain("never");
  });

  it("the vendor's own folder (its login and its settings) is denied before the gate, whatever the reviewer says", async () => {
    const h = await harness("acp", { review: () => ({ kind: "allow", stage: "model", verdict: null }), plan: [] });
    fs.writeFileSync(path.join(h.home, "..", "plan.json"), JSON.stringify([{ when: "go", steps: [
      exec("echo '{\"allowAll\":true}' > ~/.copilot/config.json"),
      { tool: { kind: "edit", title: "Edit settings", locations: [{ path: `${h.home}/.cursor/cli-config.json` }] }, ask: true },
      { write: { path: `${h.home}/.kimi-code/config.toml`, content: "yolo = true" } },
      { read: `${h.home}/.copilot/config.json` },
      { terminal: { command: "cat", args: ["$HOME/.vibe/config.toml"] } },
      { say: "done" },
    ] }]));
    await h.send("go");
    await h.untilIdle();
    const log = h.agentLog();
    expect(perms(h)).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }, { outcome: { outcome: "selected", optionId: "no" } }]);
    expect(log.filter((e) => e.ev === "write" || e.ev === "read").every((e) => e.error)).toBe(true);
    expect(log.find((e) => e.ev === "terminal")!.error).toBeTruthy();
    expect(h.handlerRuns).toEqual([]);
    expect(h.gateLog.filter((l) => !l.includes("SendMessage"))).toEqual([]);
    expect(fs.existsSync(path.join(h.home, ".kimi-code"))).toBe(false);
  });

  it("an unknown request method from the agent is refused", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [
      { request: "elicitation/create", params: { message: "Paste your password" } },
      { request: "_vendor/run_anything", params: { cmd: "id" } },
      { request: "mcp/connect", params: { acpId: "x" } },
      { say: "ok" },
    ] }] });
    await h.send("go");
    await h.untilIdle();
    const reqs = h.agentLog().filter((e) => e.ev === "request");
    expect(reqs.map((r) => (r.error as { code: number }).code)).toEqual([-32601, -32601, -32601]);
    expect(reqs.every((r) => r.result === null)).toBe(true);
  });

  it("defer: the turn ends awaiting the user; approving resumes with the approval-resume wake", async () => {
    const h = await harness("acp", { flags: { approvalPath: "defer" }, plan: [
      { when: "The user approved", steps: [exec(RM), { say: "deleted" }] },
      { when: "go", steps: [exec(RM), { say: "asked" }] },
    ] });
    await h.send("go");
    await h.waitCard();
    await h.untilIdle();
    expect(perms(h)[0]).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "once");
    await new Promise((r) => setTimeout(r, 50));
    await h.untilIdle();
    expect(h.sources).toEqual(["user", "approval-resume"]);
    expect(perms(h)[1]).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(h.replies()).toEqual(["deleted"]);
  });
});

describe("ACP client: files and terminals go through Synapse's walled tools", () => {
  it("reads and writes in the Bot's folder work, through the gate and bot-file", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [] }] });
    const ws = h.cfg.workspace;
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
    fs.writeFileSync(path.join(h.home, "..", "plan.json"), JSON.stringify([{ when: "go", steps: [
      { read: `${ws}/a.txt` }, { write: { path: `${ws}/b.txt`, content: "beta" } }, { write: { path: `${ws}/a.txt`, content: "alpha2" } }, { say: "done" },
    ] }]));
    await h.send("go");
    await h.untilIdle();
    const log = h.agentLog();
    expect(log.find((e) => e.ev === "read")).toMatchObject({ result: { content: "alpha\n" } });
    expect(log.filter((e) => e.ev === "write").map((e) => e.error)).toEqual([null, null]);
    expect(fs.readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("beta");
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("alpha2");
    expect(h.gateLog.some((l) => l.startsWith("pre Read "))).toBe(true);
    expect(h.gateLog.some((l) => l.startsWith("pre Write "))).toBe(true);
  });

  it("the host's private folder can't be read or written, and nothing is created there", async () => {
    const h = await harness("acp", { plan: [] });
    const hp = h.cfg.hostPrivate;
    fs.writeFileSync(path.join(hp, "vault.key"), "SECRET-VAULT");
    fs.writeFileSync(path.join(h.home, "..", "plan.json"), JSON.stringify([{ when: "go", steps: [
      { read: `${hp}/vault.key` }, { write: { path: `${hp}/planted.json`, content: "{}" } }, { read: `${h.cfg.workspace}/../.host/vault.key` }, { say: "done" },
    ] }]));
    await h.send("go");
    await h.untilIdle();
    const log = h.agentLog();
    const io = log.filter((e) => e.ev === "read" || e.ev === "write");
    expect(io).toHaveLength(3);
    for (const e of io) { expect(e.result).toBeNull(); expect(e.error).toBeTruthy(); }
    expect(JSON.stringify(log)).not.toContain("SECRET-VAULT");
    expect(fs.existsSync(path.join(hp, "planted.json"))).toBe(false);
  });

  it("a write outside the Bot's folder is reviewed like any Write: a card, and it lands only once allowed", async () => {
    const h = await harness("acp", { plan: [] });
    const target = path.join(h.cfg.workspace, "..", "outside-rm -rf.txt");
    fs.writeFileSync(path.join(h.home, "..", "plan.json"), JSON.stringify([{ when: "go", steps: [{ write: { path: target, content: "x" } }, { say: "done" }] }]));
    await h.send("go");
    await h.waitCard();
    expect(fs.existsSync(target)).toBe(false);
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "deny");
    await h.untilIdle();
    expect(fs.existsSync(target)).toBe(false);
    expect(h.agentLog().find((e) => e.ev === "write")!.error).toBeTruthy();
  });

  it("a terminal is the Bot's own Shell through the gate: its env is not passed on, its output and exit come back", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [{ terminal: { command: "sh", args: ["-c", "echo hi"] } }, { say: "done" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(h.handlerRuns).toEqual(["echo hi"]);
    const t = h.agentLog().find((e) => e.ev === "terminal")!;
    expect(t.exit).toEqual({ exitCode: 0, signal: null });
    expect((t.output as { output: string }).output).toBe("ran: echo hi");
    expect(h.gateLog.some((l) => l.startsWith("pre mcp__bot__Shell ") && !l.includes("LD_PRELOAD"))).toBe(true);
  });

  it("an execute permission the gate allowed isn't asked twice when the terminal carries it out", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec(RM), { terminal: { command: "sh", args: ["-c", RM] } }, { say: "done" }] }] });
    await h.send("go");
    await h.waitCard();
    h.gate.resolve(h.id, h.cards().at(-1)!.approvalId as string, "once");
    await h.untilIdle();
    expect(h.cards()).toHaveLength(1);
    expect(h.handlerRuns).toEqual([RM]);
  });

  it("a terminal the gate refuses never reaches the Shell", async () => {
    const h = await harness("acp", { plan: [] });
    fs.writeFileSync(path.join(h.home, "..", "plan.json"), JSON.stringify([{ when: "go", steps: [{ terminal: { command: "cat", args: [`${h.cfg.hostPrivate}/vault.key`] } }, { say: "done" }] }]));
    await h.send("go");
    await h.untilIdle();
    expect(h.handlerRuns).toEqual([]);
    expect((h.agentLog().find((e) => e.ev === "terminal")!.exit as { exitCode: number }).exitCode).not.toBe(0);
  });
});

describe("ACP client: the vendor's login", () => {
  it("not signed in → 'Sign in needed'; the token file in the Bot's home is never opened by the host, and never leaks", async () => {
    const h = await harness("acp", { agentEnv: { FAKE_ACP_AUTH: "1" }, plan: [{ when: "go", steps: [{ say: "signed in and working" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(h.trays.list().map((t) => t.title)).toContain("Sign in needed");
    expect(h.replies()).toEqual([]);
    // The vendor CLI signs in by itself (its own flow), writing its token in the Bot's home.
    const tokenDir = path.join(h.home, ".fakevendor");
    fs.mkdirSync(tokenDir, { mode: 0o700 });
    fs.writeFileSync(path.join(tokenDir, "token"), "tok_SUPERSECRET_123", { mode: 0o600 });
    const touched: string[] = [];
    const watch = (name: "readFileSync" | "openSync" | "readdirSync" | "statSync" | "existsSync" | "createReadStream") => {
      const orig = fs[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => { touched.push(String(a[0])); return orig.apply(fs, a); }) as never);
    };
    for (const n of ["readFileSync", "openSync", "readdirSync", "statSync", "existsSync", "createReadStream"] as const) watch(n);
    const origRead = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((p: unknown, ...r: unknown[]) => { touched.push(String(p)); return (origRead as (...a: unknown[]) => unknown)(p, ...r); }) as never);
    await h.send("go again go");
    await h.untilIdle();
    vi.restoreAllMocks();
    expect(h.replies()).toEqual(["signed in and working"]);
    expect(touched.length).toBeGreaterThan(0); // the watch saw the host's own file work
    expect(touched.filter((p) => p.includes(".fakevendor"))).toEqual([]);
    // Nothing the host keeps or shows carries the token: transcript, mirror, events.
    const kept = JSON.stringify([h.bots.tail(h.id, 500), h.events, fs.readFileSync(h.bots.sessionFilePath(h.id)!, "utf8")]);
    expect(kept).not.toContain("SUPERSECRET");
    // The CLI's environment is the Bot's HOME and PATH, nothing of the host's (no keys, no tokens).
    const env = h.agentLog().filter((e) => e.ev === "session/new").at(-1)!.env as string[];
    expect(env.filter((k) => /KEY|TOKEN|SECRET|ANTHROPIC|SYNAPSE|PROXY/i.test(k))).toEqual([]);
    expect(h.agentLog().filter((e) => e.ev === "session/new").at(-1)!.home).toBe(h.home);
  });

  it("without the vendor's consent nothing starts", async () => {
    const h = await harness("acp", { consented: false, plan: [{ when: "go", steps: [{ say: "x" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(h.trays.list().map((t) => t.title)).toContain("Not allowed yet");
    expect(h.agentLog()).toEqual([]);
  });

  it("a vendor CLI that isn't installed says so", async () => {
    const { directAcpSpawn } = await import("../../../brain/acp/spawn");
    const h = await harness("acp", { spawn: directAcpSpawn({ command: "/nonexistent/vendor-cli", args: () => [], home: () => "/nonexistent" }) });
    await h.send("go");
    await h.untilIdle();
    expect(h.trays.list().map((t) => t.detail)).toContain("GitHub Copilot isn't installed on the computer yet. Install it in Settings → Account → Coding CLIs.");
  });

  it("a protocol version it doesn't speak is refused", async () => {
    const h = await harness("acp", { agentEnv: { FAKE_ACP_PROTOCOL: "2" }, plan: [{ when: "go", steps: [{ say: "x" }] }] });
    await h.send("go");
    await h.untilIdle();
    expect(h.trays.list().map((t) => t.detail).join(" ")).toContain("version of the protocol");
    expect(h.replies()).toEqual([]);
  });
});

describe("ACP client: cancel and interrupt", () => {
  it("Stop sends session/cancel; the turn ends at once and the next turn reuses the warm process", async () => {
    const h = await harness("acp", { plan: [{ when: "next", steps: [{ say: "back" }] }, { when: "slow", steps: [{ say: "working" }, { sleep: 20_000 }, { say: "never" }] }] });
    h.runner.sendPrompt(h.id, "slow", "s1");
    await waitFor(() => h.agentLog().some((e) => e.ev === "prompt"));
    const t0 = Date.now();
    await h.runner.interruptAgent(h.id);
    await h.untilIdle();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(h.agentLog().some((e) => e.ev === "cancel")).toBe(true);
    expect(h.replies()).toEqual([]);
    await h.send("next");
    await h.untilIdle();
    expect(h.replies()).toEqual(["back"]);
    expect(h.agentLog().filter((e) => e.ev === "initialize")).toHaveLength(1);
  });

  it("Stop while a permission card is pending answers the vendor 'cancelled', and nothing runs", async () => {
    const h = await harness("acp", { plan: [{ when: "go", steps: [exec(RM), { say: "deleted" }] }] });
    await h.send("go");
    await h.waitCard();
    await h.runner.interruptAgent(h.id);
    await h.untilIdle();
    expect(perms(h)).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(h.agentLog().filter((e) => e.ev === "ran")).toEqual([]);
    expect(h.replies()).toEqual([]);
  });
});
