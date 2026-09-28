// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyComputerEvent, initialComputer, useComputer } from "../../src/renderer/computer-state";

describe("computer state reducer", () => {
  it("tracks activity and the latest cursor per Bot from computer-action events", () => {
    const s = applyComputerEvent(initialComputer(), { channel: "computer-action", payload: { botId: "b", index: 2, kind: "click", x: 100, y: 50, at: 1, source: "browser" } }, 5000);
    expect(s.activity.b).toBe(5000);
    expect(s.cursor.b).toEqual({ x: 100, y: 50, kind: "click", at: 5000 });
    const t = applyComputerEvent(s, { channel: "computer-action", payload: { botId: "b", index: 2, kind: "type", x: null, y: null, at: 2, source: "computer" } }, 6000);
    expect(t.cursor.b).toEqual({ x: 100, y: 50, kind: "type", at: 6000 });
  });
  it("stores displays, disk pressure, box status and async tasks", () => {
    let s = applyComputerEvent(initialComputer(), { channel: "displays", payload: { displays: [{ botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 }], waiting: [] } }, 0);
    s = applyComputerEvent(s, { channel: "box-disk-pressure", payload: { level: "soft", freeBytes: 1, totalBytes: 2, freePct: 50, checkedAt: 1, diskSaverBotId: null } }, 0);
    s = applyComputerEvent(s, { channel: "async-tasks", payload: { botId: "b", tasks: [] } }, 0);
    expect(s.displays.b?.index).toBe(2);
    expect(s.disk?.level).toBe("soft");
    expect(s.tasks.b).toEqual([]);
  });

  it("stores the waiting-for-a-screen list from the displays channel (controller ruling 1)", () => {
    const s = applyComputerEvent(initialComputer(), { channel: "displays", payload: { displays: [], waiting: ["b"] } }, 0);
    expect(s.waiting).toEqual(["b"]);
  });
});

describe("openComputer asks the host for a screen (bug 48 / #3)", () => {
  it("invokes ensureDisplay for that Bot and records the assigned screen", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    const display = { botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 };
    (window as unknown as { synapse: unknown }).synapse = {
      call: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        if (cmd === "ensureDisplay") return { ok: true, result: { display } };
        return { ok: true, result: {} };
      },
    };
    useComputer.setState({ ...initialComputer(), displaysLoad: "ready" });
    useComputer.getState().openComputer("b");
    expect(useComputer.getState().open).toEqual({ botId: "b" });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({ cmd: "ensureDisplay", args: { id: "b" } });
    expect(useComputer.getState().displays.b).toEqual(display);
  });

  it("does not invent a display when every seat is taken — Waiting for a screen stays the answer", async () => {
    (window as unknown as { synapse: unknown }).synapse = {
      call: async () => ({ ok: false, error: { code: "GATEWAY_ERROR", message: "All of the shared computer's desktop screens are taken. Try again once another Bot is done, or do this without a screen." } }),
    };
    useComputer.setState({ ...initialComputer(), displaysLoad: "ready", waiting: [] });
    useComputer.getState().openComputer("d");
    await new Promise((r) => setTimeout(r, 0));
    expect(useComputer.getState().displays.d).toBeUndefined();
  });
});
