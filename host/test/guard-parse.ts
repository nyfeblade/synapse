/** Source parsers shared by the declaration-style guard tests. */

/** The field names declared inside `interface <name> { … }` / `export interface <name> { … }`. */
export function interfaceFields(src: string, name: string): string[] {
  const m = new RegExp(`interface\\s+${name}\\s*\\{`).exec(src);
  if (!m) return [];
  let depth = 0;
  let i = src.indexOf("{", m.index);
  const start = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const body = src
    .slice(start, i)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  return [...new Set([...body.matchAll(/(?:^|[;{]|\n)\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((x) => x[1]!))];
}
