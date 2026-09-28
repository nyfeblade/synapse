import type { SseEvent } from "@synapse/shared";

export function subscribeChannel<C extends SseEvent["channel"]>(channel: C, fn: (payload: Extract<SseEvent, { channel: C }>["payload"]) => void): () => void {
  return window.synapse.onEvent((e) => {
    // The cast is needed because strict mode composes the parameter type of `fn` (called from
    // inside this generic function, before C is bound to a concrete channel) as an intersection
    // across every SseEvent member rather than the union the runtime `e.channel === channel`
    // check actually narrows to; `fn`'s declared (external, call-site) signature stays precise.
    if (e.channel === channel) (fn as (payload: unknown) => void)(e.payload);
  });
}
