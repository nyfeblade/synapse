/** A small typed event emitter. */

export type Listener<P> = (payload: P) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Listener<never>[]>();

  /** Subscribes; returns a function that unsubscribes. */
  on<K extends keyof Events>(name: K, fn: Listener<Events[K]>): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn as Listener<never>);
    this.listeners.set(name, list);
    return () => this.off(name, fn);
  }

  /** Removes one registration of `fn`. Removing a listener that is not registered does nothing. */
  off<K extends keyof Events>(name: K, fn: Listener<Events[K]>): void {
    const list = this.listeners.get(name);
    if (!list) return;
    const i = list.indexOf(fn as Listener<never>);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.listeners.delete(name);
  }

  /** Subscribes for exactly one emission. */
  once<K extends keyof Events>(name: K, fn: Listener<Events[K]>): () => void {
    const wrapped: Listener<Events[K]> = (p) => {
      this.off(name, wrapped);
      fn(p);
    };
    return this.on(name, wrapped);
  }

  /**
   * Calls every listener registered when the emit starts, in registration order. Listeners added
   * or removed during an emit take effect from the next emit.
   */
  emit<K extends keyof Events>(name: K, payload: Events[K]): number {
    const list = this.listeners.get(name);
    if (!list) return 0;
    const snapshot = [...list];
    for (const fn of snapshot) (fn as Listener<Events[K]>)(payload);
    return snapshot.length;
  }

  listenerCount(name: keyof Events): number {
    return this.listeners.get(name)?.length ?? 0;
  }
}
