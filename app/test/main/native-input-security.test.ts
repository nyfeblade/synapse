import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: {}, dialog: {}, BrowserWindow: class {} }));
const { installNativeIpc } = await import("../../src/main/native");
const { registerFiles, allowDroppedPath } = await import("../../src/main/native/files");
const { registerDictation, validLocale } = await import("../../src/main/native/dictation");

const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>>();
installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => null);
const call = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });

describe("readDroppedFile only accepts paths from a real drop or dialog (P5 review minor)", () => {
  it("refuses an arbitrary path; accepts one registered by a real drop", async () => {
    registerFiles(() => null);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drop-")), "a.txt");
    fs.writeFileSync(f, "hello");
    const denied = await call("readDroppedFile", { path: f, maxBytes: 1000 });
    expect(denied.ok).toBe(false);
    expect(await call("readDroppedFile", { path: "/etc/passwd", maxBytes: 1_000_000 })).toMatchObject({ ok: false });
    allowDroppedPath(f);
    expect(await call("readDroppedFile", { path: f, maxBytes: 1000 })).toMatchObject({ ok: true, result: { name: "a.txt", bytesBase64: Buffer.from("hello").toString("base64") } });
  });
});

describe("dictation validates the locale (P5 review minor)", () => {
  it("accepts BCP-47-ish locales and refuses anything else before spawning", async () => {
    expect(validLocale("en-US")).toBe(true);
    expect(validLocale("zh_Hans_CN")).toBe(true);
    expect(validLocale("--output=/tmp/x")).toBe(false);
    expect(validLocale("en US")).toBe(false);
    const spawnFn = vi.fn(() => { const c = new EventEmitter() as never as { stdin: unknown; stdout: EventEmitter }; c.stdin = { end() {}, write() {} }; c.stdout = new EventEmitter(); return c; });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never });
    expect(await call("dictation.start", { locale: "--help" })).toMatchObject({ ok: false });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(await call("dictation.start", { locale: "en-GB" })).toMatchObject({ ok: true });
    expect(spawnFn).toHaveBeenCalledWith("bots-dictation", ["--locale", "en-GB"], expect.anything());
  });
});
