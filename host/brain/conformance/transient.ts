/** A probe error that says nothing about the CLI's behaviour: rate limits, overload, network, timeouts (review fix round 1). */
export function isTransientError(msg: string): boolean {
  return /rate.?limit|\b429\b|\b529\b|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|timed? ?out/i.test(msg);
}
