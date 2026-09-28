// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const ipcHandlers = new Map<string, (e: unknown, ...a: unknown[]) => void>();
let exposed: Record<string, (...a: never[]) => unknown> = {};
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_n: string, api: Record<string, (...a: never[]) => unknown>) => { exposed = api; } },
  ipcRenderer: { on: (ch: string, cb: (e: unknown, ...a: unknown[]) => void) => ipcHandlers.set(ch, cb), send: () => {}, invoke: async () => ({}) },
  webUtils: { getPathForFile: () => "" },
}));

class FakePort {
  onmessage: ((m: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  start(): void {}
  postMessage(m: unknown): void { this.sent.push(m); }
}

describe("the renderer bridge survives a coordinator restart (concurrency)", () => {
  it("settles calls left in flight when main hands it a fresh port", async () => {
    await import("../../src/preload/index");
    const first = new FakePort();
    ipcHandlers.get("coordinator-port")!({ ports: [first] });
    const inFlight = (exposed.call as (c: string, a: unknown) => Promise<unknown>)("listAgents", {});
    expect(first.sent).toHaveLength(1);
    // The coordinator died and main re-forked it: a brand new MessagePort arrives.
    const second = new FakePort();
    ipcHandlers.get("coordinator-port")!({ ports: [second] });
    await expect(Promise.race([inFlight, new Promise((r) => setTimeout(() => r("hung"), 200))]))
      .resolves.toMatchObject({ ok: false, error: { code: "NOT_CONNECTED" } });
  });
});
