import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFileTools } from "../../../tools/builtin/file-tools";
import { botUserName } from "../../../walls/bot-uid";
import { localBotFile, type BotFileAnswer, type BotFileRequest, type BotFileRunner } from "../../../walls/bot-file";
import { FakeUsers } from "../../box/fake-users";

/**
 * The two implementations of the file protocol (the bot-file worker the box runs as the Bot, and the same-uid
 * fallback) against the same cases. The kernel's own walls (another Bot's 0700 home) are proven on a throwaway OrbStack
 * machine by box/bot-file-sim.sh; here, the path walls both add on top.
 */
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../box/files/bot-file-worker.py");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function tree() {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bf-")));
  cleanups.push(() => fs.rmSync(T, { recursive: true, force: true }));
  const bots = path.join(T, "home/bots");
  const me = path.join(bots, "bot-aaaaaaaaaaaa");
  const other = path.join(bots, "bot-bbbbbbbbbbbb");
  const host = path.join(T, "home/box/.host");
  const ws = path.join(T, "workspace");
  for (const d of [me, other, host, ws]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(other, "secret.txt"), "OTHER-BOT-SECRET\n");
  fs.writeFileSync(path.join(host, "vault.key"), "HOST-SECRET\n");
  fs.writeFileSync(path.join(me, "notes.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(me, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.symlinkSync(path.join(other, "secret.txt"), path.join(me, "sneaky"));
  fs.symlinkSync(host, path.join(me, "hostdir"));
  fs.symlinkSync(other, path.join(ws, "into-other"));
  return { T, bots, me, other, host, ws };
}

type Impl = (t: ReturnType<typeof tree>) => BotFileRunner;
const local: Impl = (t) => localBotFile({ deny: [t.host], botHomes: t.bots, ownHome: () => t.me });
const python: Impl = (t) => async (_id: string, req: BotFileRequest) => {
  const r = spawnSync("python3", ["-I", "-S", WORKER, t.me, t.bots, t.host], { input: JSON.stringify(req), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`worker failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as BotFileAnswer;
};

describe.each([["same-uid (TS)", local], ["bot-file worker (python)", python]] as const)("file protocol: %s", (_name, impl) => {
  it("reads numbered lines with offset and limit, and images as base64", async () => {
    const t = tree();
    const run = impl(t);
    const r = await run("b", { op: "read", path: path.join(t.me, "notes.txt") });
    expect(r).toMatchObject({ ok: true, kind: "text", text: "     1\tone\n     2\ttwo\n     3\tthree", lines: 3, total: 3 });
    expect(await run("b", { op: "read", path: path.join(t.me, "notes.txt"), offset: 2, limit: 1 })).toMatchObject({ ok: true, text: "     2\ttwo", cut: true });
    expect(await run("b", { op: "read", path: path.join(t.me, "pic.png") })).toMatchObject({ ok: true, kind: "image", mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64") });
    expect(await run("b", { op: "read", path: path.join(t.me, "missing.txt") })).toEqual({ ok: false, error: "File does not exist." });
    expect(await run("b", { op: "read", path: "notes.txt" })).toEqual({ ok: false, error: "file_path must be an absolute path." });
  });

  it("writes new files (with folders), and an existing one only after reading it, unchanged", async () => {
    const t = tree();
    const run = impl(t);
    const f = path.join(t.me, "a/b/new.txt");
    const w = await run("b", { op: "write", path: f, content: "hello", expect: null });
    expect(w).toMatchObject({ ok: true, created: true });
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
    const notes = path.join(t.me, "notes.txt");
    expect(await run("b", { op: "write", path: notes, content: "x", expect: null })).toEqual({ ok: false, error: "File has not been read yet. Read it first before writing to it." });
    const r = await run("b", { op: "read", path: notes }) as { sha: string };
    fs.appendFileSync(notes, "four\n");
    expect(await run("b", { op: "write", path: notes, content: "x", expect: r.sha })).toEqual({ ok: false, error: "File has been modified since it was read. Read it again before writing to it." });
    const r2 = await run("b", { op: "read", path: notes }) as { sha: string };
    expect(await run("b", { op: "write", path: notes, content: "x", expect: r2.sha })).toMatchObject({ ok: true, created: false });
    expect(fs.readFileSync(notes, "utf8")).toBe("x");
    expect(fs.readdirSync(t.me).filter((n) => n.startsWith(".bot-file-"))).toEqual([]); // no temp file left
  });

  it("edits exact text: unique, several (refused without replace_all), all, missing", async () => {
    const t = tree();
    const run = impl(t);
    const f = path.join(t.me, "e.txt");
    fs.writeFileSync(f, "a b a c a");
    const sha = (await run("b", { op: "read", path: f }) as { sha: string }).sha;
    expect(await run("b", { op: "edit", path: f, old: "a", new: "z", all: false, expect: sha })).toEqual({ ok: false, error: "old_string appears 3 times. Give more context to make it unique, or set replace_all." });
    expect(await run("b", { op: "edit", path: f, old: "q", new: "z", all: false, expect: sha })).toEqual({ ok: false, error: "old_string was not found in the file." });
    const e1 = await run("b", { op: "edit", path: f, old: "b", new: "$&B", all: false, expect: sha }) as { ok: true; sha: string };
    expect(e1).toMatchObject({ ok: true, count: 1 });
    expect(fs.readFileSync(f, "utf8")).toBe("a $&B a c a");
    expect(await run("b", { op: "edit", path: f, old: "a", new: "z", all: true, expect: e1.sha })).toMatchObject({ ok: true, count: 3 });
    expect(fs.readFileSync(f, "utf8")).toBe("z $&B z c z");
  });

  it("walls: another Bot's home and the host's private folder, through a link, `..` or a folder link, for read and write", async () => {
    const t = tree();
    const run = impl(t);
    const refused = (r: BotFileAnswer) => !r.ok && /off limits|another Bot's/.test(r.error);
    const attempts: BotFileRequest[] = [
      { op: "read", path: path.join(t.other, "secret.txt") },
      { op: "read", path: path.join(t.me, "sneaky") },
      { op: "read", path: path.join(t.me, "..", "bot-bbbbbbbbbbbb", "secret.txt") },
      { op: "read", path: path.join(t.me, "hostdir", "vault.key") },
      { op: "read", path: path.join(t.host, "vault.key") },
      { op: "read", path: path.join(t.ws, "into-other", "secret.txt") },
      { op: "write", path: path.join(t.other, "planted.txt"), content: "x", expect: null },
      { op: "write", path: path.join(t.me, "hostdir", "planted"), content: "x", expect: null },
      { op: "write", path: path.join(t.ws, "into-other", "planted"), content: "x", expect: null },
      { op: "edit", path: path.join(t.me, "sneaky"), old: "OTHER", new: "MINE", all: false, expect: null },
      { op: "read", path: "/proc/self/environ" },
    ];
    for (const a of attempts) expect(refused(await run("b", a)), JSON.stringify(a)).toBe(true);
    expect(fs.existsSync(path.join(t.other, "planted.txt"))).toBe(false);
    expect(fs.existsSync(path.join(t.host, "planted"))).toBe(false);
    expect(fs.readFileSync(path.join(t.other, "secret.txt"), "utf8")).toBe("OTHER-BOT-SECRET\n");
    // the shared workspace is fine
    expect(await run("b", { op: "write", path: path.join(t.ws, "ok.txt"), content: "y", expect: null })).toMatchObject({ ok: true });
  });
});

describe("the Read/Write/Edit tools", () => {
  it("remember what the Bot read, so Write and Edit follow the CLI's read-first rule", async () => {
    const t = tree();
    const tools = createFileTools({ botId: "b", files: local(t), seen: new Map() });
    const [read, write, edit] = tools as [typeof tools[0], typeof tools[0], typeof tools[0]];
    const f = path.join(t.me, "notes.txt");
    expect((await write.handler({ file_path: f, content: "x" })).text).toContain("has not been read yet");
    expect((await read.handler({ file_path: f })).text).toBe("     1\tone\n     2\ttwo\n     3\tthree");
    expect((await edit.handler({ file_path: f, old_string: "two", new_string: "2" })).text).toBe(`The file ${f} has been updated.`);
    expect((await edit.handler({ file_path: f, old_string: "three", new_string: "3" })).text).toBe(`The file ${f} has been updated.`); // its own edit counts as seen
    expect(fs.readFileSync(f, "utf8")).toBe("one\n2\n3\n");
    expect((await write.handler({ file_path: path.join(t.me, "n.md"), content: "# hi" })).text).toBe(`File created successfully at: ${path.join(t.me, "n.md")}`);
    const img = await read.handler({ file_path: path.join(t.me, "pic.png") });
    expect(img.images).toEqual([{ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"), mimeType: "image/png" }]);
  });
});

describe("box/files/bot-file (the root helper's account checks, run through the FakeUsers shims)", () => {
  it("runs the worker only for bothost, for a real Bot account whose GECOS names that Bot", () => {
    const f = new FakeUsers();
    cleanups.push(() => f.cleanup());
    f.install("bot-file-worker.py");
    const A = "bot-a1";
    const B = "bot-b2";
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    expect(f.run("bot-user", ["ensure", B]).status).toBe(0);
    const ua = botUserName(A);
    const home = f.p("home/bots", ua);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "hi.txt"), "hello\n");
    const req = JSON.stringify({ op: "read", path: "/home/bots/" + ua + "/hi.txt" });
    // (FakeUsers rewrites /home/bots in the helper, not in the request: give it the real path)
    const real = JSON.stringify({ op: "read", path: path.join(home, "hi.txt") });
    const ok = f.run("bot-file", [ua, A], {}, real);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, text: "     1\thello" });
    expect(f.calls().some((c) => c.cmd === "setpriv" && c.args.some((x) => x.startsWith("--reuid=")))).toBe(true);
    expect(f.run("bot-file", [ua, A], { SUDO_USER: "box" }, req).status).toBe(126);
    expect(f.run("bot-file", [ua, B], {}, req).status).toBe(126); // A's account under B's id
    expect(f.run("bot-file", ["box", A], {}, req).status).toBe(126);
    expect(f.run("bot-file", [ua, "../x"], {}, req).status).toBe(126);
  });
});
