import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn(async () => {}) }, dialog: {}, BrowserWindow: class {} }));
const { installNativeIpc, registerNative, emitNative } = await import("../../src/main/native");
const { isAllowedExternal } = await import("../../src/main/native/external");

describe("native IPC registry", () => {
  it("routes invoke to the registered handler and wraps errors", async () => {
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => null);
    registerNative("echo", async (a: { x: number }) => ({ y: a.x + 1 }));
    registerNative("fail", () => { throw new Error("nope"); });
    const h = handlers.get("native")!;
    await expect(h({}, { name: "echo", args: { x: 1 } })).resolves.toEqual({ ok: true, result: { y: 2 } });
    await expect(h({}, { name: "fail", args: {} })).resolves.toEqual({ ok: false, error: { code: "NATIVE_ERROR", message: "nope" } });
    await expect(h({}, { name: "missing", args: {} })).resolves.toMatchObject({ ok: false, error: { code: "UNKNOWN_NATIVE" } });
  });

  it("emitNative is a no-op without a window", () => {
    expect(() => emitNative("x", 1)).not.toThrow();
  });

  it("openExternal allows https and blocks everything else", () => {
    expect(isAllowedExternal("https://claude.ai/settings/usage")).toBe(true);
    expect(isAllowedExternal("http://example.com")).toBe(false);
    expect(isAllowedExternal("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternal("javascript:alert(1)")).toBe(false);
  });
});
