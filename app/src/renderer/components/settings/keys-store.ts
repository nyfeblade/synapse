import { useEffect, useState } from "react";
import type { KeysView } from "@synapse/shared";
import { callQuiet } from "../../bridge";

/** Every KeyList on the Account page shows the same keys: a change in one reaches the others (a new default, spend). */
const subs = new Set<(v: KeysView) => void>();
export function subscribeKeys(fn: (v: KeysView) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export function publishKeys(v: KeysView): void {
  for (const fn of [...subs]) fn(v);
}

/**
 * The saved keys (0.1.7), or null until they load. A host that has no key list (before 0.1.7) answers with an error or
 * something else: `failed` is then set and the Account page keeps its one-key form.
 */
/** One read shared by every list that mounts together (the Account page has one per provider). */
let inflight: Promise<KeysView> | null = null;
const readKeys = (): Promise<KeysView> => {
  if (!inflight) { inflight = callQuiet("getKeys", {}); void inflight.finally(() => { inflight = null; }).catch(() => {}); }
  return inflight;
};

export function useKeysView(): { view: KeysView | null; failed: string | null } {
  const [view, setView] = useState<KeysView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readKeys()
      .then((v) => { if (!live) return; if (v && Array.isArray(v.rings)) setView(v); else setFailed("no key list"); })
      .catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    const off = subscribeKeys((v) => { if (live) setView(v); });
    return () => { live = false; off(); };
  }, []);
  return { view, failed };
}
