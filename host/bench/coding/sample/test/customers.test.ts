import { describe, expect, it } from "vitest";
import { CustomerDirectory, MemoryCustomerStore, validateCustomer } from "../src/customers";
import { SEED_CUSTOMERS } from "../src/seed";

describe("CustomerDirectory", () => {
  it("loads each customer from the store once while it stays cached", () => {
    const store = new MemoryCustomerStore(SEED_CUSTOMERS);
    const dir = new CustomerDirectory(store, 8);
    dir.get("c-acme");
    dir.get("c-acme");
    dir.get("c-birch");
    expect(store.loads).toBe(2);
  });
  it("renames through to the store and the cache", () => {
    const store = new MemoryCustomerStore(SEED_CUSTOMERS);
    const dir = new CustomerDirectory(store, 8);
    dir.get("c-acme");
    dir.rename("c-acme", "Acme Tooling");
    expect(dir.displayName("c-acme")).toBe("Acme Tooling");
    expect(store.load("c-acme")!.name).toBe("Acme Tooling");
  });
  it("falls back to the id for unknown customers and rejects bad ones", () => {
    const dir = new CustomerDirectory(new MemoryCustomerStore(), 2);
    expect(dir.displayName("c-nope")).toBe("c-nope");
    expect(() => dir.add({ id: "x", name: "X", email: "nope", region: "GB" })).toThrow(/bad email/);
    expect(validateCustomer({ id: "y", name: " ", email: "a@b.co", region: "GB" })).toEqual(["name is empty"]);
  });
  it("lists every customer in id order", () => {
    const dir = new CustomerDirectory(new MemoryCustomerStore(SEED_CUSTOMERS), 2);
    expect(dir.all().map((c) => c.id)).toEqual(["c-acme", "c-birch", "c-cedar", "c-delta"]);
  });
});
