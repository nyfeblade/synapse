import { expect, it } from "vitest";
import { CustomerDirectory, MemoryCustomerStore } from "../src/customers";
import { SEED_CUSTOMERS } from "../src/seed";

it("keeps the customer read most recently in the cache", () => {
  const store = new MemoryCustomerStore(SEED_CUSTOMERS);
  const dir = new CustomerDirectory(store, 2);
  dir.get("c-acme");
  dir.get("c-birch");
  dir.get("c-acme"); // acme is now the most recently used
  dir.get("c-cedar"); // full: birch should go, not acme
  dir.get("c-acme");
  expect(store.loads).toBe(3);
});
