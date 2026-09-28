import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.fn(async () => {});
const showSaveDialog = vi.fn(async () => ({ canceled: true }));
const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
vi.mock("electron", () => ({ shell: { openExternal, showItemInFolder: vi.fn() }, dialog: { showSaveDialog, showOpenDialog }, BrowserWindow: class {} }));
const { installNativeIpc, registerNative: _r } = await import("../../src/main/native");
const { registerExternal, guardNavigation } = await import("../../src/main/native/external");
const { registerFiles } = await import("../../src/main/native/files");

const handlers = new Map<string, (e: unknown, m: unknown) => Promise<unknown>>();
installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => Promise<unknown>) => void handlers.set(ch, fn) } as never, () => null);
registerExternal();
registerFiles(() => null);
void _r;
const call = async (name: string, args: unknown) => {
  const fn = [...handlers.values()][0]!;
  return fn({}, { name, args });
};

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); openExternal.mockClear(); showSaveDialog.mockClear(); showOpenDialog.mockClear(); });

describe("native FUZZ/E2E behavior", () => {
  it("FUZZ openExternal never opens a browser and completes the fake OAuth loopback itself", async () => {
    process.env.FUZZ = "1";
    const fetchFn = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchFn);
    const r = await call("openExternal", { url: "https://example.com/authorize?redirect_uri=x&state=s%201" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:47823/mcp/oauth/callback?code=fuzz&state=s%201");
    expect(JSON.stringify(r)).toContain("\"opened\":false");
    await call("openExternal", { url: "https://linear.app/docs" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("outside FUZZ openExternal still opens https links", async () => {
    delete process.env.FUZZ;
    await call("openExternal", { url: "https://linear.app/docs" });
    expect(openExternal).toHaveBeenCalledWith("https://linear.app/docs");
  });

  it("E2E_SAVE_DIR saves without a dialog; E2E_OPEN_FILE opens without a dialog", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-save-"));
    process.env.E2E_SAVE_DIR = dir;
    const r = await call("saveFile", { defaultName: "scout.botpack", bytesBase64: Buffer.from("pack").toString("base64") });
    expect(JSON.stringify(r)).toContain(path.join(dir, "scout.botpack"));
    expect(fs.readFileSync(path.join(dir, "scout.botpack"), "utf8")).toBe("pack");
    const src = path.join(dir, "in.botpack");
    fs.writeFileSync(src, "hello");
    process.env.E2E_OPEN_FILE = src;
    const o = await call("openFile", {});
    expect(JSON.stringify(o)).toContain(Buffer.from("hello").toString("base64"));
    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});

describe("Added 11:10: the main window's link-open guard", () => {
  const fakeContents = () => {
    const h: { open?: (d: { url: string }) => { action: string }; nav?: (e: { preventDefault(): void }, url: string) => void } = {};
    const wc = {
      setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => { h.open = fn; },
      on: (ev: string, fn: (e: { preventDefault(): void }, url: string) => void) => { if (ev === "will-navigate") h.nav = fn; },
    };
    return { wc, h };
  };
  const APP = "file:///Applications/Bots.app/Contents/Resources/app/dist/renderer/index.html";

  it("FUZZ: a target=_blank link opens no window and calls no shell.openExternal", async () => {
    process.env.FUZZ = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const { wc, h } = fakeContents();
    guardNavigation(wc as never, APP);
    expect(h.open!({ url: "https://claude.ai/oauth/authorize?fake=1" })).toEqual({ action: "deny" });
    await new Promise((r) => setTimeout(r, 0));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("outside FUZZ: https goes through the guarded openExternal; anything else is dropped; always deny", async () => {
    delete process.env.FUZZ;
    const { wc, h } = fakeContents();
    guardNavigation(wc as never, APP);
    expect(h.open!({ url: "https://linear.app/docs" })).toEqual({ action: "deny" });
    expect(h.open!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(h.open!({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    await new Promise((r) => setTimeout(r, 0));
    expect(openExternal.mock.calls).toEqual([["https://linear.app/docs"]]);
  });

  it("will-navigate blocks any navigation away from the app's own page", () => {
    delete process.env.FUZZ;
    const { wc, h } = fakeContents();
    guardNavigation(wc as never, APP);
    const nav = (url: string) => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; h.nav!(e, url); return e.prevented; };
    expect(nav("https://evil.example/phish")).toBe(true);
    expect(nav("file:///tmp/other.html")).toBe(true);
    expect(nav(`${APP}#/bots/1`)).toBe(false);
  });
});
