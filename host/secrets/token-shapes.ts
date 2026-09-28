/**
 * Bug 231 round 2 (defence in depth): text shaped like a well-known credential becomes "[redacted]", whether or not the
 * Bot ever stored it. Applied to a script's full text before its head is cut for the reviewer prompt, after the Bot's own
 * vault redaction (which only knows the values the Bot saved). Round 3: the edges are "no letter or digit" rather than
 * `\b`, so a token glued to `_` or to another identifier (`MY_ghp_…`, `…_sk-…`) is caught too.
 */
const L = "(?<![A-Za-z0-9])";
const R = "(?![A-Za-z0-9])";
const SHAPES: RegExp[] = [
  new RegExp(`${L}gh[opusr]_[A-Za-z0-9]{16,}${R}`, "g"),
  new RegExp(`${L}github_pat_[A-Za-z0-9_]{20,}${R}`, "g"),
  new RegExp(`${L}glpat-[A-Za-z0-9_-]{20,}${R}`, "g"),
  new RegExp(`${L}sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}${R}`, "g"),
  new RegExp(`${L}(?:AKIA|ASIA)[0-9A-Z]{16}${R}`, "g"),
  new RegExp(`${L}xox[abprs]-[A-Za-z0-9-]{10,}${R}`, "g"),
  new RegExp(`${L}npm_[A-Za-z0-9]{36}${R}`, "g"),
  new RegExp(`${L}AIza[0-9A-Za-z_-]{35}${R}`, "g"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function scrubTokenShapes(text: string): string {
  return SHAPES.reduce((t, re) => t.replace(re, "[redacted]"), text);
}
