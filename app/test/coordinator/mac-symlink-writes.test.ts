/**
 * Bug 441: a Mac file write through a link inside a project (to a file, through a linked folder, or a chain of links)
 * is judged by where it really goes, in every mode, and the executor writes only to the path that was judged: a link
 * swapped in between the check and the write is refused before anything is written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalExecRequest, PermMode } from "@synapse/shared";
import { LocalExecutor, WRITE_MOVED } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

let home: string;
let proj: string;
let docs: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mac-link-home-")));
  proj = path.join(home, "code", "app");
  docs = path.join(home, "Documents");
  fs.mkdirSync(path.join(proj, "deep"), { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "taxes.txt"), "2025 return\n");
  fs.writeFileSync(path.join(proj, "notes.md"), "mine\n");
  fs.symlinkSync(path.join(docs, "taxes.txt"), path.join(proj, "taxes-link.txt")); // a link to a file outside
  fs.symlinkSync(docs, path.join(proj, "docs")); // a linked folder
  fs.symlinkSync(path.join(proj, "docs"), path.join(proj, "deep", "hop")); // a chain: deep/hop → docs → ~/Documents
  fs.symlinkSync(path.join(proj, "notes.md"), path.join(proj, "notes-link.md")); // a link that stays inside
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const key = Buffer.alloc(32, 4);
function policy(mode: PermMode): LocalPolicyStore {
  const p = new LocalPolicyStore(path.join(home, "policy"), Date.now, key, { home: () => home, userData: () => path.join(home, "Library", "Application Support", "Synapse") });
  p.update({ localRoot: home, addAutoRunRoot: proj });
  p.setBotMode("b1", mode);
  return p;
}
let n = 0;
const req = (o: Partial<LocalExecRequest>): LocalExecRequest => ({ execId: `x${++n}`, botId: "b1", approvalId: null, op: "edit-file", cwd: proj, ...o });
const exec = () => new LocalExecutor({ root: () => home, home: () => home, fullAccess: () => true });
const io = (target?: string) => ({ output: () => {}, ...(target !== undefined ? { target } : {}) });

const OUTSIDE = () => [
  path.join(proj, "taxes-link.txt"),
  path.join(proj, "docs", "taxes.txt"),
  path.join(proj, "deep", "hop", "taxes.txt"),
];

describe("bug 441: the policy judges a write by its real path", () => {
  for (const mode of ["full-auto", "accept-edits", "ask"] as const) {
    it(`${mode}: an edit or write through a link to a file outside the project is not a silent run`, () => {
      const p = policy(mode);
      for (const f of OUTSIDE()) {
        expect(p.check(req({ op: "edit-file", path: f })).ok, `edit ${f}`).toBe(false);
        expect(p.check(req({ op: "write-file", path: f })).ok, `write ${f}`).toBe(false);
      }
    });
  }

  it("controls: a link that stays inside the project, and plain project files, still run in Full auto and Auto-accept edits", () => {
    for (const mode of ["full-auto", "accept-edits"] as const) {
      const p = policy(mode);
      expect(p.check(req({ op: "edit-file", path: path.join(proj, "notes-link.md") })).ok, mode).toBe(true);
      expect(p.check(req({ op: "edit-file", path: path.join(proj, "notes.md") })).ok, mode).toBe(true);
    }
    expect(policy("full-auto").check(req({ op: "write-file", path: path.join(proj, "src", "new.ts") })).ok).toBe(true);
  });

  it("the check hands the executor the real path it judged", () => {
    const v = policy("full-auto").check(req({ op: "edit-file", path: path.join(proj, "notes-link.md") }));
    expect(v).toMatchObject({ ok: true, target: path.join(proj, "notes.md") });
    const w = policy("full-auto").check(req({ op: "write-file", path: "src/new.ts" }));
    expect(w).toMatchObject({ ok: true, target: path.join(home, "src", "new.ts") }); // relative to the local root, as the executor resolves it
  });
});

describe("bug 441: the executor writes only where the check judged", () => {
  it("a file swapped for a link after the check: refused, and the outside file is untouched", async () => {
    const f = path.join(proj, "report.md");
    fs.writeFileSync(f, "draft\n");
    const judged = fs.realpathSync.native(f);
    fs.rmSync(f);
    fs.symlinkSync(path.join(docs, "taxes.txt"), f);
    await expect(exec().run(req({ op: "write-file", path: f, content: "gone\n" }), io(judged))).rejects.toThrow(WRITE_MOVED);
    await expect(exec().run(req({ op: "edit-file", path: f, oldString: "2025", newString: "gone" }), io(judged))).rejects.toThrow(WRITE_MOVED);
    expect(fs.readFileSync(path.join(docs, "taxes.txt"), "utf8")).toBe("2025 return\n");
  });

  it("a folder swapped for a link after the check: refused", async () => {
    const dir = path.join(proj, "out");
    fs.mkdirSync(dir);
    const judged = path.join(fs.realpathSync.native(dir), "taxes.txt");
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(docs, dir);
    await expect(exec().run(req({ op: "write-file", path: path.join(dir, "taxes.txt"), content: "gone\n" }), io(judged))).rejects.toThrow(WRITE_MOVED);
    expect(fs.readFileSync(path.join(docs, "taxes.txt"), "utf8")).toBe("2025 return\n");
  });

  it("even without a judged path, the last part is never followed if it is a link that isn't the resolved path", async () => {
    // within() resolves the path first, so the executor writes the real file; O_NOFOLLOW guards the open itself.
    const r = await exec().run(req({ op: "write-file", path: path.join(proj, "notes-link.md"), content: "new\n" }), io());
    expect(r.result).toBe(path.join(proj, "notes.md"));
    expect(fs.readFileSync(path.join(proj, "notes.md"), "utf8")).toBe("new\n");
    expect(fs.lstatSync(path.join(proj, "notes-link.md")).isSymbolicLink()).toBe(true);
  });

  it("controls: the judged path writes and edits as before", async () => {
    const f = path.join(proj, "notes.md");
    await exec().run(req({ op: "edit-file", path: f, oldString: "mine", newString: "ours" }), io(f));
    expect(fs.readFileSync(f, "utf8")).toBe("ours\n");
    const g = path.join(proj, "src", "new.ts");
    await exec().run(req({ op: "write-file", path: g, content: "export {};\n" }), io(g));
    expect(fs.readFileSync(g, "utf8")).toBe("export {};\n");
    await exec().run(req({ op: "write-file", path: g, content: "x\n" }), io(g));
    expect(fs.readFileSync(g, "utf8")).toBe("x\n"); // shorter content replaces, no leftover bytes
  });
});
