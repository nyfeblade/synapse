import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CuratedEntry } from "../../marketplace/catalog";
import { checkCurated, persistVerified } from "../../marketplace/check-curated";

describe("checkCurated", () => {
  it("passes built-in entries through and checks remote entries via fetch", async () => {
    const list: CuratedEntry[] = [
      { id: "curated:gmail", name: "Gmail", description: "d", category: "Productivity", via: "google" },
      { id: "curated:linear", name: "Linear", description: "d", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" },
    ];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }));
    const out = await checkCurated(list, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([
      { id: "curated:gmail", ok: true, status: "google" },
      { id: "curated:linear", ok: true, status: 401 },
    ]);
  });

  it("marks a failing remote entry as not ok", async () => {
    const list: CuratedEntry[] = [{ id: "curated:dead", name: "Dead", description: "d", category: "Code", via: "remote", url: "https://dead.example/mcp" }];
    const fetchImpl = vi.fn(async () => { throw new Error("fetch failed"); });
    const out = await checkCurated(list, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([{ id: "curated:dead", ok: false, status: "fetch failed" }]);
  });
});

describe("persistVerified (reviewer-rules.md: every JSON write must be atomic)", () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("writes curated.verified.json via a temp file + rename, never a direct fs.writeFileSync on the final path", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
    const finalPath = path.join(dir, "curated.verified.json");
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");
    persistVerified(dir, [{ id: "curated:linear", ok: false, status: 401 }]);
    // writeFileSync is only ever called with an open fd (temp file), never the final path string directly.
    for (const call of writeSpy.mock.calls) expect(call[0]).not.toBe(finalPath);
    // The final path is produced by a rename, not a direct write.
    expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(`${finalPath}.`), finalPath);
    writeSpy.mockRestore();
    renameSpy.mockRestore();
    // No leftover .tmp sibling: the rename already completed.
    expect(fs.readdirSync(dir)).toEqual(["curated.verified.json"]);
    expect(JSON.parse(fs.readFileSync(finalPath, "utf8"))).toEqual([{ id: "curated:linear", ok: false, status: 401 }]);
  });
});
