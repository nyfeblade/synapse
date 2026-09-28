import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// systemd-tmpfiles has no inline comments: anything after the age field is the *argument* field, and a `d` line
// with one logs "d lines don't take argument fields, ignoring" on every provision run. Keep comments on their own
// lines so `systemd-tmpfiles --create` is quiet.
const CONF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/tmpfiles-bots.conf");

describe("tmpfiles-bots.conf", () => {
  const lines = fs.readFileSync(CONF, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

  it.each(lines)("%s has no argument field", (line) => {
    expect(line.trim().split(/\s+/).length, "type path mode user group age -- and nothing after it").toBe(6);
  });

  it("makes /run/bot-x root:bots 0750", () => {
    expect(lines.map((l) => l.trim().split(/\s+/).slice(0, 5).join(" "))).toContain("d /run/bot-x 0750 root bots");
  });
});
