import { DatabaseSync } from "node:sqlite";
import type { CatalogEntry } from "@synapse/shared";

export class CatalogIndex {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS catalog USING fts5(id UNINDEXED, name, description, category, tokenize='unicode61 remove_diacritics 2', prefix='2 3');`);
  }
  rebuild(entries: CatalogEntry[]): void {
    this.db.exec("DELETE FROM catalog");
    const ins = this.db.prepare("INSERT INTO catalog(id, name, description, category) VALUES (?, ?, ?, ?)");
    for (const e of entries) ins.run(e.id, e.name, e.description, e.category ?? "");
  }
  /** ≤8 terms, each a prefix query (PAL-02 conventions). */
  search(q: string, limit: number): string[] {
    const terms = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" ");
    return (this.db.prepare("SELECT id FROM catalog WHERE catalog MATCH ? ORDER BY rank LIMIT ?").all(match, limit) as { id: string }[]).map((r) => r.id);
  }
  close(): void { this.db.close(); }
}
