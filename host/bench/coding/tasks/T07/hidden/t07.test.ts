import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { CustomerDirectory, MemoryCustomerStore } from "../src/customers";
import { agingReport } from "../src/report";
import { SEED_CUSTOMERS, seedLedger } from "../src/seed";

const root = path.resolve(import.meta.dirname, "..");

it("seed customers carry legalName and no name", () => {
  for (const c of SEED_CUSTOMERS) {
    expect(Object.keys(c)).toContain("legalName");
    expect(Object.keys(c)).not.toContain("name");
  }
  expect((SEED_CUSTOMERS[0] as unknown as { legalName: string }).legalName).toBe("Acme Tools");
});

it("the directory reads and renames legalName", () => {
  const store = new MemoryCustomerStore(SEED_CUSTOMERS);
  const dir = new CustomerDirectory(store, 4);
  dir.rename("c-acme", "Acme Tooling");
  const c = store.load("c-acme") as unknown as Record<string, unknown>;
  expect(c.legalName).toBe("Acme Tooling");
  expect("name" in c).toBe(false);
  expect(dir.displayName("c-acme")).toBe("Acme Tooling");
  const bad = { id: "z", legalName: " ", email: "z@z.io", region: "GB" };
  expect(() => dir.add(bad as never)).toThrow();
});

it("reports and exports show the same text as before", () => {
  const l = seedLedger();
  expect(agingReport(l, "2025-03-10").rows.map((r) => r.customer)).toEqual(["Acme Tools", "Birch & Co", "Cedar Books", "Delta Foods"]);
  expect(l.exportCsv().split("\n")[2]).toBe("INV-1002,Birch & Co,2025-01-10,2025-02-09,201250,39000,240250,open");
});

it("no Customer `name` field is left in the source", () => {
  const cust = fs.readFileSync(path.join(root, "src/customers.ts"), "utf8");
  expect(cust).not.toMatch(/^\s*name\s*:\s*string/m);
  const seed = fs.readFileSync(path.join(root, "src/seed.ts"), "utf8");
  expect(seed).not.toMatch(/\bname:/);
});
