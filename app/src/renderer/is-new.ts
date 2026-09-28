import { useRef } from "react";

/**
 * The mount-entrance gate (docs/motion-spec.md §3.1).
 *
 * A CSS entrance is a mount animation, and a mount animation fires on EVERY element that mounts. Left
 * ungated, switching Bots would animate an entire 200-bubble transcript at once. This seeds the keys
 * present on the first render for a given `resetKey` — the hydration pass — and reports only what
 * arrived afterwards as new.
 *
 * The reset happens DURING render, not in an effect. The spec sketched it as
 * `useEffect(() => { seeded.current = null }, [botId])`, but an effect runs after the render it
 * belongs to, so the first render of the newly selected Bot would still be measured against the old
 * Bot's key set and every one of its existing entries would come out `.is-new` — precisely the bug
 * the gate exists to prevent. Deriving the reset from the prop while rendering is the standard fix
 * and is safe here because the only state is a ref.
 *
 * `seed()` exists for the streaming handoff: an entry can be on screen already (as the typing bubble)
 * before it appears in the list, and must be marked seeded on the render where it first shows up.
 */
export function useIsNew(resetKey: string, keys: readonly string[]): { isNew: (key: string) => boolean; seed: (key: string) => void } {
  const seeded = useRef<Set<string> | null>(null);
  const seededFor = useRef(resetKey);
  if (seeded.current === null || seededFor.current !== resetKey) {
    seededFor.current = resetKey;
    seeded.current = new Set(keys);
  }
  const set = seeded.current;
  return {
    isNew: (key: string) => !set.has(key),
    seed: (key: string) => { set.add(key); },
  };
}

/** `" is-new"` when the key arrived while we were watching, `""` otherwise — for template literals. */
export const newFlag = (isNew: boolean): string => (isNew ? " is-new" : "");
