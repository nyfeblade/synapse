import { describe, expect, it } from "vitest";
import { resolveUnpacked } from "../../src/main/resolve-unpacked";

describe("resolveUnpacked", () => {
  it("rewrites a packaged app.asar path to its app.asar.unpacked sibling", () => {
    expect(resolveUnpacked("/Applications/Synapse.app/Contents/Resources/app.asar/dist/native/bots-dictation")).toBe(
      "/Applications/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-dictation",
    );
  });

  it("leaves a dev path (no app.asar segment) unchanged", () => {
    const p = "/Users/x/bots/app/dist/native/bots-dictation";
    expect(resolveUnpacked(p)).toBe(p);
  });

  it("does not rewrite a path where \"app.asar\" is only part of a longer segment", () => {
    const p = "/Users/x/app.asarbak/dist/native/bots-dictation";
    expect(resolveUnpacked(p)).toBe(p);
  });
});
