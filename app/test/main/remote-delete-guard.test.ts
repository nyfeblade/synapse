import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removableOnBox } from "../../src/main/secret-sync";

/**
 * THE CLASS (bug 57): a Mac → box reconcile that reads "absent here" as "delete there". A new, reinstalled or
 * wiped profile has an empty local store, so such a path deletes everything the box holds, including values
 * this Mac never had.
 *
 * THE RULE: every reconcile in the app (a function named *resync*, *reconcile*, *mirror* or *syncAll*) that can
 * delete remotely routes the choice of what to delete through `removableOnBox(remote, local, ledger)`, which
 * only returns names this profile's ledger says it synced. The scan below forces the next reconcile to make
 * that choice out loud; the checks under it prove the scan fires on the old shape and finds the real one.
 */
const appSrc = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "src");
const NAME = /\b(?:async\s+)?(\w*(?:resync|Resync|reconcile|Reconcile|mirror|Mirror|syncAll|SyncAll)\w*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
const DELETES = /\bremoves\b|call\(\s*["'](?:delete|remove)\w*["']|\.secrets\.remove\(/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

function bodyAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Every reconcile-named function in `src` that can delete remotely, and whether it goes through the rule. */
export function reconcilers(src: string): { name: string; deletes: boolean; ruled: boolean }[] {
  const out = [];
  for (const m of src.matchAll(NAME)) {
    const body = bodyAt(src, m.index! + m[0].length - 1);
    out.push({ name: m[1]!, deletes: DELETES.test(body), ruled: body.includes("removableOnBox(") });
  }
  return out;
}

describe("guard: no reconcile deletes remotely from an empty local store (bug 57)", () => {
  it("the rule itself: an empty ledger deletes nothing, whatever the box holds or the Mac lacks", () => {
    for (const remote of [["A"], ["A", "B", "C"], ["STRIPE_KEY", "GH_PAT", "X_1"]]) {
      expect(removableOnBox(remote, [], [])).toEqual([]);
      expect(removableOnBox(remote, ["A"], [])).toEqual([]);
    }
    expect(removableOnBox(["A", "B", "C"], ["A"], ["A", "B"])).toEqual(["B"]);
  });

  it("every reconcile under app/src that deletes remotely goes through removableOnBox", () => {
    const found = files(appSrc).flatMap((f) => reconcilers(fs.readFileSync(f, "utf8")).map((r) => ({ ...r, file: path.relative(appSrc, f) })));
    // Not vacuous: the scan must find the reconcile this rule was written for.
    expect(found.some((r) => r.file === path.join("main", "secret-sync.ts") && r.name === "resync" && r.deletes)).toBe(true);
    expect(found.filter((r) => r.deletes && !r.ruled).map((r) => `${r.file} ${r.name}`)).toEqual([]);
  });

  it("must fire on the pre-fix shape (every box name the Mac lacks)", () => {
    const old = `async resync(botIds: string[]): Promise<number> {
      const removes = status.map((s) => s.name).filter((n) => !mine.some((e) => e.name === n));
      await this.o.call("setBotSecrets", { botId, upserts, removes });
    }`;
    expect(reconcilers(old)).toEqual([{ name: "resync", deletes: true, ruled: false }]);
  });

  it("must not fire on a reconcile that only pushes", () => {
    const pushOnly = `async reconcileHeaders(ids: string[]) { for (const id of ids) await call("setHeaders", { id }); }`;
    expect(reconcilers(pushOnly)).toEqual([{ name: "reconcileHeaders", deletes: false, ruled: false }]);
  });
});
