import { API_KEY_RE, claudeEnv } from "@synapse/shared";

/**
 * Review round 2 (S3): the env for a real `claude` a Mac-side dev tool starts (the coding bench's CLI baseline, the
 * routing eval, the perf probes). Never the developer's own Claude login: built by the shared claudeEnv (every login
 * var deleted, checked before it is returned), with an explicit key (SYNAPSE_API_KEY, else ANTHROPIC_API_KEY) or, with
 * none, the dead sentinel pair, so the run fails fast instead of reading a stored login. Box-side evals use the box's
 * saved key instead (useSavedAuth).
 */
export function explicitKeyEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const key = [base.SYNAPSE_API_KEY, base.ANTHROPIC_API_KEY].map((k) => k?.trim()).find((k) => !!k && API_KEY_RE.test(k));
  const { SYNAPSE_API_KEY: _drop, ...rest } = base;
  return claudeEnv(rest, { apiKey: key ?? null });
}
