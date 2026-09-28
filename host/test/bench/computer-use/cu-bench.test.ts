import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { estimateCu, OBS, PROFILE } from "../../../bench/computer-use/estimate";
import { FakeCuBox, type FakeCuModel } from "../../../bench/computer-use/fake";
import { GatewayCuBox, isBenchCuName } from "../../../bench/computer-use/gateway-cu-box";
import { main } from "../../../bench/computer-use/main";
import { transcriptMetrics } from "../../../bench/computer-use/metrics";
import { DEFAULT_CU_BUDGET, runCuBench } from "../../../bench/computer-use/runner";
import { PAGES, SERVER_JS, TASKS, taskById, type SystemState } from "../../../bench/computer-use/tasks";

// Offline only: a fake box and a fake model. No model is ever called, nothing touches the box.
const made: string[] = [];
const out = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cu-test-")); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const realEnv = process.env.BENCH_REAL;
afterEach(() => { if (realEnv === undefined) delete process.env.BENCH_REAL; else process.env.BENCH_REAL = realEnv; });

const empty = (): SystemState => ({ submissions: {}, files: {}, xfconf: { before: null, after: null } });
const XML = (v: boolean) => `<?xml version="1.0"?><channel name="thunar" version="1.0"><property name="misc-single-click" type="bool" value="${v}"/></channel>`;

/** A state that satisfies each task, written from the task's success condition (not from its code). */
const GOOD: Record<string, SystemState> = {
  W1: { ...empty(), submissions: { W1: [{ user: "maria.lopez", pass: "Tulip-4411" }] } },
  W2: { ...empty(), submissions: { W2: [{ name: "Ada Byron", city: "Leeds", plan: "Team", confirm: true }] } },
  W3: { ...empty(), submissions: { W3: [{ answer: "73.15" }] } },
  W4: { ...empty(), submissions: { W4: [{ consent: "reject" }, { subscribed: "weekly" }] } },
  W5: { ...empty(), submissions: { W5: [{ modal: "continue" }, { email: "ops@example.test", sent: true }] } },
  W6: { ...empty(), submissions: { W6: [{ deleted: "Invoice 3" }] } },
  D1: { ...empty(), files: { "notes.txt": "draft 42\n", "out/report-final.txt": "draft 42\napproved\n" } },
  D2: { ...empty(), files: { "photos/IMG_0001.jpg": null, "photos/beach.jpg": "jpeg-bytes-1" } },
  D3: { ...empty(), xfconf: { before: XML(false), after: XML(true) } },
  H1: { ...empty(), submissions: { H1: [{ hit: "red" }] } },
  H2: { ...empty(), submissions: { H2: [{ file: "report.pdf", action: "move", to: "Archive" }] } },
  H3: { ...empty(), submissions: { H3: [{ card: "Task B", column: "done" }] } },
};

describe("computer-use task suite", () => {
  it("has 10-12 tasks across web, desktop and hard, each checkable from system state", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(10);
    expect(TASKS.length).toBeLessThanOrEqual(12);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const c of ["web", "desktop", "hard"] as const) expect(TASKS.filter((t) => t.category === c).length).toBeGreaterThanOrEqual(3);
    for (const t of TASKS) {
      const p = t.prompt({ base: "http://127.0.0.1:18123", desk: "/workspace/bench-cu-abcd1234/desk" });
      expect(p.length, t.id).toBeGreaterThan(40);
      expect(p, `${t.id} tells the Bot to use its computerUse subagent`).toMatch(/computerUse/);
      expect(p, `${t.id} forbids shortcuts that bypass the screen`).toMatch(/Shell/);
      if (t.page) expect(PAGES[t.page], `${t.id} page`).toMatch(/<html/i);
    }
    expect(SERVER_JS).toMatch(/submissions\.json/);
  });

  it("every web page is local: no external URL is loaded", () => {
    for (const [name, html] of Object.entries(PAGES)) expect(html, name).not.toMatch(/(src|href)=["']https?:\/\//i);
  });

  it("each check passes on the task's success state and fails on an empty one", () => {
    for (const t of TASKS) {
      expect(GOOD[t.id], `a good state for ${t.id}`).toBeDefined();
      const good = t.check(GOOD[t.id]!);
      expect(good.pass, `${t.id}: ${good.reason}`).toBe(true);
      const bad = t.check(empty());
      expect(bad.pass, `${t.id} on an empty state`).toBe(false);
      expect(bad.reason.length).toBeGreaterThan(0);
    }
  });

  it("checks reject near misses", () => {
    expect(taskById("W1").check({ ...empty(), submissions: { W1: [{ user: "maria.lopez", pass: "wrong" }] } }).pass).toBe(false);
    expect(taskById("W3").check({ ...empty(), submissions: { W3: [{ answer: "73.51" }] } }).pass).toBe(false);
    expect(taskById("W4").check({ ...empty(), submissions: { W4: [{ consent: "accept" }, { subscribed: "weekly" }] } }).pass).toBe(false);
    expect(taskById("D1").check({ ...empty(), files: { "out/report-final.txt": "approved\n" } }).pass).toBe(false);
    expect(taskById("D2").check({ ...empty(), files: { "photos/IMG_0001.jpg": "jpeg-bytes-1", "photos/beach.jpg": "jpeg-bytes-1" } }).pass).toBe(false);
    expect(taskById("D3").check({ ...empty(), xfconf: { before: XML(true), after: XML(true) } }).pass).toBe(false);
    expect(taskById("H1").check({ ...empty(), submissions: { H1: [{ hit: "blue" }, { hit: "red" }] } }).pass).toBe(false);
    expect(taskById("H3").check({ ...empty(), submissions: { H3: [{ card: "Task A", column: "done" }] } }).pass).toBe(false);
  });
});

describe("transcript metrics", () => {
  it("counts each assistant message once, sums its usage, and counts images sent back in tool results", () => {
    const u = { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 };
    const lines = [
      { type: "assistant", message: { id: "m1", usage: u, content: [{ type: "tool_use", name: "mcp__computer__Computer" }] } },
      { type: "assistant", message: { id: "m1", usage: u, content: [{ type: "text", text: "same message, second block" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "ok" }, { type: "image", source: {} }] }] } },
      { type: "assistant", message: { id: "m2", usage: u, content: [{ type: "tool_use", name: "mcp__computer__Look" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "e1 button \"Save\"" }] }] } },
      "not json",
    ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    const m = transcriptMetrics(lines);
    expect(m.calls).toBe(2);
    expect(m.usage).toEqual({ fresh: 6, cacheRead: 2000, cacheWrite: 400, output: 100 });
    expect(m.images).toBe(1);
    expect(m.tools).toEqual({ "mcp__computer__Computer": 1, "mcp__computer__Look": 1 });
  });
});

/** Solves the task by writing its success state into the fake box; screenshots mode sends 6 images, live 1. */
const solver: FakeCuModel = ({ task, mode }) => ({ state: GOOD[task.id]!, text: "Done.", images: mode === "live" ? 1 : 6, calls: mode === "live" ? 5 : 8 });

describe("runner (fake box, fake model)", () => {
  it("runs both modes on one model, sets the mode per Bot, scores from system state and deletes every bench Bot", async () => {
    const box = new FakeCuBox(solver);
    const r = await runCuBench({ box, modes: ["screenshots", "live"], taskIds: ["W1", "D1"], model: "claude-sonnet-5", timeoutMs: 20_000, outDir: out() });
    expect(r.results.map((x) => [x.mode, x.taskId, x.success])).toEqual([["screenshots", "W1", true], ["screenshots", "D1", true], ["live", "W1", true], ["live", "D1", true]]);
    expect(box.perceptionCalls.map((c) => c.mode)).toEqual(["screenshots", "screenshots", "live", "live"]);
    expect(new Set(box.createdModels)).toEqual(new Set(["claude-sonnet-5"]));
    const live = r.results.find((x) => x.mode === "live" && x.taskId === "W1")!;
    // calls = the parent's 3 usage.db turns + the child's 5 transcript messages; images come from the child only.
    expect([live.images, live.calls]).toEqual([1, 3 + 5]);
    expect(live.usage).not.toBeNull();
    expect(live.weighted).toBeGreaterThan(0);
    expect([...box.bots.values()].map((b) => b.name)).toEqual(["Research"]);
    expect(fs.existsSync(r.jsonPath) && fs.readFileSync(r.mdPath, "utf8")).toMatch(/Screenshots|screenshots/);
  }, 30_000);

  it("never trusts the Bot's claim: a Bot that says Done but changed nothing fails", async () => {
    const box = new FakeCuBox(() => ({ state: empty(), text: "Done, I clicked Save.", images: 3, calls: 3 }));
    const r = await runCuBench({ box, modes: ["live"], taskIds: ["W3"], model: "m", timeoutMs: 20_000, outDir: out() });
    expect(r.results[0]!.success).toBe(false);
    expect(r.results[0]!.claimedDone).toBe(true);
  }, 30_000);

  it("counts approvals and box-help as interventions", async () => {
    const box = new FakeCuBox(({ task }) => ({ state: GOOD[task.id]!, text: "ok", approvals: 1, boxHelp: 1 }));
    const r = await runCuBench({ box, modes: ["live"], taskIds: ["W1"], model: "m", timeoutMs: 20_000, outDir: out() });
    expect(r.results[0]!.interventions.map((i) => i.kind).sort()).toEqual(["approval", "box-help"]);
  }, 30_000);

  it("deletes the bench Bot in finally even when the run throws, and tears the sites down", async () => {
    const box = new FakeCuBox(solver);
    box.failSendPrompt = true;
    const r = await runCuBench({ box, modes: ["screenshots"], taskIds: ["W1", "W2"], model: "m", timeoutMs: 20_000, outDir: out() });
    expect(r.results.every((x) => !x.success && x.error)).toBe(true);
    expect([...box.bots.values()].map((b) => b.name)).toEqual(["Research"]);
    expect(box.deleted.length).toBe(2);
    expect(box.tornDown).toBe(true);
  }, 30_000);

  it("refuses a real box without BENCH_REAL=1", async () => {
    delete process.env.BENCH_REAL;
    const box = new FakeCuBox(solver);
    (box as { real: boolean }).real = true;
    await expect(runCuBench({ box, modes: ["live"], taskIds: ["W1"], model: "m", timeoutMs: 1_000, outDir: out() })).rejects.toThrow(/BENCH_REAL=1/);
    expect(box.created).toBe(0);
  });
});

describe("gateway box safety", () => {
  it("only ever deletes a Bot currently named bench-cu-<8 lowercase alnum>", async () => {
    expect(isBenchCuName("bench-cu-abcd1234")).toBe(true);
    for (const n of ["Research", "bench-abcd1234", "bench-cu-ABCD1234", "bench-cu-abcd1234-copy", "xbench-cu-abcd1234"]) expect(isBenchCuName(n), n).toBe(false);
    const box = new GatewayCuBox();
    const calls: string[] = [];
    const agents = [{ id: "b1", profile: { name: "bench-cu-abcd1234" } }, { id: "c1", profile: { name: "bench-abcd1234" } }, { id: "u1", profile: { name: "Research" } }];
    box.call = async (cmd: string, args: Record<string, unknown>) => {
      calls.push(`${cmd}:${String(args.id ?? "")}`);
      if (cmd === "listAgents") return { agents };
      if (cmd === "deleteAgent") return {};
      throw new Error(cmd);
    };
    await box.deleteBot("b1");
    await expect(box.deleteBot("c1")).rejects.toThrow(/not a computer-use bench Bot/);
    await expect(box.deleteBot("u1")).rejects.toThrow(/named "Research"/);
    expect(calls.filter((c) => c.startsWith("deleteAgent"))).toEqual(["deleteAgent:b1"]);
  });
});

describe("CLI entry", () => {
  const capture = () => { const lines: string[] = []; return { lines, out: (s: string) => lines.push(s) }; };

  it("--dry-run prints the plan and never builds a box", async () => {
    let built = 0;
    const c = capture();
    const code = await main(["--dry-run"], { makeBox: () => { built += 1; return new FakeCuBox(solver); }, out: c.out });
    expect(code).toBe(0);
    expect(built).toBe(0);
    const text = c.lines.join("\n");
    for (const t of TASKS) expect(text).toContain(t.id);
    expect(text).toMatch(/screenshots/);
    expect(text).toMatch(/live/);
  });

  it("refuses a real run without BENCH_REAL=1 and never builds a box", async () => {
    delete process.env.BENCH_REAL;
    let built = 0;
    const c = capture();
    const code = await main([], { makeBox: () => { built += 1; return new FakeCuBox(solver); }, out: c.out });
    expect(code).toBe(2);
    expect(built).toBe(0);
    expect(c.lines.join("\n")).toMatch(/BENCH_REAL=1/);
  });

  it("--estimate prints both modes and a total", async () => {
    const c = capture();
    expect(await main(["--estimate"], { makeBox: () => { throw new Error("no box"); }, out: c.out })).toBe(0);
    expect(c.lines.join("\n")).toMatch(/screenshots[\s\S]*live[\s\S]*total/i);
  });
});

describe("estimate", () => {
  it("applies the lab's 84% observation saving to Live and adds the modes into the total", () => {
    expect(OBS.live).toBe(Math.round(OBS.screenshots * (1 - 0.84)));
    const e = estimateCu(TASKS.map((t) => t.id), ["screenshots", "live"]);
    const s = e.modes.find((m) => m.mode === "screenshots")!;
    const l = e.modes.find((m) => m.mode === "live")!;
    expect(l.tokens).toBeLessThan(s.tokens);
    expect(e.tokens).toBe(s.tokens + l.tokens);
    expect(e.weighted).toBeCloseTo(s.weighted + l.weighted, 6);
    expect(s.images).toBeGreaterThan(l.images);
    // tokens = every input row + output, the plan-spend number
    expect(s.tokens).toBe(s.usage.fresh + s.usage.cacheRead + s.usage.cacheWrite + s.usage.output);
    expect(PROFILE.parentCalls).toBeGreaterThan(0);
  });

  it("a single task's estimate is smaller than the whole suite's", () => {
    expect(estimateCu(["W1"], ["live"]).tokens).toBeLessThan(estimateCu(TASKS.map((t) => t.id), ["live"]).tokens);
  });
});

// bug-log: the real pilot spent 38.3M (Screenshots) + 8.7M (Live) tokens on 4 tasks against an estimate of <=4.3M.
// Every run now has a hard per-task budget: weighted tokens and wall time. Past either, the Bot is stopped
// (interrupted, then deleted, which stops its computerUse child) and the task is marked "budget exceeded".
describe("per-task budget", () => {
  const hog = (calls: number): FakeCuModel => ({ task }) => ({ state: GOOD[task.id]!, text: "Done.", calls, hang: true });

  it("stops a run whose weighted tokens pass the cap and marks it budget exceeded, even if the state looks solved", async () => {
    const box = new FakeCuBox(hog(50)); // 50 child messages x ~1.5k weighted each = ~75k
    const t0 = Date.now();
    const r = await runCuBench({ box, modes: ["screenshots"], taskIds: ["W1"], model: "m", timeoutMs: 20_000, outDir: out(), budget: { maxWeighted: 10_000, pollMs: 10 } });
    const x = r.results[0]!;
    expect(x.budgetExceeded).toBe("tokens");
    expect(x.success).toBe(false);
    expect(x.reason).toMatch(/budget exceeded/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(box.calls.some((c) => c.cmd === "interruptAgent")).toBe(true);
    expect([...box.bots.values()].map((b) => b.name)).toEqual(["Research"]);
    expect(fs.readFileSync(r.mdPath, "utf8")).toMatch(/BUDGET EXCEEDED/);
  }, 30_000);

  it("stops a run that passes the wall-time cap and marks it budget exceeded", async () => {
    const box = new FakeCuBox(hog(1));
    const r = await runCuBench({ box, modes: ["screenshots"], taskIds: ["W1"], model: "m", timeoutMs: 20_000, outDir: out(), budget: { maxWeighted: 1e12, maxWallMs: 150, pollMs: 10 } });
    const x = r.results[0]!;
    expect(x.budgetExceeded).toBe("time");
    expect(x.success).toBe(false);
    expect(x.reason).toMatch(/budget exceeded/);
    expect(box.calls.some((c) => c.cmd === "interruptAgent")).toBe(true);
    expect(box.deleted.length).toBe(1);
  }, 30_000);

  it("a run inside its budget is untouched", async () => {
    const box = new FakeCuBox(solver);
    const r = await runCuBench({ box, modes: ["screenshots"], taskIds: ["W1"], model: "m", timeoutMs: 20_000, outDir: out(), budget: { maxWeighted: 1e9, pollMs: 10 } });
    expect(r.results[0]).toMatchObject({ success: true, budgetExceeded: null });
  }, 30_000);

  it("every run has a budget by default, printed by --dry-run; --max-weighted overrides it", async () => {
    expect(DEFAULT_CU_BUDGET.maxWeighted).toBeGreaterThan(0);
    const lines: string[] = [];
    expect(await main(["--dry-run", "--max-weighted", "250000"], { makeBox: () => { throw new Error("no box"); }, out: (s) => lines.push(s) })).toBe(0);
    expect(lines.join("\n")).toMatch(/budget.*250,?000 weighted tokens/i);
    expect(await main(["--dry-run", "--max-weighted", "nope"], { makeBox: () => { throw new Error("no box"); }, out: () => {} })).toBe(2);
  });
});
