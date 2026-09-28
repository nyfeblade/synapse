import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Bug 284: the per-Bot accounts switch is SYNAPSE_PER_BOT_UID now (BOTS_PER_BOT_UID is still read for one release). A
 * box migrated before the rename has a drop-in that sets only the old name, and provision leaves an existing box's
 * mode alone — so on every provision the drop-in, when there is one, is brought up to both names. Without it, the day
 * the old name stops being read every Bot on that box would silently run as the shared uid again. Temp files only.
 */
const prov = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const BOTH = "[Service]\nEnvironment=SYNAPSE_PER_BOT_UID=1\nEnvironment=BOTS_PER_BOT_UID=1\n";

function run(content: string | null): { out: string; file: string; exists: boolean; text: string | null } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-names-"));
  made.push(d);
  const file = path.join(d, "50-per-bot-uid.conf");
  if (content !== null) fs.writeFileSync(file, content);
  const fn = /^per_bot_uid_dropin_names\(\) \{[\s\S]*?^\}/m.exec(prov)?.[0];
  expect(fn, "provision.sh defines per_bot_uid_dropin_names").toBeTruthy();
  const r = spawnSync("bash", ["-c", `${fn}\nper_bot_uid_dropin_names "$1" && echo changed || echo same`, "x", file], { encoding: "utf8" });
  const exists = fs.existsSync(file);
  return { out: r.stdout.trim(), file, exists, text: exists ? fs.readFileSync(file, "utf8") : null };
}

describe("provision brings an existing per-Bot accounts drop-in up to both names", () => {
  it("a drop-in from before the rename (old name only) gets both", () => {
    const r = run("[Service]\nEnvironment=BOTS_PER_BOT_UID=1\n");
    expect(r.out).toBe("changed");
    expect(r.text).toBe(BOTH);
  });

  it("one that already has the new name is left alone", () => {
    expect(run(BOTH)).toMatchObject({ out: "same", text: BOTH });
  });

  it("no drop-in (a box without per-Bot accounts) stays without one", () => {
    expect(run(null)).toMatchObject({ out: "same", exists: false });
  });

  it("provision calls it for an existing box, then reloads systemd", () => {
    expect(prov).toMatch(/if per_bot_uid_dropin_names \/etc\/systemd\/system\/bothost\.service\.d\/50-per-bot-uid\.conf; then systemctl daemon-reload; fi/);
  });
});
