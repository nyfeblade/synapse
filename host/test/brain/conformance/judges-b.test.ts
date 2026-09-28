import { describe, expect, it } from "vitest";
import { judgeCt07, judgeCt08, judgeCt09, judgeCt10, judgeCt11, judgeCt12 } from "../../../brain/conformance/checks/group-b";

describe("judges CT-07…CT-12", () => {
  it("CT-07", () => {
    expect(judgeCt07({ compactBoundary: true, hookInstructions: "… RESTORE-END" }).status).toBe("pass");
    expect(judgeCt07({ compactBoundary: false, hookInstructions: null })).toMatchObject({ flags: { compactPath: "auto-only" } });
  });
  it("CT-08", () => {
    expect(judgeCt08({ appendChars: 8000, cacheReads: [1700, 1800] }).status).toBe("pass");
    expect(judgeCt08({ appendChars: 8000, cacheReads: [1700, 100] })).toMatchObject({ flags: { promptCacheOk: false } });
  });
  it("CT-09", () => {
    expect(judgeCt09({ tools: ["StructuredOutput"] }).status).toBe("pass");
    expect(judgeCt09({ tools: ["StructuredOutput", "Bash"] })).toMatchObject({ flags: { extraDisallowed: ["Bash"] } });
  });
  it("CT-10", () => {
    expect(judgeCt10({ cold: { ms: 1000, spawnedBeforePush: false, answered: true }, prewarmed: { ms: 50, spawnedBeforePush: true, answered: true } }).status).toBe("pass");
    expect(judgeCt10({ cold: { ms: 1000, spawnedBeforePush: false, answered: true }, prewarmed: { ms: 1000, spawnedBeforePush: false, answered: true } })).toMatchObject({ flags: { prewarm: false } });
  });
  it("CT-11", () => {
    expect(judgeCt11("setpriv", { output: "1001\ncat: /home/box/.host/gateway.json: Permission denied", boxUid: 1001 })).toBe(true);
    expect(judgeCt11("setpriv", { output: "998\n{\"token\":\"x\"}", boxUid: 1001 })).toBe(false);
    expect(judgeCt11("bwrap", { output: "998\ncat: /home/box/.host/gateway.json: No such file or directory", boxUid: 1001 })).toBe(true);
    expect(judgeCt11("same-uid", { output: "998\n{}", boxUid: 1001 })).toBe(true);
  });
  it("CT-12", () => {
    expect(judgeCt12({ connectorTool: null, goneWithSettings: false, goneWithDisallowed: false }).status).toBe("n/a");
    expect(judgeCt12({ connectorTool: "t", goneWithSettings: true, goneWithDisallowed: true }).status).toBe("pass");
    expect(judgeCt12({ connectorTool: "t", goneWithSettings: false, goneWithDisallowed: true }).flags).toEqual({ connectorToolDisable: "disallowedTools" });
    expect(judgeCt12({ connectorTool: "t", goneWithSettings: false, goneWithDisallowed: false }).flags).toEqual({ connectorToolDisable: "hook" });
  });
});
