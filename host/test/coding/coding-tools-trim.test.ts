import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASH_OUTPUT_MAX, createCodingTools, headAndTail } from "../../coding/engines/coding-tools";
import { READ_MAX_CHARS } from "../../tools/builtin/file-tools";
import { localBotFile } from "../../walls/bot-file";

/**
 * 0.1.8 (the coding token gap): what a coding agent's tools send back is shaped like the CLI's, and smaller: Glob and
 * Grep answer with worktree-relative paths, a long command output keeps its start and end with a pointer to the rest,
 * and a Read too big for one answer asks for offset/limit (the CLI's 25,000-token cap).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tools(shellOut = "") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(cwd, "src/big.txt"), `${"x".repeat(200)}\n`.repeat(Math.ceil(READ_MAX_CHARS / 150)));
  const t = createCodingTools({
    botId: "b", agentId: "a", cwd, files: localBotFile({ deny: [] }), signal: () => new AbortController().signal,
    shell: async (_b, _a, r) => ({ text: `${shellOut}\n[exit code 0 · 0.1 s · cwd ${r.cwd}]`, cwd: r.cwd }),
  }).tools;
  const run = (name: string, a: Record<string, unknown>) => t.find((x) => x.name === name)!.handler(a);
  return { cwd, run };
}

describe("coding tools: smaller answers", () => {
  it("Glob and Grep answer with paths relative to the worktree", async () => {
    const { run } = tools();
    expect((await run("Glob", { pattern: "**/*.ts" })).text).toBe("src/a.ts");
    expect((await run("Grep", { pattern: "answer" })).text).toBe("Found 1 file\nsrc/a.ts");
    expect((await run("Grep", { pattern: "answer", output_mode: "content" })).text).toBe("src/a.ts:1:export const answer = 42;");
  });

  it("a long command output keeps its start and its end (with the exit code), and says how to see the middle", async () => {
    const body = `FIRST ERROR\n${"noise line\n".repeat(5_000)}SUMMARY: 3 failed`;
    const { run } = tools(body);
    const r = await run("Bash", { command: "npm test" });
    expect(r.text.length).toBeLessThanOrEqual(BASH_OUTPUT_MAX + 200);
    expect(r.text.startsWith("FIRST ERROR")).toBe(true);
    expect(r.text).toContain("SUMMARY: 3 failed");
    expect(r.text).toMatch(/\[exit code 0 · 0\.1 s · cwd .*\]$/);
    expect(r.text).toContain("characters cut from the middle; rerun with a narrower command");
    expect(headAndTail("short")).toBe("short");
  });

  it("a Read past the CLI's token cap asks for parts, and doesn't count as read (no Write on its strength)", async () => {
    const { run } = tools();
    const big = await run("Read", { file_path: "src/big.txt" });
    expect(big.isError).toBe(true);
    expect(big.text).toContain("Read it in parts with offset and limit");
    expect((await run("Write", { file_path: "src/big.txt", content: "y" })).isError).toBe(true);
    const part = await run("Read", { file_path: "src/big.txt", offset: 1, limit: 10 });
    expect(part.isError).toBeFalsy();
    expect(part.text.split("\n").length).toBeGreaterThanOrEqual(10);
  });
});
