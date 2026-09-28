import { LruCache } from "./cache";
import type { Region } from "./tax";

export interface Customer {
  id: string;
  /** The name printed on invoices and reports. */
  name: string;
  email: string;
  region: Region;
}

/** Where customers really live (a database in production). Loads may be slow; the directory caches them. */
export interface CustomerStore {
  load(id: string): Customer | undefined;
  save(customer: Customer): void;
  ids(): string[];
}

export class MemoryCustomerStore implements CustomerStore {
  private rows = new Map<string, Customer>();
  /** How many times load() ran: tests use it to check the cache. */
  loads = 0;

  constructor(initial: Customer[] = []) {
    for (const c of initial) this.rows.set(c.id, { ...c });
  }

  load(id: string): Customer | undefined {
    this.loads++;
    const c = this.rows.get(id);
    return c ? { ...c } : undefined;
  }

  save(customer: Customer): void {
    this.rows.set(customer.id, { ...customer });
  }

  ids(): string[] {
    return [...this.rows.keys()].sort();
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCustomer(c: Customer): string[] {
  const errors: string[] = [];
  if (!c.id.trim()) errors.push("id is empty");
  if (!c.name.trim()) errors.push("name is empty");
  if (!EMAIL_RE.test(c.email)) errors.push(`bad email "${c.email}"`);
  return errors;
}

/** Cached, read-mostly access to customers. */
export class CustomerDirectory {
  private cache: LruCache<string, Customer>;

  constructor(private store: CustomerStore, cacheSize: number) {
    this.cache = new LruCache(cacheSize);
  }

  get(id: string): Customer | undefined {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const c = this.store.load(id);
    if (c) this.cache.set(id, c);
    return c;
  }

  require(id: string): Customer {
    const c = this.get(id);
    if (!c) throw new Error(`unknown customer "${id}"`);
    return c;
  }

  add(c: Customer): void {
    const errors = validateCustomer(c);
    if (errors.length) throw new Error(`customer ${c.id}: ${errors.join("; ")}`);
    this.store.save(c);
    this.cache.set(c.id, { ...c });
  }

  rename(id: string, name: string): Customer {
    const c = this.require(id);
    const next = { ...c, name };
    const errors = validateCustomer(next);
    if (errors.length) throw new Error(`customer ${id}: ${errors.join("; ")}`);
    this.store.save(next);
    this.cache.set(id, next);
    return next;
  }

  /** Display name for reports; falls back to the id for unknown customers. */
  displayName(id: string): string {
    return this.get(id)?.name ?? id;
  }

  all(): Customer[] {
    return this.store.ids().map((id) => this.require(id));
  }
}
