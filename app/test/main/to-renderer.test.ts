import { describe, expect, it, vi } from "vitest";
import { canReachRenderer, postToRenderer, sendToRenderer } from "../../src/main/to-renderer";

/**
 * A BrowserWindow can be alive while its RENDER FRAME is gone — during a reload, a navigation, or a
 * renderer crash. `win.isDestroyed()` is false throughout all three, so it is a PROXY for "this can
 * receive a message", not the property itself.
 *
 * The crash this exists to stop, seen by the user at 06:57 with an Electron fatal dialog:
 *
 *   Error: Render frame was disposed before WebFrameMain could be accessed
 *     at WebFrameMain.postMessage / WebContents.postMessage
 *     at wirePort (app/dist/main.cjs:2655)
 *     at Object.onRespawn (…:2645)  at CoordinatorHost.restart (…:1445)
 *
 * The coordinator died, supervision re-forked it 500ms later, and `onRespawn` posted a MessagePort
 * into a frame that had been disposed. `webContents.send` only warns on a dead frame; `postMessage`
 * with transferables THROWS, and it threw on the main process's own timer callback, where nothing
 * was catching — so it reached Electron's uncaught-exception dialog.
 *
 * Note `mainFrame` is itself the getter that throws, so it has to be reached for inside a try.
 */
const liveWin = () => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, get mainFrame() { return {}; }, send: vi.fn(), postMessage: vi.fn() },
});
const disposedFrameWin = () => ({
  isDestroyed: () => false, // the WINDOW is fine — this is the whole point
  webContents: {
    isDestroyed: () => false,
    get mainFrame(): unknown { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); },
    send: vi.fn(),
    postMessage: vi.fn(),
  },
});

describe("reaching the renderer from the main process", () => {
  it("says yes for a live window", () => {
    expect(canReachRenderer(liveWin() as never)).toBe(true);
  });

  it("says NO when the window lives but its render frame is disposed", () => {
    // The exact state the crash happened in. A `!win.isDestroyed()` guard returns true here.
    expect(canReachRenderer(disposedFrameWin() as never)).toBe(false);
  });

  it("says YES when there is simply no mainFrame to read, because only a throw means disposed", () => {
    // The first draft returned false here and dropped real messages in seven suites whose window
    // objects expose no frame. The failure this guard exists for is the getter THROWING; absence is
    // not that failure, and guessing otherwise silently breaks working code.
    const noFrame = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn(), postMessage: vi.fn() } };
    expect(canReachRenderer(noFrame as never)).toBe(true);
  });

  it("says no for a destroyed window, a destroyed webContents, and null", () => {
    expect(canReachRenderer(null)).toBe(false);
    expect(canReachRenderer({ isDestroyed: () => true, webContents: {} } as never)).toBe(false);
    expect(canReachRenderer({ isDestroyed: () => false, webContents: { isDestroyed: () => true } } as never)).toBe(false);
  });

  it("postToRenderer does not throw on a disposed frame, and does not post", () => {
    const w = disposedFrameWin();
    expect(() => postToRenderer(w as never, "coordinator-port", null, [{} as never])).not.toThrow();
    expect(w.webContents.postMessage).not.toHaveBeenCalled();
  });

  it("postToRenderer posts when the frame is live", () => {
    const w = liveWin();
    postToRenderer(w as never, "coordinator-port", null, []);
    expect(w.webContents.postMessage).toHaveBeenCalledWith("coordinator-port", null, []);
  });

  it("sendToRenderer is guarded the same way", () => {
    const dead = disposedFrameWin();
    expect(() => sendToRenderer(dead as never, "box-lifecycle", { kind: "x" })).not.toThrow();
    expect(dead.webContents.send).not.toHaveBeenCalled();
    const live = liveWin();
    sendToRenderer(live as never, "box-lifecycle", { kind: "x" });
    expect(live.webContents.send).toHaveBeenCalledWith("box-lifecycle", { kind: "x" });
  });
});

describe("no main-process file posts to the renderer unguarded", () => {
  it("every webContents.send / postMessage in src/main goes through this module", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "main");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "to-renderer.ts");
    // Smoke: a zero from this walk would make the assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        if (/webContents\s*\.\s*(send|postMessage)\s*\(/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, `use sendToRenderer/postToRenderer — a raw post throws on a disposed frame:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
