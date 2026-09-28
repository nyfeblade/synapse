import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Live-box finding: on a box provisioned by an older build, /home/box/.claude/skills/learn-from-demonstration was
// created by the host process itself and is bothost-owned 0755. Since final secfix round 3 (ruling 1) the publishing
// helper runs as box, so `mktemp` in that directory fails ("failed to create file via template") and the managed
// skill can never be refreshed. provision.sh migrates it: a managed-skill directory that box does not own is removed
// (rm never follows a symlink) and the host re-creates it as box. It must NOT chown inside the box-writable skills
// tree -- box could swap the path for a link between the check and the chown.
const script = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");
// The block runs from its "# Live-box finding" comment to the next blank line; `code` is its non-comment lines.
const block = (/(^|\n)(# Live-box finding[\s\S]*?)\n\s*\n/.exec(script)?.[2] ?? "");
const code = block.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("provision.sh migrates a legacy host-owned managed skill directory", () => {
  it("has the migration block", () => {
    expect(block, "a commented migration block naming learn-from-demonstration").not.toBe("");
  });

  it("only acts on a real directory that box does not own", () => {
    expect(code).toMatch(/! -L/);
    expect(code).toMatch(/stat -c %U/);
    expect(code).toMatch(/!= *("box"|box)/);
  });

  it("removes it instead of chowning inside the box-writable tree", () => {
    expect(code).toMatch(/rm -rf/);
    expect(code).not.toMatch(/chown/);
  });
});
