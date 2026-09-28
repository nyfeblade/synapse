/**
 * bug 198 fix round 2 (re-check of 9bb055e6, finding 2 — "MUST VERIFY"): real Read tool_result shapes,
 * captured from the pinned CLI actually running in this repo — never invented. Three sources:
 *
 *   1. Real, already-stored transcripts under this repo's own Claude Code project directory
 *      (~/.claude/projects/-Users-alex-project/*.jsonl) — genuine Read tool_use/tool_result pairs
 *      from real work on this codebase. Confirms the ordinary shape: `{lineNumber}\t{content}`, no
 *      padding, no `→` separator — e.g. a real result began "100\t  text: string;\n101\t  (a doc
 *      comment about Qwen being loaded and warm)\n...".
 *   2. A live Read of a temp EMPTY file (no secrets: a throwaway scratch file with zero bytes),
 *      captured verbatim below as EMPTY_FILE_OUTPUT.
 *   3. A live Read of a temp file long enough to exceed the viewing harness's own token budget,
 *      captured verbatim below as TRUNCATED_VIEW_FOOTER — a trailing, non-numbered block appended
 *      after the last numbered line. (This particular footer is this harness's OWN view-budget notice,
 *      not necessarily the pinned CLI's raw SDK output for a spawned Bot process — but it is a REAL
 *      captured trailing block of exactly the shape finding 2 asked to be handled: unknown, must be
 *      stripped, must not drop the whole body.)
 *
 * No token or secret value appears in any of these — every probe file was synthetic ("x0", "x1", …).
 */

/** Real capture: Read on a zero-byte file. Verbatim, including the wrapping tag. */
export const EMPTY_FILE_OUTPUT = "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";

/** Real capture: the trailing block appended after 980 real numbered lines of a 3000-line probe file
 *  (long lines, so the total crossed this harness's 25,000-token view budget). Verbatim. */
export const TRUNCATED_VIEW_FOOTER =
  "[Truncated: PARTIAL view — /private/tmp/probe/big-probe.txt: showing lines 1-980 of 3001 total (65007 tokens, cap 25000). " +
  "Call Read with offset=981 limit=980 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]";

/** Real capture (redacted path only): the first and last lines of a genuine Read on this repo's own
 *  app/src/main/native/qwen.ts, `offset: 100, limit: 190` — proves offset/limit produces the REAL
 *  starting line number (101 in the input, 100 in the output — the tool's `offset` is the first line
 *  shown, not "skip this many"), not an assumed 1, and that ordinary content lines have no padding and
 *  no `→`. */
export const REAL_OFFSET_SAMPLE_FIRST_LINE = "100\t  text: string;";
export const REAL_OFFSET_SAMPLE_LAST_LINE = "289\t    return checked;";
