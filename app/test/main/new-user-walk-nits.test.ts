import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, shell: {}, dialog: {}, net: {} }));
import { macLabel } from "../../src/coordinator/local-exec/policy";
import { defaultReleaseDir } from "../../src/main/native/updater";

describe("new-user walk nits (Mac side)", () => {
  it("30: the Mac's name drops its network suffix", () => {
    expect(macLabel("Studio-MBP.localdomain")).toBe("Studio-MBP");
    expect(macLabel("Studio-MBP.local")).toBe("Studio-MBP");
    expect(macLabel("studio")).toBe("studio");
  });

  it("32: under SYNAPSE_APP_DATA the default release folder is inside it", () => {
    expect(defaultReleaseDir({ SYNAPSE_APP_DATA: "/tmp/walk" })).toBe("/tmp/walk/Synapse/releases");
    expect(defaultReleaseDir({})).toMatch(/Library\/Application Support\/Synapse\/releases$/);
  });
});
