import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";

/**
 * feat-mac-access-parity — the CLI-parity Mac file tools (read with line ranges, edit exact-string replace, glob,
 * grep) and FULL-ACCESS mode (run anywhere the user can), still bounded by the protected-path NEVER guard.
 */
let home: string;
let userData: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "macfh-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
});
const io = { output: () => {} };
/** Full access: root is a project subdir, but ops may reach anywhere under home. */
const exec = (full = true) => new LocalExecutor({ root: () => path.join(home, "proj"), home: () => home, userData: () => userData, fullAccess: () => full });
const run = (op: string, extra: Record<string, unknown>) => exec().run({ execId: "e", botId: "b", approvalId: null, op: op as never, ...extra } as never, io);

describe("read-file with a line range (pagination)", () => {
  it("returns only the requested 1-based line window", async () => {
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    fs.writeFileSync(path.join(home, "proj", "a.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const r = await run("read-file", { path: "a.txt", offset: 3, limit: 2 });
    expect(r.result).toBe("line3\nline4");
  });
});

describe("edit-file (exact-string replace, like Claude Code's Edit)", () => {
  it("replaces a unique string; refuses a missing or non-unique one", async () => {
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    const f = path.join(home, "proj", "code.ts");
    fs.writeFileSync(f, "const a = 1;\nconst b = 2;\n");
    await run("edit-file", { path: "code.ts", oldString: "const a = 1;", newString: "const a = 42;" });
    expect(fs.readFileSync(f, "utf8")).toContain("const a = 42;");
    await expect(run("edit-file", { path: "code.ts", oldString: "nope", newString: "x" })).rejects.toThrow(/not found/);
    fs.writeFileSync(f, "x\nx\n");
    await expect(run("edit-file", { path: "code.ts", oldString: "x", newString: "y" })).rejects.toThrow(/appears 2 times/);
    await run("edit-file", { path: "code.ts", oldString: "x", newString: "y", replaceAll: true });
    expect(fs.readFileSync(f, "utf8")).toBe("y\ny\n");
  });

  it("writes the new text literally: $&, $1, $$, $` and $' are not replace patterns", async () => {
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    const f = path.join(home, "proj", "price.sh");
    const next = "echo \"$$ $& $1 $` $'\" # cost: $5";
    fs.writeFileSync(f, "before\nOLD\nafter\n");
    await run("edit-file", { path: "price.sh", oldString: "OLD", newString: next });
    expect(fs.readFileSync(f, "utf8")).toBe(`before\n${next}\nafter\n`);
  });
});

describe("glob and grep", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(home, "proj", "src"), { recursive: true });
    fs.writeFileSync(path.join(home, "proj", "src", "a.ts"), "export const TODO = 1;\n");
    fs.writeFileSync(path.join(home, "proj", "src", "b.js"), "// nothing\n");
    fs.writeFileSync(path.join(home, "proj", "readme.md"), "TODO: write docs\n");
  });
  it("glob returns matching files", async () => {
    const r = await run("glob", { path: path.join(home, "proj"), pattern: "**/*.ts" });
    expect(r.result).toContain("a.ts");
    expect(r.result).not.toContain("b.js");
  });
  it("grep returns file:line:text matches", async () => {
    const r = await run("grep", { path: path.join(home, "proj"), pattern: "TODO" });
    expect(r.result).toContain("a.ts:1:");
    expect(r.result).toContain("readme.md:1:");
    expect(r.result).not.toContain("b.js");
  });
  it("glob and grep never descend into a protected place", async () => {
    fs.mkdirSync(path.join(home, "proj", "sub"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "proj", "linkssh"));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "SECRETKEY");
    const r = await run("grep", { path: path.join(home, "proj"), pattern: "SECRETKEY" });
    expect(r.result).not.toContain("SECRETKEY");
  });
});

describe("FULL ACCESS runs anywhere the user can, but the protected NEVER guard holds", () => {
  it("reads and writes outside the local root when fullAccess is on", async () => {
    fs.mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(home, "elsewhere", "note.txt"), "hi");
    const r = await exec(true).run({ execId: "e", botId: "b", approvalId: null, op: "read-file", path: path.join(home, "elsewhere", "note.txt") }, io);
    expect(r.result).toBe("hi");
    await exec(true).run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: path.join(home, "elsewhere", "out.txt"), content: "ok" }, io);
    expect(fs.readFileSync(path.join(home, "elsewhere", "out.txt"), "utf8")).toBe("ok");
  });
  it("bounded mode still refuses a path outside the local root", async () => {
    await expect(exec(false).run({ execId: "e", botId: "b", approvalId: null, op: "read-file", path: path.join(home, "elsewhere", "x") }, io)).rejects.toThrow(/outside the local root/);
  });
  it("even in full access, keys/keychain/app-data/shell-rc are protected NEVER (file ops)", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
    await expect(exec(true).run({ execId: "e", botId: "b", approvalId: null, op: "read-file", path: "~/.ssh/id_rsa" }, io)).rejects.toThrow(/protected/);
    await expect(exec(true).run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "~/.zshrc", content: "x" }, io)).rejects.toThrow(/protected/);
    await expect(exec(true).run({ execId: "d", botId: "b", approvalId: null, op: "edit-file", path: userData + "/computers.json", oldString: "a", newString: "b" }, io)).rejects.toThrow(/protected/);
  });
  it("the NEVER backstop rejects a secret-reading shell command on the Mac itself", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    await expect(exec(true).run({ execId: "s", botId: "b", approvalId: null, op: "run-command", command: "cat ~/.ssh/id_rsa", cwd: path.join(home, "proj") }, io)).rejects.toThrow(/credential|protected|expose/i);
  });
});
