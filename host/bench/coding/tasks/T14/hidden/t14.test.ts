import { expect, it } from "vitest";
import { LruCache } from "../src/cache";
import { CustomerDirectory, MemoryCustomerStore } from "../src/customers";
import { SEED_CUSTOMERS } from "../src/seed";

it("get marks an entry most recently used; has and peek do not", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1).set("b", 2);
  c.get("a");
  c.set("c", 3);
  expect(c.keys()).toEqual(["a", "c"]);
  c.has("a");
  c.peek("a");
  c.set("d", 4);
  expect(c.keys()).toEqual(["c", "d"]);
  expect(c.evicted).toBe(2);
});

it("the directory keeps hot customers cached", () => {
  const store = new MemoryCustomerStore(SEED_CUSTOMERS);
  const dir = new CustomerDirectory(store, 2);
  for (const id of ["c-acme", "c-birch", "c-acme", "c-cedar", "c-acme", "c-delta", "c-acme"]) dir.get(id);
  expect(store.loads).toBe(4);
});

it("a directory of capacity 2 still evicts", () => {
  const store = new MemoryCustomerStore(SEED_CUSTOMERS);
  const dir = new CustomerDirectory(store, 2);
  for (const id of ["c-acme", "c-birch", "c-cedar", "c-acme"]) dir.get(id);
  expect(store.loads).toBe(4);
});
