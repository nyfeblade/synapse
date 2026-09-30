import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchTools } from "../../../tools/builtin/search-tools";
import { globRegex, localBotFile, type BotFileAnswer, type BotFileRequest, type BotFileRunner } from "../../../walls/bot-file";

/**
 * Glob and Grep (the bot-file `glob` and `grep` ops): the same cases against the bot-file worker the box runs as the Bot
 * and against the same-uid fallback, as file-tools.test.ts does for Read/Write/Edit. The walls are the file tools': a
 * search never shows another Bot's files or the host's private folder, whatever link or `..` leads there.
 */
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../box/files/bot-file-worker.py");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function tree() {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bs-")));
  cleanups.push(() => fs.rmSync(T, { recursive: true, force: true }));
  const bots = path.join(T, "home/bots");
  const me = path.join(bots, "bot-aaaaaaaaaaaa");
  const other = path.join(bots, "bot-bbbbbbbbbbbb");
  const host = path.join(T, "home/box/.host");
  const repo = path.join(me, "code/app");
  for (const d of [path.join(repo, "src/lib"), path.join(repo, "test"), path.join(repo, ".git"), path.join(repo, "node_modules/dep"), other, host]) fs.mkdirSync(d, { recursive: true });
  const put = (f: string, text: string | Buffer, mtime: number) => { fs.writeFileSync(f, text); fs.utimesSync(f, mtime, mtime); };
  put(path.join(repo, "src/a.ts"), "export const add = (a: number, b: number) => a + b;\n// TODO: subtract\n", 1_000_000);
  put(path.join(repo, "src/lib/b.ts"), "import { add } from \"../a\";\nexport const twice = (x: number) => add(x, x);\n", 2_000_000);
  put(path.join(repo, "src/lib/c.tsx"), "export const View = () => null; // todo later\n", 3_000_000);
  put(path.join(repo, "test/a.test.ts"), "import { add } from \"../src/a\";\nit(\"adds\", () => expect(add(1, 2)).toBe(3));\n", 4_000_000);
  put(path.join(repo, "README.md"), "# app\nline 2\nline 3\nTODO: docs\nline 5\n", 500_000);
  put(path.join(repo, "logo.bin"), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0, 1, 2]), 600_000); // "TODO" then NUL: binary, skipped
  put(path.join(repo, ".git/config"), "TODO in git\n", 700_000);
  put(path.join(repo, "node_modules/dep/index.ts"), "// TODO in a dependency\n", 800_000);
  fs.writeFileSync(path.join(other, "secret.ts"), "OTHER-BOT-SECRET TODO\n");
  fs.writeFileSync(path.join(host, "vault.ts"), "HOST-SECRET TODO\n");
  fs.symlinkSync(path.join(other, "secret.ts"), path.join(repo, "src/sneaky.ts")); // a linked file into another Bot's home
  fs.symlinkSync(other, path.join(repo, "src/otherdir")); // a folder link: never followed
  fs.symlinkSync(host, path.join(repo, "hostdir"));
  put(path.join(repo, "notes.txt"), "hello\n", 100_000);
  fs.symlinkSync(path.join(repo, "notes.txt"), path.join(repo, "alias.ts")); // a linked file inside the walls: found
  return { T, bots, me, other, host, repo };
}

type Impl = (t: ReturnType<typeof tree>) => BotFileRunner;
const local: Impl = (t) => localBotFile({ deny: [t.host], botHomes: t.bots, ownHome: () => t.me });
const python: Impl = (t) => async (_id: string, req: BotFileRequest) => {
  const r = spawnSync("python3", ["-I", "-S", WORKER, t.me, t.bots, t.host], { input: JSON.stringify(req), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`worker failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as BotFileAnswer;
};

describe("glob patterns", () => {
  it("** crosses folders, * and ? stay in one, braces and classes", () => {
    const m = (p: string, s: string) => globRegex(p).test(s);
    expect(m("**/*.ts", "a.ts")).toBe(true);
    expect(m("**/*.ts", "src/lib/b.ts")).toBe(true);
    expect(m("*.ts", "src/a.ts")).toBe(false);
    expect(m("src/*.ts", "src/lib/b.ts")).toBe(false);
    expect(m("src/**", "src/lib/b.ts")).toBe(true);
    expect(m("**/*.{ts,tsx}", "src/lib/c.tsx")).toBe(true);
    expect(m("?.ts", "a.ts")).toBe(true);
    expect(m("[!b].ts", "b.ts")).toBe(false);
    expect(m("a.ts", "aXts")).toBe(false); // the dot is literal
  });
});

describe.each([["same-uid (TS)", local], ["bot-file worker (python)", python]] as const)("Glob and Grep: %s", (_name, impl) => {
  it("glob: matching files newest first, .git and node_modules skipped, links followed only to files inside the walls", async () => {
    const t = tree();
    const run = impl(t);
    const r = await run("b", { op: "glob", path: t.repo, pattern: "**/*.ts" }) as Extract<BotFileAnswer, { kind: "paths" }>;
    expect(r.ok).toBe(true);
    const rel = r.paths.map((p) => path.relative(t.repo, p));
    expect(rel.slice(0, 3)).toEqual(["test/a.test.ts", "src/lib/b.ts", "src/a.ts"]);
    expect(rel.at(-1)).toBe("alias.ts"); // by its target's time
    expect(rel).not.toContain("src/sneaky.ts");
    expect(rel.some((p) => p.includes("node_modules") || p.includes("otherdir") || p.includes("hostdir"))).toBe(false);
    expect(await run("b", { op: "glob", path: t.repo, pattern: "node_modules/**/*.ts" })).toMatchObject({ ok: true, paths: [path.join(t.repo, "node_modules/dep/index.ts")] });
    expect(await run("b", { op: "glob", path: t.repo, pattern: `${t.repo}/src/*.ts` })).toMatchObject({ ok: true, paths: [path.join(t.repo, "src/a.ts")] });
    expect(await run("b", { op: "glob", path: t.repo, pattern: "*.nothing" })).toEqual({ ok: true, kind: "paths", paths: [] });
  });

  it("grep: files (newest first), content with line numbers and context, count, case, glob filter; binary and .git skipped", async () => {
    const t = tree();
    const run = impl(t);
    const files = await run("b", { op: "grep", path: t.repo, pattern: "TODO", mode: "files" }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(files).toMatchObject({ ok: true, files: 2, matches: 2 });
    expect(files.text.split("\n").map((p) => path.relative(t.repo, p))).toEqual(["src/a.ts", "README.md"]);
    const ci = await run("b", { op: "grep", path: t.repo, pattern: "todo", mode: "count", ignoreCase: true }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(ci.text.split("\n").map((l) => path.relative(t.repo, l))).toEqual(["README.md:1", "src/a.ts:1", "src/lib/c.tsx:1"]);
    const content = await run("b", { op: "grep", path: t.repo, pattern: "TODO", mode: "content", context: 1, glob: "*.md" }) as Extract<BotFileAnswer, { kind: "grep" }>;
    const f = path.join(t.repo, "README.md");
    expect(content.text).toBe(`${f}-3-line 3\n${f}:4:TODO: docs\n${f}-5-line 5`);
    const one = await run("b", { op: "grep", path: path.join(t.repo, "src/a.ts"), pattern: "add|subtract", mode: "content" }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(one.text).toBe(`${path.join(t.repo, "src/a.ts")}:1:export const add = (a: number, b: number) => a + b;\n${path.join(t.repo, "src/a.ts")}:2:// TODO: subtract`);
    const lim = await run("b", { op: "grep", path: t.repo, pattern: "a", mode: "content", limit: 2 }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(lim.text.split("\n")).toHaveLength(2);
    expect(lim.cut).toBe(true);
    expect(await run("b", { op: "grep", path: t.repo, pattern: "(", mode: "files" })).toMatchObject({ ok: false, error: "Invalid regular expression: (" });
    expect(await run("b", { op: "grep", path: t.repo, pattern: "zzz-none" })).toMatchObject({ ok: true, matches: 0, files: 0, text: "" });
  });

  it("walls: another Bot's home and the host's private folder are never searched, directly or through a link", async () => {
    const t = tree();
    const run = impl(t);
    const refused = (r: BotFileAnswer) => !r.ok && /off limits|another Bot's/.test(r.error);
    for (const req of [
      { op: "glob", path: t.other, pattern: "**/*" },
      { op: "glob", path: path.join(t.repo, "src/otherdir"), pattern: "**/*" },
      { op: "glob", path: path.join(t.repo, "hostdir"), pattern: "*" },
      { op: "grep", path: t.host, pattern: "SECRET" },
      { op: "grep", path: path.join(t.repo, "src/sneaky.ts"), pattern: "SECRET" },
      { op: "grep", path: path.join(t.me, "..", "bot-bbbbbbbbbbbb"), pattern: "SECRET" },
    ] as BotFileRequest[]) expect(refused(await run("b", req)), JSON.stringify(req)).toBe(true);
    // A search from above every home shows nothing walled off, and never another Bot's or the host's text.
    const all = await run("b", { op: "grep", path: t.T, pattern: "SECRET|TODO", mode: "content" }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(all.ok).toBe(true);
    expect(all.text).not.toMatch(/OTHER-BOT-SECRET|HOST-SECRET/);
    expect(all.text).toContain("TODO: docs");
    // From the folder of all homes itself: it walks through to the Bot's own home, and no other.
    const homes = await run("b", { op: "grep", path: t.bots, pattern: "SECRET|TODO", mode: "files" }) as Extract<BotFileAnswer, { kind: "grep" }>;
    expect(homes.ok).toBe(true);
    expect(homes.text.split("\n").every((p) => p.startsWith(t.me))).toBe(true);
    expect(homes.text).toContain(path.join(t.repo, "README.md"));
    const everything = await run("b", { op: "glob", path: t.T, pattern: "**/*" }) as Extract<BotFileAnswer, { kind: "paths" }>;
    expect(everything.paths.some((p) => p.startsWith(t.other) || p.startsWith(t.host) || p.endsWith("sneaky.ts"))).toBe(false);
    expect(await run("b", { op: "glob", path: "relative/dir", pattern: "*" })).toEqual({ ok: false, error: "file_path must be an absolute path." });
    expect(await run("b", { op: "glob", path: "/proc", pattern: "*" })).toMatchObject({ ok: false, error: "That path is off limits." });
  });
});

describe("the Glob and Grep tools", () => {
  it("search the current folder by default, take relative paths from it, and answer in the CLI's words", async () => {
    const t = tree();
    const [glob, grep] = createSearchTools({ botId: "b", files: local(t), cwd: () => t.repo });
    expect((await glob!.handler({ pattern: "src/lib/*" })).text).toBe(`${path.join(t.repo, "src/lib/c.tsx")}\n${path.join(t.repo, "src/lib/b.ts")}`);
    expect((await glob!.handler({ pattern: "*.nope" })).text).toBe("No files found");
    expect((await grep!.handler({ pattern: "TODO", path: "src" })).text).toBe(`Found 1 file\n${path.join(t.repo, "src/a.ts")}`);
    expect((await grep!.handler({ pattern: "todo", "-i": true, output_mode: "count" })).text).toContain("Found 3 total occurrences across 3 files.");
    expect((await grep!.handler({ pattern: "nothing-here" })).text).toBe("No matches found");
    const walled = await grep!.handler({ pattern: "SECRET", path: path.join(t.repo, "src/sneaky.ts") });
    expect(walled).toMatchObject({ isError: true });
    expect(walled.text).toContain("another Bot's");
  });
});
