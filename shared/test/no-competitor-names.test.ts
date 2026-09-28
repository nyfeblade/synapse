import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFERENCE_NAME } from "../../scripts/public-scan";
import * as shared from "../src";

// A public build must not name the product it was modelled on. Every string reachable from shared's
// exports — UI copy, model-facing copy, labels — is walked; functions are called with placeholder
// arguments so templated copy is covered too. shared/test/public-tree.test.ts checks every file.
const NAMES = REFERENCE_NAME;

function strings(v: unknown, seen = new Set<unknown>(), out: string[] = [], depth = 0): string[] {
  if (depth > 6 || v === null || v === undefined || seen.has(v)) return out;
  if (typeof v === "string") { out.push(v); return out; }
  if (typeof v === "function") {
    for (const args of [["X", 2, 3], [["X", "Y"]], [{}], []]) {
      try { const r = (v as (...a: unknown[]) => unknown)(...args); if (typeof r === "string") out.push(r); } catch { /* not copy */ }
    }
    return out;
  }
  if (typeof v !== "object") return out;
  seen.add(v);
  for (const x of Object.values(v as Record<string, unknown>)) strings(x, seen, out, depth + 1);
  return out;
}

describe("no competitor names in shipped strings", () => {
  it("no exported string names the reference product or its maker", () => {
    const all = strings(shared);
    expect(all.length).toBeGreaterThan(300); // the walk reached the copy, not just a few constants
    expect(all.some((s) => /Synapse|Bot/.test(s))).toBe(true);
    const hits = all.filter((s) => NAMES.test(s));
    expect(hits).toEqual([]);
  });

  it("no file name, identifier, class or comment in the app's source names it", () => {
    // The avatar swap removed the last code named after it; bug 282 removed the research archive and every citation of it.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (NAMES.test(e.name)) hits.push(path.relative(root, p));
        if (!/\.(tsx?|css|html)$/.test(e.name)) continue;
        fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (NAMES.test(l)) hits.push(`${path.relative(root, p)}:${i + 1}: ${l.trim().slice(0, 80)}`); });
      }
    };
    walk(path.join(root, "app", "src"));
    expect(hits).toEqual([]);
  });
});
