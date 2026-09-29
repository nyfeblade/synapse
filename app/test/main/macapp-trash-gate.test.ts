import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MacAppController } from "../../src/main/macapp/controller";
import type { MacHelper } from "../../src/main/macapp/helper";

/**
 * Pre-release review of the code audit fixes: the Trash rule must judge the path the script will really use.
 * The script trims and expands ~ (scripts.ts expand()), and Finder follows symlinks, so "~/.Trash ", "~/.Trash\n"
 * and a link to ~/.Trash are all moves into the Trash and must ask first, on either side of the move.
 */
let home = "";
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trash-home-"))); fs.mkdirSync(path.join(home, ".Trash")); fs.mkdirSync(path.join(home, "Documents")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function controller() {
  const ran: unknown[] = [];
  const helper = { request: async () => ({ ok: true as const }), warm: async () => true, close: () => {}, alive: () => true } as unknown as MacHelper;
  const osa = { run: async (s: unknown) => { ran.push(s); return { ok: true as const, json: { moved: "x" }, raw: "" }; } };
  const c = new MacAppController({ helper, osa: osa as never, home, userData: home, log: () => {}, now: () => 1_000 });
  return { c, ran };
}
const move = (target: string, value: string) => ({ botId: "b1", botName: "Ava", args: { action: "finder.move", target, value } as never, approved: false });

describe("a move into (or out of) the Trash asks, however the path is written", () => {
  for (const dst of ["~/.Trash ", "~/.Trash\n", " ~/.Trash/", "~/Documents/../.Trash"]) {
    it(`destination ${JSON.stringify(dst)}`, async () => {
      const { c, ran } = controller();
      const r = await c.handle(move("~/Documents/Plan.pdf", dst)) as { ok: boolean; needsApproval?: boolean };
      expect(r.ok).toBe(false);
      expect(r.needsApproval).toBe(true);
      expect(ran).toHaveLength(0);
    });
  }

  it("a symlink to the Trash as the destination", async () => {
    fs.symlinkSync(path.join(home, ".Trash"), path.join(home, "t"));
    const { c, ran } = controller();
    const r = await c.handle(move("~/Documents/Plan.pdf", "~/t")) as { ok: boolean; needsApproval?: boolean };
    expect(r.needsApproval).toBe(true);
    expect(ran).toHaveLength(0);
  });

  it("a symlink to the Trash on the source side", async () => {
    fs.writeFileSync(path.join(home, ".Trash", "old.txt"), "x");
    fs.symlinkSync(path.join(home, ".Trash"), path.join(home, "t"));
    const { c, ran } = controller();
    const r = await c.handle(move("~/t/old.txt ", "~/Documents")) as { ok: boolean; needsApproval?: boolean };
    expect(r.needsApproval).toBe(true);
    expect(ran).toHaveLength(0);
  });

  it("an ordinary move runs without a card", async () => {
    const { c, ran } = controller();
    expect((await c.handle(move("~/Documents/Plan.pdf", "~/Documents/archive"))).ok).toBe(true);
    expect(ran).toHaveLength(1);
  });
});
