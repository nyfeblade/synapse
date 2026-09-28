import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase5SettingsModule } from "../../phase5/settings-module";
import { HostSettingsStore } from "../../store/host-settings";

describe("Phase 5 settings module", () => {
  it("stores memory mode and the security-key toggle; the key feature stays unavailable (D15-B)", async () => {
    const published: unknown[] = [];
    const settings = new HostSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5s-")), "s.json"));
    const m = createPhase5SettingsModule({ settings, hub: { publish: (e: unknown) => published.push(e) } } as never);
    expect(await m.handlers.getPhase5Settings!({})).toEqual({ memoryMode: "standard", useHardwareSecurityKeys: false, hasSeenOnboarding: false, advancedEnabled: false });
    expect((await m.handlers.setMemoryMode!({ mode: "dreaming" })).memoryMode).toBe("dreaming");
    expect((await m.handlers.setHardwareSecurityKeys!({ enabled: true })).useHardwareSecurityKeys).toBe(true);
    expect(published).toHaveLength(2);
    await expect(Promise.resolve().then(() => m.handlers.setMemoryMode!({ mode: "bogus" as never }))).rejects.toThrow(/memory mode/);
  });
});
