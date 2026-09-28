import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "./error-channel";

// THE DEFECT THIS EXISTS TO MAKE UNSAYABLE
//
// Every async read in the renderer re-decided how to represent its three outcomes, and the two
// cheapest spellings both erase a failure:
//
//   const [v, setV] = useState<T | null>(null);
//   useEffect(() => { void call(...).then(setV).catch(() => {}); }, []);
//   if (!v) return null;                       // "loading" and "broken" are the same pixel: none
//
// The feature simply vanishes — no message, no retry, nothing to click, and no way for the user to
// tell a slow box from a dead one. `AsyncResource` has no null to hide in: the three outcomes are
// three tagged values, `value` exists only on "ready", and <Async /> (components/Async.tsx) owns
// the loading and error arms so a caller cannot forget to write them.

export type AsyncResource<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

export interface AsyncHandle<T> {
  /** Run the loader again: the Retry button, and any caller that knows the data went stale. */
  reload(): void;
  /** Replace a ready value in place — for a mutation whose response IS the new state. */
  setValue(value: T): void;
}

export interface UseAsyncOptions {
  /**
   * False keeps the loader unfired and the resource in "loading" (nothing has been asked for yet,
   * so nothing can have failed). For a read that only happens when something is opened.
   */
  enabled?: boolean;
}

const LOADING: AsyncResource<never> = { status: "loading" };
const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Load `T` once per `deps` change, as a three-state resource.
 *
 * The returned object is the union intersected with its handle, so `r.status === "ready"` narrows
 * to `r.value` while `r.reload()` is always available.
 *
 * THE SECOND DEFECT THIS EXISTS TO MAKE UNSAYABLE (bug #19) — a value outliving its key.
 *
 * `deps` is not just "when to reload", it is WHO THE VALUE BELONGS TO. Resetting inside the effect
 * is too late: React commits the render in which the key changed before any effect runs, so the
 * previous Bot's context meter and the previous Bot's SECRET NAMES — with live Replace/Remove
 * buttons closing over the NEW botId — were painted under the new id, and stayed there forever if
 * the new load failed. The reset below therefore happens DURING that render: a `status: "ready"`
 * from this hook is a promise that `value` was loaded for the deps you are rendering with, and
 * there is no frame, however brief, in which that is false. No call site has to remember anything.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[], opts: UseAsyncOptions = {}): AsyncResource<T> & AsyncHandle<T> {
  const enabled = opts.enabled ?? true;
  // `enabled` is part of the key: switching a panel off means nothing has been asked for yet, so
  // re-opening it must not flash the answer to the question it asked last time.
  const key = [...deps, enabled];
  const [held, setHeld] = useState<{ key: unknown[]; state: AsyncResource<T> }>({ key, state: LOADING });
  const fresh = sameKey(held.key, key);
  if (!fresh) setHeld({ key, state: LOADING }); // render-phase reset: React re-renders before committing
  const state = fresh ? held.state : LOADING;
  const setState = useCallback((next: AsyncResource<T>) => setHeld((h) => ({ key: h.key, state: next })), []);
  const [attempt, setAttempt] = useState(0);
  // The loader closes over props; re-running the effect on every render would loop, and leaving it
  // out of the deps would pin the first closure forever. A ref holds the newest one, and `deps` +
  // `attempt` alone decide when to fire — the same shape RoutinesSection arrived at by hand.
  const latest = useRef(load);
  latest.current = load;
  // Bumped on every run: an answer whose run is no longer the current one is dropped, so a slow
  // first request can't overwrite a faster second one (or set state on an unmounted component).
  const run = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++run.current;
    // No "loading" write here. A key change has already been reset above, in the render itself; the
    // only other way in is `reload()`, which re-asks the SAME question — and blanking the rows the
    // user is looking at, to re-fetch what they just changed, is a flash, not information. A failed
    // reload still replaces them with the error.
    latest.current().then(
      (value) => { if (run.current === mine) setState({ status: "ready", value }); },
      (e: unknown) => { if (run.current === mine) setState({ status: "error", message: messageOf(e) }); },
    );
    return () => { run.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt, enabled]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const setValue = useCallback((value: T) => setState({ status: "ready", value }), [setState]);
  return { ...state, reload, setValue };
}

/**
 * Local state that belongs to one key, and goes back to `initial` the moment the key changes.
 *
 * The sibling of `useAsync` for the state that sits BESIDE a keyed resource — which form is open,
 * which row is being edited, what the user has typed, the last mutation's error. Those are as much
 * "about Bot A" as the fetched rows are: leaving them behind put Bot A's half-typed secret value in
 * Bot B's form, and left "Replace" open on a row Bot B does not have.
 *
 * Like `useAsync`, the reset happens during the render in which the key changes, not in an effect,
 * so there is no committed frame carrying the previous key's state.
 */
export function useKeyedState<T>(key: unknown, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [held, setHeld] = useState<{ key: unknown; value: T }>({ key, value: initial });
  const fresh = Object.is(held.key, key);
  if (!fresh) setHeld({ key, value: initial });
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setHeld((h) => ({ key: h.key, value: typeof next === "function" ? (next as (prev: T) => T)(h.value) : next }));
  }, []);
  return [fresh ? held.value : initial, set];
}

/**
 * The same three outcomes for work whose RESULT lands somewhere else — the bootstrap load, which
 * writes Bots, settings and trays straight into the store. It still has to say which of the three
 * it is: "no rows yet" and "the load failed" were the same empty sidebar before this existed.
 */
export type AsyncStatus =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

/** Renders an AsyncStatus through the same <Async /> the value-carrying resources use. */
export function asResource(s: AsyncStatus, reload: () => void): AsyncResource<null> & { reload(): void } {
  return s.status === "ready" ? { status: "ready", value: null, reload } : { ...s, reload };
}
