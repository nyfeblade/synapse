import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helperArgs, registerDictation, writeContextFile } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Bug 162: the session tells the recognizer which names to expect. Contextual strings took word
// error rate from 16.8% to 6.9% and name accuracy from 25/54 to 48/54 on a fixed set of samples,
// so getting the list to the helper — and only the list — is worth testing properly.

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-ctx-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("writeContextFile", () => {
  it("writes the strings where the helper will look", () => {
    const file = writeContextFile(["Nova", "Disk Saver"], dir, "s1")!;
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ strings: ["Nova", "Disk Saver"] });
  });

  it("writes nothing at all when there is nothing to bias on", () => {
    expect(writeContextFile([], dir, "s1")).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps the file to the user", () => {
    const file = writeContextFile(["Nova"], dir, "s1")!;
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("gives each session its own file", () => {
    expect(writeContextFile(["Nova"], dir, "s1")).not.toBe(writeContextFile(["Nova"], dir, "s2"));
  });

  it("says nothing rather than throwing when the directory is gone", () => {
    expect(writeContextFile(["Nova"], path.join(dir, "missing"), "s1")).toBeNull();
  });
});

describe("helperArgs with a context file", () => {
  it("passes the file, not the names, so argv cannot overflow", () => {
    expect(helperArgs("dictation", undefined, undefined, null, "/tmp/c.json")).toEqual(["--context-file", "/tmp/c.json"]);
  });

  it("still spawns bare dictation when there is no context", () => {
    expect(helperArgs("dictation", undefined)).toEqual([]);
  });

  it("puts the context file after the locale in call mode", () => {
    const args = helperArgs("call", "en-US", undefined, null, "/tmp/c.json");
    expect(args.slice(-4)).toEqual(["--locale", "en-US", "--context-file", "/tmp/c.json"]);
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

function setup(tmpDir: string) {
  const win = { isDestroyed: () => false, webContents: { send: () => {} } };
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
  const children: ReturnType<typeof makeFakeChild>[] = [];
  const spawnFn = vi.fn((_bin: string, _args: string[]) => {
    const c = makeFakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  });
  registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, tmpDir, log: vi.fn() });
  return { children, spawnFn, dispatch: (name: string, args: unknown) => handlers.get("native")!({}, { name, args }) };
}

/** The `--context-file` argument's value, or null when the session was spawned without one. */
function contextFileOf(args: string[]): string | null {
  const i = args.indexOf("--context-file");
  return i >= 0 ? args[i + 1]! : null;
}

describe("registerDictation contextual strings (bug 162)", () => {
  it("sends the renderer's names to the helper as a file", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1", context: ["Nova", "Disk Saver"] });
    const file = contextFileOf(h.spawnFn.mock.calls[0]![1]);
    expect(JSON.parse(fs.readFileSync(file!, "utf8")).strings).toEqual(["Nova", "Disk Saver"]);
  });

  it("tidies and caps what the renderer sent before it reaches argv", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1", context: ["Nova", "nova", "  ", "x", 7, "Atlas"] });
    const file = contextFileOf(h.spawnFn.mock.calls[0]![1]);
    expect(JSON.parse(fs.readFileSync(file!, "utf8")).strings).toEqual(["Nova", "Atlas"]);
  });

  it("spawns without a context file when the renderer sent none", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1" });
    expect(contextFileOf(h.spawnFn.mock.calls[0]![1])).toBeNull();
  });

  it("ignores a context that is not a list", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1", context: "Nova" });
    expect(contextFileOf(h.spawnFn.mock.calls[0]![1])).toBeNull();
  });

  it("deletes the file once the helper has read it and gone", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1", context: ["Nova"] });
    const file = contextFileOf(h.spawnFn.mock.calls[0]![1])!;
    expect(fs.existsSync(file)).toBe(true);
    h.children[0]!.emit("close", 0, null);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no file behind when a session is superseded", async () => {
    const h = setup(dir);
    await h.dispatch("dictation.start", { sessionId: "s1", context: ["Nova"] });
    await h.dispatch("dictation.start", { sessionId: "s2", context: ["Atlas"] });
    h.children[0]!.emit("close", 0, null);
    h.children[1]!.emit("close", 0, null);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
