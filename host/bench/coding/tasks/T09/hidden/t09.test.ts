import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

it("answers/late-fee.json has the right answers", () => {
  const a = JSON.parse(fs.readFileSync(path.join(root, "answers/late-fee.json"), "utf8")) as Record<string, unknown>;
  expect(Object.keys(a).sort()).toEqual(["capCents", "file", "graceDays", "method"]);
  expect(String(a.method).replace(/\(\)$/, "")).toMatch(/^(Ledger[.#])?lateFee$/);
  expect(String(a.file).replace(/^\.\//, "")).toBe("src/ledger.ts");
  expect(a.graceDays).toBe(15);
  expect(a.capCents).toBe(5000);
});
