import path from "node:path";

/**
 * ACP `session/request_permission` → the calls Synapse's approval gate decides (Wave 3). The vendor agent describes a
 * tool call by its `kind` and its own `rawInput`; each kind Synapse understands becomes the CLI-named call the gate
 * already classifies (Bash, Read, Grep, Edit, Write, WebFetch), so the floor rules, walls, the reviewer and the card are
 * the same as for every other Bot. Anything else — an unknown or missing kind, `think`, `switch_mode`, `other`, or a
 * known kind whose input can't be read — has no gate call and is denied (fail closed).
 */
export interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[] | null;
  locations?: { path?: unknown; line?: unknown }[] | null;
}
export interface GateCall { toolName: string; input: Record<string, unknown> }
export interface PermissionOption { optionId: string; name?: string; kind: string }
export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A single shell word, quoted. */
export const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function commandOf(raw: Record<string, unknown>): string | null {
  for (const k of ["command", "cmd", "commandLine", "script"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) {
      const args = Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string") ? (raw.args as string[]) : [];
      return args.length ? [v, ...args].map(shq).join(" ") : v;
    }
    if (Array.isArray(v) && v.length && v.every((a) => typeof a === "string")) return (v as string[]).map(shq).join(" ");
  }
  return null;
}

function pathsOf(tc: AcpToolCall, raw: Record<string, unknown>, cwd: string): string[] {
  const out: string[] = [];
  const add = (p: unknown) => { const s = str(p); if (s) out.push(path.resolve(cwd, s)); };
  for (const k of ["file_path", "filePath", "path", "abs_path", "absPath", "file", "target"]) add(raw[k]);
  if (Array.isArray(raw.paths)) raw.paths.forEach(add);
  for (const l of tc.locations ?? []) add(obj(l).path);
  for (const c of tc.content ?? []) { const o = obj(c); if (o.type === "diff") add(o.path); }
  return [...new Set(out)];
}

function diffFor(tc: AcpToolCall, p: string, cwd: string): { oldText: string | null; newText: string } | null {
  for (const c of tc.content ?? []) {
    const o = obj(c);
    if (o.type === "diff" && typeof o.newText === "string" && str(o.path) && path.resolve(cwd, o.path as string) === p) {
      return { oldText: typeof o.oldText === "string" ? o.oldText : null, newText: o.newText };
    }
  }
  return null;
}

/** The gate calls for one permission request; null = no call Synapse can decide, so it is denied. */
export function gateCallsFor(tc: AcpToolCall, cwd: string): GateCall[] | null {
  const raw = obj(tc.rawInput);
  const kind = typeof tc.kind === "string" ? tc.kind : "";
  switch (kind) {
    case "execute": {
      const command = commandOf(raw);
      if (!command) return null;
      return [{ toolName: "Bash", input: { command, ...(str(raw.description) ? { description: raw.description } : {}) } }];
    }
    case "read": {
      const ps = pathsOf(tc, raw, cwd);
      return ps.length ? ps.map((p) => ({ toolName: "Read", input: { file_path: p } })) : null;
    }
    case "search": {
      const ps = pathsOf(tc, raw, cwd);
      const pattern = str(raw.pattern) ?? str(raw.query) ?? str(raw.regex) ?? "";
      return (ps.length ? ps : [cwd]).map((p) => ({ toolName: "Grep", input: { pattern, path: p } }));
    }
    case "edit": {
      const ps = pathsOf(tc, raw, cwd);
      if (!ps.length) return null;
      return ps.map((p) => {
        const d = diffFor(tc, p, cwd);
        if (d && d.oldText !== null) return { toolName: "Edit", input: { file_path: p, old_string: d.oldText, new_string: d.newText } };
        const content = d?.newText ?? str(raw.content) ?? str(raw.new_text) ?? str(raw.newText) ?? "";
        return { toolName: "Write", input: { file_path: p, content } };
      });
    }
    case "delete": {
      const ps = pathsOf(tc, raw, cwd);
      return ps.length ? [{ toolName: "Bash", input: { command: `rm -rf -- ${ps.map(shq).join(" ")}`, description: "Delete (asked by the coding CLI)" } }] : null;
    }
    case "move": {
      const from = str(raw.from) ?? str(raw.source) ?? str(raw.old_path) ?? str(raw.oldPath);
      const to = str(raw.to) ?? str(raw.destination) ?? str(raw.new_path) ?? str(raw.newPath);
      const ps = from && to ? [path.resolve(cwd, from), path.resolve(cwd, to)] : pathsOf(tc, raw, cwd);
      return ps.length === 2 ? [{ toolName: "Bash", input: { command: `mv -- ${shq(ps[0]!)} ${shq(ps[1]!)}`, description: "Move (asked by the coding CLI)" } }] : null;
    }
    case "fetch": {
      const url = str(raw.url) ?? str(raw.uri);
      return url ? [{ toolName: "WebFetch", input: { url, prompt: str(raw.prompt) ?? "" } }] : null;
    }
    default:
      // think, switch_mode (could leave the vendor's asking mode), other, missing, or a kind added to ACP later.
      return null;
  }
}

/**
 * The option to answer with. An allow is only ever "allow_once": "allow_always" would let the vendor stop asking, and
 * every later call must reach the gate again (Synapse's own "Always allow" is a gate rule, kept on our side). No
 * allow_once on offer = denied. A denial takes reject_once, else reject_always, else cancels.
 */
export function pickOutcome(options: unknown, allow: boolean): PermissionOutcome {
  const opts = (Array.isArray(options) ? options : []).map(obj).filter((o) => typeof o.optionId === "string" && typeof o.kind === "string") as unknown as PermissionOption[];
  if (allow) {
    const once = opts.find((o) => o.kind === "allow_once");
    if (once) return { outcome: "selected", optionId: once.optionId };
  }
  const reject = opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always");
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}

/** The CLI-style name and input a vendor tool call shows in the transcript (so steps and icons read as usual). */
export function displayOf(tc: AcpToolCall, cwd: string): { name: string; input: Record<string, unknown> } {
  const calls = gateCallsFor(tc, cwd);
  if (calls?.length) return { name: calls[0]!.toolName, input: calls[0]!.input };
  return { name: "Tool", input: { description: str(tc.title) ?? "Tool" } };
}
