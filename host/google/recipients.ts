const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** Recipients: a comma-separated string or a list. No CR/LF (header injection), each one an address. */
export function parseRecipients(v: unknown): string[] | null {
  const list = (Array.isArray(v) ? v.map(str) : str(v).split(",")).map((s) => s.trim()).filter(Boolean);
  if (list.some((s) => /[\r\n]/.test(s) || !/^(?:[^<>@\r\n]*<)?[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+>?$/.test(s))) return null;
  return list;
}

/** "Dana <DANA@x.org>" → "dana@x.org". */
export const addressOf = (r: string): string => (/<([^>]+)>/.exec(r)?.[1] ?? r).trim().toLowerCase();
