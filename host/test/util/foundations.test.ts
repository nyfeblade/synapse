import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import { AsyncQueue } from "../../util/async-queue";
import { readJson, writeJsonAtomic } from "../../util/atomic-json";
import { sleep } from "../../util/sleep";
import { clearPromptCache, fillTemplate, loadPrompt, promptVersion } from "../../prompts/index";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bots-host-"));

describe("atomic json", () => {
  it("writes via tmp+rename with mode 0600 and reads back", () => {
    const dir = tmp();
    const file = path.join(dir, "a", "b.json");
    writeJsonAtomic(file, { x: 1 });
    expect(readJson(file, null)).toEqual({ x: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("returns the fallback for a missing file", () => {
    expect(readJson(path.join(tmp(), "none.json"), { d: true })).toEqual({ d: true });
  });
});

describe("AsyncQueue", () => {
  it("yields pushed items in order and finishes on end()", async () => {
    const q = new AsyncQueue<number>();
    const out: number[] = [];
    const reader = (async () => { for await (const n of q) out.push(n); })();
    q.push(1); q.push(2);
    await sleep(5);
    q.push(3); q.end();
    await reader;
    expect(out).toEqual([1, 2, 3]);
    expect(() => q.push(4)).toThrow(/closed/);
  });
});

describe("sleep", () => {
  it("rejects when aborted", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe("prompts", () => {
  afterEach(() => { delete process.env.PROMPTS_DIR; clearPromptCache(); });
  it("loads from PROMPTS_DIR, fills templates and versions by content hash", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "x.md"), "Hello {{NAME}}");
    process.env.PROMPTS_DIR = dir;
    expect(fillTemplate(loadPrompt("x.md"), { NAME: "Piper" })).toBe("Hello Piper");
    expect(promptVersion("x.md")).toMatch(/^[0-9a-f]{16}$/);
    expect(() => fillTemplate("{{MISSING}}", {})).toThrow(/MISSING/);
  });
});

describe("config", () => {
  it("defaults to the box layout and honors overrides", () => {
    const c = loadConfig({});
    expect(c.dataRoot).toBe("/home/box/agent-data");
    expect(c.hostPrivate).toBe("/home/box/.host");
    expect(c.workspace).toBe("/workspace");
    expect(c.bind).toBe("127.0.0.1");
    expect(c.port).toBe(47800);
    expect(c.brain).toBe("claude");
    expect(c).not.toHaveProperty("tokenFile"); // synapse-public: no Claude login token file
    expect(c.ccManagedDir).toBe("/var/lib/bots/cc-managed"); // ruling B: the bothost-owned plugins/skills tree
    expect(loadConfig({ SYNAPSE_CC_MANAGED: "/tmp/m" }).ccManagedDir).toBe("/tmp/m");
    const o = loadConfig({ DATA_ROOT: "/tmp/d", HOST_PRIVATE: "/tmp/p", HOST_PORT: "0", BRAIN: "fake", REVIEWER: "stub" });
    expect([o.dataRoot, o.hostPrivate, o.port, o.brain, o.reviewer]).toEqual(["/tmp/d", "/tmp/p", 0, "fake", "stub"]);
  });
});
