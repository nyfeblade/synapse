/**
 * CT-03: after `q.interrupt()` during tool use, the CLI delivers its final `error_during_execution`
 * result normally, then the SDK throws this same shape out of the async iterator on the next
 * `next()` — replacing the process's non-zero exit with `Claude Code returned an error result:
 * ${lastErrorResultText}`, where `lastErrorResultText` carries the `[ede_diagnostic] ...
 * stop_reason=tool_use` diagnostic. That's expected CLI/SDK behavior, not a genuine crash — but only
 * when it follows an actual interrupt; shared by claude-brain.ts and conformance/probe.ts so both
 * recognize exactly the same shape.
 *
 * Tightened to the documented shapes (all three markers together — the SDK's wrapping prefix, the
 * diagnostic tag, and a post-interrupt stop reason), not any one of them independently, so a merely
 * similar-sounding but unrelated error can't be mistaken for this one. Two stop reasons are seen
 * live (gate H-3): `tool_use` when the interrupt lands during tool use, and `null` when it lands
 * between stream events (`result_type=user last_content_type=n/a stop_reason=null`).
 */
const POST_INTERRUPT_ERROR = /Claude Code returned an error result:.*\[ede_diagnostic\].*stop_reason=(?:tool_use|null)\b/is;

export function isExpectedPostInterruptThrow(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return POST_INTERRUPT_ERROR.test(msg);
}
