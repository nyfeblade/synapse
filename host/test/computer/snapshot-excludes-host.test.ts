import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Controller ruling (a), final integration: box snapshots EXCLUDE /home/box/.host — the Claude OAuth token, the
// gateway token, the vault key and every other host secret. Snapshots leave the box (the Mac keeps copies), so
// nothing under .host may be archived, and a restore never writes into .host.
const script = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/bot-snapshot"), "utf8");
const members = Object.fromEntries([...(/member\(\) \{ case "\$1" in (.*?) esac; \}/.exec(script)?.[1] ?? "").matchAll(/([\w-]+)\) echo (\S+) ;;/g)].map((m) => [m[1]!, [m[2]!]]));
const excl = /EXCL=\(([\s\S]*?)\)\n/.exec(script)?.[1] ?? "";

describe("bot-snapshot excludes /home/box/.host (ruling a)", () => {
  it("no snapshot part archives .host", () => {
    expect(Object.keys(members).sort()).toEqual(["agent-data", "home", "workspace"]);
    for (const [part, dirs] of Object.entries(members)) expect(dirs, part).not.toContain("home/box/.host");
  });

  it("every create excludes home/box/.host unconditionally (the home part contains it)", () => {
    expect(excl).toContain("--exclude='home/box/.host'");
  });

  it("a restore never writes into .host, even from an old archive that has it", () => {
    // Final secfix round 4 (ruling 2): the root stage only hands the three known trees to their owners (anything
    // else, .host included, is skipped); box's home/box stage excludes .host from both the extract and the rsync.
    const restore = /\n  restore\)([\s\S]*?)\n  delete\)/.exec(script)?.[1] ?? "";
    expect(restore).toMatch(/workspace\|home\/box\) owner=box ;;\s+home\/box\/agent-data\) owner=bothost ;;\s+\*\) continue ;;/);
    const stage = /home\/box:box\)(.*\n.*)/.exec(script)?.[1] ?? "";
    expect(stage).toContain("--exclude=home/box/.host");
    expect(stage).toContain("--exclude=/.host");
  });
});
