const WORD = "[\\p{L}\\p{N}_]";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GRP-03 handles: lowercased full name, the name without spaces, and the first word (deduped, in that order). */
export function handlesOf(name: string): string[] {
  const full = name.trim().toLowerCase().replace(/\s+/g, " ");
  return [...new Set([full, full.replace(/ /g, ""), full.split(" ")[0] ?? full].filter(Boolean))];
}

function mentions(text: string, handle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escape(handle).replace(/ /g, "\\s+")}(?!${WORD})`, "iu").test(text);
}

/** Members addressed by a post, or "all" when it names nobody or uses @everyone / @all. */
export function mentionedMembers(text: string, members: { id: string; name: string }[]): string[] | "all" {
  if (/(^|\s)@(everyone|all)(?![\p{L}\p{N}_])/iu.test(text)) return "all";
  const hit = members.filter((m) => handlesOf(m.name).some((h) => mentions(text, h))).map((m) => m.id);
  return hit.length ? hit : "all";
}

export const PASS_RE = /^\(?\s*pass\s*\)?\.?$/i;

export function isPass(text: string): boolean {
  return PASS_RE.test(text.trim());
}

/** True while a streaming post could still turn out to be "(pass)" — such text is never shown (GRP-05). */
export function couldStillBePass(partial: string): boolean {
  return /^\(?\s*(p(a(s(s)?)?)?)?\s*\)?\.?$/i.test(partial.trim());
}
