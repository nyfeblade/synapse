import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../../brain/conformance/checks/index";
import { judgeCt13, judgeCt14, judgeCt15, judgeCt16, judgeCt17, judgeCt18, judgeCt19, synthesizeSession } from "../../../brain/conformance/checks/group-c";

describe("judges CT-13…CT-19", () => {
  it("CT-13", () => {
    expect(judgeCt13({ texts: ["ONE", "TWO", "", "FOUR"], spawns: 1 }).status).toBe("pass");
    expect(judgeCt13({ texts: ["ONE"], spawns: 1 })).toMatchObject({ flags: { warmSessions: false } });
  });
  it("CT-14", () => {
    expect(judgeCt14({ sizes: [{ bytes: 20e6, ms: 900 }, { bytes: 64e6, ms: 4000 }] }).status).toBe("pass");
    expect(judgeCt14({ sizes: [{ bytes: 20e6, ms: 2000 }, { bytes: 64e6, ms: 9000 }] }).flags).toEqual({ rolloverBytes: 20e6 });
    expect(judgeCt14({ sizes: [{ bytes: 20e6, ms: 9000 }, { bytes: 64e6, ms: 9000 }] }).flags).toEqual({ rolloverBytes: 8 * 1024 * 1024 });
  });
  it("CT-15 … CT-19", () => {
    expect(judgeCt15({ before: "a", after: "a" }).status).toBe("pass");
    expect(judgeCt15({ before: "a", after: "b" }).flags).toEqual({ forkPath: "fresh" });
    expect(judgeCt16({ canUseToolOk: true, hookOk: false }).status).toBe("pass");
    expect(judgeCt16({ canUseToolOk: false, hookOk: true }).flags).toEqual({ approvalPath: "hook" });
    expect(judgeCt16({ canUseToolOk: false, hookOk: false }).flags).toEqual({ approvalPath: "defer" });
    expect(judgeCt17({ secondModels: ["claude-sonnet-5"], target: "claude-sonnet-5" }).status).toBe("pass");
    expect(judgeCt17({ secondModels: ["claude-haiku-4-5-20251001"], target: "claude-sonnet-5" }).flags).toEqual({ modelChange: "respawn" });
    expect(judgeCt18({ requested: "x", got: "x" }).status).toBe("pass");
    expect(judgeCt18({ requested: "x", got: "y" }).flags).toEqual({ sessionIdOption: false });
    expect(judgeCt19({ maxConcurrent: 3 })).toMatchObject({ status: "pass", flags: { parallelAsks: true } });
    expect(judgeCt19({ maxConcurrent: 1 }).flags).toEqual({ parallelAsks: false });
  });
  it("synthesizes a padded session with a new id and a linked chain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
    const src = path.join(dir, "a.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "old", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "old", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n") + "\n");
    const dst = path.join(dir, "b.jsonl");
    // src here is a locally-created template file, not a box-owned session transcript, and dst is a
    // plain tmpdir path, not one under the box's ~/.claude/projects, so bypass both real (sudo-
    // shelling) defaults with plain fs read/write, matching CT-15's own test pattern.
    synthesizeSession(src, dst, "new", 2_000_000, (f) => fs.readFileSync(f, "utf8"), (f, content) => fs.writeFileSync(f, content));
    const lines = fs.readFileSync(dst, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(fs.statSync(dst).size).toBeGreaterThanOrEqual(2_000_000);
    expect(lines.every((l) => l.sessionId === "new")).toBe(true);
    for (let i = 1; i < lines.length; i++) expect(lines[i].parentUuid).toBe(lines[i - 1].uuid);
  });
  it("lists CT-01…CT-20 in order", () => {
    expect(ALL_CHECKS.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `CT-${String(i + 1).padStart(2, "0")}`));
  });
});
