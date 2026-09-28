/**
 * The main process exposes ONE "dictation" channel, and two consumers subscribe to it: the
 * composer microphone (useDictation) and the voice overlay. Without an identity on each session
 * they hear each other's transcripts — dictating into the composer while voice mode is open sent
 * the composer's words to the Bot, and the Bot's turn ended up in the composer.
 *
 * The identity is minted by the consumer (not the main process) so it is known *before* the
 * `dictation.start` round-trip resolves; the main process echoes it on every event of that
 * session, and each consumer ignores anything that isn't its own.
 */
export function newDictationSessionId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True when an event on the shared channel belongs to `mine`. Unaddressed events are broadcast. */
export function isOwnSession(eventSessionId: string | undefined, mine: string | null): boolean {
  return eventSessionId === undefined || eventSessionId === mine;
}
