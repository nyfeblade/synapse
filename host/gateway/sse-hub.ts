import type { SseEvent } from "@synapse/shared";

export class SseHub {
  private subs = new Set<(e: SseEvent) => void>();

  publish(e: SseEvent): void {
    for (const s of this.subs) s(e);
  }

  subscribe(fn: (e: SseEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get size(): number {
    return this.subs.size;
  }
}
