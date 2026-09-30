import { describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { tmpConfig } from "../helpers";

// 0.1.4 tamper check: the app tells the host to hold Bot turns while the box's Local network state differs from the
// owner's choice. Turns are refused with a tray until the app says it matches again.
describe("setNetworkPause (the app's Local network tamper check)", () => {
  it("pauses Bot turns with a tray, and lifts both when the app says it matches", async () => {
    const { createHostApp } = await import("../../app");
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    try {
      const blocked = () => (app.services.runner as unknown as { d: { turnBlocked(): Promise<string | null> } }).d.turnBlocked();
      expect(await blocked()).toBeNull();
      expect(await app.handlers.setNetworkPause!({ on: true })).toEqual({ on: true });
      expect(await blocked()).toBe(STR5.localNetworkPaused);
      expect(app.services.trays.list().filter((t) => t.dedupeKey === "local-network").map((t) => t.title)).toEqual([STR5.localNetworkPaused]);
      expect(await app.handlers.setNetworkPause!({ on: false })).toEqual({ on: false });
      expect(await blocked()).toBeNull();
      expect(app.services.trays.list().some((t) => t.dedupeKey === "local-network")).toBe(false);
    } finally { await app.close(); }
  });
});
