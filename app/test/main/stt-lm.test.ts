import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lmKey, lmReady, makeLmCache } from "../../src/main/native/stt-lm";

// Bug 162: the compiled custom language model of the user's own vocabulary. It is built in the
// background and cached — a dictation session must never wait for one, and must work without one.

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "stt-lm-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Pretend the helper compiled a model into `dir`. */
function fakeBuilt(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model.lm"), "lm");
  fs.writeFileSync(path.join(dir, "model.vocab"), "vocab");
}

describe("lmKey", () => {
  it("is the same whatever order the names arrive in", () => {
    expect(lmKey(["Nova", "Atlas"], "en-US")).toBe(lmKey(["Atlas", "Nova"], "en-US"));
  });

  it("ignores case and surrounding space", () => {
    expect(lmKey([" nova "], "en-US")).toBe(lmKey(["Nova"], "en-US"));
  });

  it("changes when a name is added", () => {
    expect(lmKey(["Nova"], "en-US")).not.toBe(lmKey(["Nova", "Atlas"], "en-US"));
  });

  it("changes with the language", () => {
    expect(lmKey(["Nova"], "en-US")).not.toBe(lmKey(["Nova"], "fr-FR"));
  });
});

describe("lmReady", () => {
  it("needs both halves of the model", () => {
    const dir = path.join(root, "a");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "model.lm"), "lm");
    expect(lmReady(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "model.vocab"), "vocab");
    expect(lmReady(dir)).toBe(true);
  });

  it("rejects an empty file as half-written", () => {
    const dir = path.join(root, "b");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "model.lm"), "");
    fs.writeFileSync(path.join(dir, "model.vocab"), "vocab");
    expect(lmReady(dir)).toBe(false);
  });

  it("says no about a directory that is not there", () => {
    expect(lmReady(path.join(root, "nope"))).toBe(false);
  });
});

function setup(exec: (args: string[], done: (err: unknown) => void) => void) {
  const calls: string[][] = [];
  const execFileFn = ((_bin: string, args: string[], _opts: unknown, cb: (e: unknown) => void) => {
    calls.push(args);
    exec(args, cb);
  }) as unknown as typeof import("node:child_process").execFile;
  const log = vi.fn();
  const cache = makeLmCache({
    binary: "bots-dictation",
    root,
    execFileFn,
    writeContext: (strings, dir, id) => {
      const f = path.join(dir, `ctx-${id}.json`);
      fs.writeFileSync(f, JSON.stringify({ strings }));
      return f;
    },
    log,
  });
  return { cache, calls, log };
}

/** The value of `--lm-dir` in a recorded build command. */
const lmDirArg = (args: string[]) => args[args.indexOf("--lm-dir") + 1]!;

describe("makeLmCache", () => {
  it("does not make a session wait: the first ask starts a build and returns nothing", () => {
    const h = setup(() => {});
    expect(h.cache.dirFor(["Nova"], "en-US")).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it("hands back the model once the build has finished", () => {
    const h = setup((args, done) => { fakeBuilt(lmDirArg(args)); done(null); });
    expect(h.cache.dirFor(["Nova"], "en-US")).toBeNull(); // the build ran during this call
    expect(h.cache.dirFor(["Nova"], "en-US")).toBe(path.join(root, lmKey(["Nova"], "en-US")));
  });

  it("builds once for a vocabulary and reuses it", () => {
    const h = setup((args, done) => { fakeBuilt(lmDirArg(args)); done(null); });
    h.cache.dirFor(["Nova", "Atlas"], "en-US");
    h.cache.dirFor(["Atlas", "Nova"], "en-US"); // the same names, the other way round
    h.cache.dirFor(["Nova", "Atlas"], "en-US");
    expect(h.calls).toHaveLength(1);
  });

  it("builds again when the names change", () => {
    const h = setup((args, done) => { fakeBuilt(lmDirArg(args)); done(null); });
    h.cache.dirFor(["Nova"], "en-US");
    h.cache.dirFor(["Nova", "Atlas"], "en-US");
    expect(h.calls).toHaveLength(2);
  });

  it("passes the names to the helper as a context file, and tidies it up after", () => {
    let seen: string[] = [];
    let ctx = "";
    const h = setup((args, done) => {
      ctx = args[args.indexOf("--context-file") + 1]!;
      seen = JSON.parse(fs.readFileSync(ctx, "utf8")).strings;
      fakeBuilt(lmDirArg(args));
      done(null);
    });
    h.cache.dirFor(["Nova", "Disk Saver"], "en-US");
    expect(seen).toEqual(["Nova", "Disk Saver"]);
    expect(fs.existsSync(ctx)).toBe(false);
  });

  it("passes the session's language through", () => {
    const h = setup((args, done) => { fakeBuilt(lmDirArg(args)); done(null); });
    h.cache.dirFor(["Nova"], "fr-FR");
    expect(h.calls[0]!.slice(-2)).toEqual(["--locale", "fr-FR"]);
  });

  it("runs one build at a time", () => {
    const h = setup(() => {}); // never finishes
    h.cache.dirFor(["Nova"], "en-US");
    h.cache.dirFor(["Atlas"], "en-US");
    expect(h.calls).toHaveLength(1);
  });

  it("gives up quietly on a vocabulary whose build failed, and never retries it", () => {
    const h = setup((_args, done) => done(new Error("boom")));
    expect(h.cache.dirFor(["Nova"], "en-US")).toBeNull();
    expect(h.cache.dirFor(["Nova"], "en-US")).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("failed"));
  });

  it("treats a build that wrote nothing as a failure and clears up", () => {
    const h = setup((_args, done) => done(null)); // exits 0 but writes no model
    expect(h.cache.dirFor(["Nova"], "en-US")).toBeNull();
    expect(fs.existsSync(path.join(root, lmKey(["Nova"], "en-US")))).toBe(false);
  });

  it("asks for nothing when there are no names", () => {
    const h = setup(() => {});
    expect(h.cache.dirFor([], "en-US")).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("keeps only the most recent models", () => {
    const h = setup((args, done) => { fakeBuilt(lmDirArg(args)); done(null); });
    for (const names of [["A1"], ["B2"], ["C3"], ["D4"], ["E5"]]) {
      h.cache.dirFor(names, "en-US");
      h.cache.dirFor(names, "en-US"); // second ask marks it ready and prunes
    }
    expect(fs.readdirSync(root).length).toBeLessThanOrEqual(3);
  });
});
