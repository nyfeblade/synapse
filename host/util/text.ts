const RESERVED = /^(bot|claude-ai.*|claude_ai.*)$/;

/** SDK-safe ids for MCP servers, plugin skill folders, templates and branches. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";
  return RESERVED.test(s) ? `${s}-server` : s;
}

/** Adds `metadata.source` to a SKILL.md front matter (SKL-01 layout; §4.3 Skill metadata.source). */
export function withSourceMetadata(md: string, source: string): string {
  if (!md.startsWith("---\n")) return `---\nmetadata:\n  source: ${source}\n---\n${md}`;
  const end = md.indexOf("\n---", 4);
  const head = md.slice(0, end);
  const rest = md.slice(end);
  if (/^ {2}source:.*$/m.test(head)) return head.replace(/^ {2}source:.*$/m, `  source: ${source}`) + rest;
  if (/^metadata:\s*$/m.test(head)) return head.replace(/^metadata:\s*$/m, `metadata:\n  source: ${source}`) + rest;
  return `${head}\nmetadata:\n  source: ${source}${rest}`;
}
