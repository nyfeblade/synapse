import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard against the class behind bug #19 (stale data from the previous Bot): ASYNC DATA KEYED BY AN
// ID, HELD IN COMPONENT STATE, NOT RESET WHEN THE ID CHANGES.
//
// The two instances in the log were written the obvious way —
//
//   const [ctx, setCtx] = useState<AgentContextView | null>(null);
//   useEffect(() => { void call("getAgentContext", { id: botId }).then(setCtx); }, [botId]);
//
// — and nothing about that looks wrong. But `setCtx` only ever runs when an ANSWER arrives, so
// between the switch to Bot B and B's answer the state still holds A's, and if B's call rejects it
// holds A's forever. In SecretsSection that meant Bot A's secret NAMES on screen under Bot B's id
// with live Replace/Remove buttons, and those buttons close over the current `botId` — a Replace
// clicked there wrote A's secret name onto B (`vault.upsert` creates on an unknown name).
//
// THE RULE: a `useEffect`/`useCallback` keyed by an id may not read from the host into state that is
// not itself keyed. `useAsync` (async-resource.ts) holds such a value and drops it DURING the render
// in which the key changes; `useKeyedState` does the same for the state beside it (which form is
// open, what has been typed, the last error). Both make the safe behaviour the one you get by
// forgetting — there is no cleanup for the next call site to omit.
//
// This is deliberately a source-level rule with no allowlist, like unsafe-bots-lookup.test.ts: the
// bug is invisible at runtime unless a test switches Bots mid-flight. Effects that subscribe, poll,
// measure, clean up or MUTATE are untouched — only "read, keyed by an id, into unkeyed state".

const RENDERER_DIR = fileURLToPath(new URL("../../src/renderer/", import.meta.url));

/** An identifier in a dep array that keys the data: `botId`, `groupId`, `rootId`, `bot.id`, `key`. */
const KEYED_DEP = /(^|[^A-Za-z0-9_$])([A-Za-z0-9_$]*Id|id|key)([^A-Za-z0-9_$]|$)/;
/**
 * READING from the host — a gateway `get…`/`list…`/`search…` command, or a read on the preload
 * surface. Deliberately not writes: `call("setAgentGoogle", …)` in an id-keyed callback that then
 * sets an error is a mutation, has no previous-Bot value to go stale, and is none of this rule's
 * business.
 */
const HOST_READ = /\b(call|callQuiet)\s*\(\s*"(get|list|search)[A-Za-z0-9_$]*"|\bwindow\.synapse\.[A-Za-z0-9_$.]*\.(list|info)\s*\(/;
/** Writing the answer into component state — `setRows(…)`, or `.then(setCtx)` passing the setter. */
const STATE_WRITE = /\bset[A-Z][A-Za-z0-9_$]*\b/g;
/** `const [src, setSrc] = useKeyedState(key, …)` — state that already resets with its key. */
const KEYED_SETTER = /\[\s*[A-Za-z0-9_$]+\s*,\s*(set[A-Z][A-Za-z0-9_$]*)\s*\]\s*=\s*useKeyedState[<(]/g;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = dir + entry;
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full + "/"));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The text between a hook call's `(` and its matching `)`, for every `useEffect` and `useCallback`
 * in the file. `useCallback` counts because SecretsSection hid the whole defect one hop away: the
 * fetch lived in a `useCallback([botId])` and the effect beside it only said `void load()`.
 */
function effects(src: string, marker = "useEffect("): { body: string; line: number; marker: string }[] {
  const out: { body: string; line: number; marker: string }[] = [];
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
    let depth = 1;
    let j = i + marker.length;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
    }
    out.push({ body: src.slice(i + marker.length, j - 1), line: src.slice(0, i).split("\n").length, marker });
  }
  return out;
}

const keyedHooks = (src: string) => [...effects(src), ...effects(src, "useCallback(")];

/** The last `[...]` in the call — the dependency array. An effect with no deps array is not keyed. */
function depsOf(body: string): string | null {
  const close = body.lastIndexOf("]");
  if (close === -1) return null;
  let depth = 1;
  for (let i = close - 1; i >= 0; i--) {
    if (body[i] === "]") depth += 1;
    else if (body[i] === "[") depth -= 1;
    if (depth === 0) return body.slice(i + 1, close);
  }
  return null;
}

/** State that is already keyed — `useKeyedState` resets it during the render the key changes. */
const keyedSetters = (src: string) => new Set([...src.matchAll(KEYED_SETTER)].map((m) => m[1]!));

/** Every id-keyed hook in `src` that reads from the host into state that is not itself keyed. */
function violationsInSource(src: string, label: string): string[] {
  const safe = keyedSetters(src);
  return keyedHooks(src).flatMap(({ body, line, marker }) => {
    const deps = depsOf(body);
    if (deps === null || !KEYED_DEP.test(deps)) return [];
    const writes = [...body.matchAll(STATE_WRITE)].map((m) => m[0]).filter((name) => !safe.has(name));
    if (!HOST_READ.test(body) || writes.length === 0) return [];
    return [`${label}:${line}: ${marker}…, [${deps.trim()}]) reads from the host into ${writes[0]} — state keyed by an id belongs in useAsync/useKeyedState`];
  });
}

const violationsIn = (file: string) => violationsInSource(readFileSync(file, "utf8"), file.slice(file.indexOf("src/renderer/")));

describe("async data keyed by an id may not live in raw component state (bug #19 guard)", () => {
  it("finds no id-keyed hook in the renderer that reads from the host into unkeyed state", () => {
    expect(listSourceFiles(RENDERER_DIR).flatMap(violationsIn)).toEqual([]);
  });

  // The guard is a regex sandwich, so it is worth knowing it still matches anything at all: a
  // refactor that quietly stops matching would otherwise read as a permanently green rule.
  it("rejects the shape it exists to catch — the two real instances, as they were written", () => {
    const advanced = `
      const [ctx, setCtx] = useState<AgentContextView | null>(null);
      useEffect(() => { if (on) void call("getAgentContext", { id: botId }).then(setCtx).catch(() => setCtx(null)); }, [on, botId, updatedAt]);
    `;
    const secrets = `
      const load = useCallback(async () => { setRows(await window.synapse.secrets.list(botId)); }, [botId]);
      useEffect(() => { void load(); }, [load]);
    `;
    expect(violationsInSource(advanced, "AdvancedSection.tsx")).toHaveLength(1);
    expect(violationsInSource(secrets, "SecretsSection.tsx")).toHaveLength(1);
  });

  it("leaves alone what is not this bug", () => {
    // A mutation keyed by an id that reports its own failure: nothing fetched, nothing to go stale.
    const mutation = `useEffect(() => { void call("setAgentGoogle", { id: botId }).catch((e) => setError(e.message)); }, [botId]);`;
    // A read that is not keyed by anything: one Bot's answer cannot appear under another's.
    const unkeyed = `useEffect(() => { void call("getWorkflows", {}).then((r) => setAll(r.workflows)); }, []);`;
    // A read keyed by an id whose state already resets with that key.
    const keyed = `
      const [src, setSrc] = useKeyedState<string | null>(key, cache.get(key) ?? null);
      useEffect(() => { void call("getAgentAvatar", { id: bot.id }).then((r) => setSrc(r.url)); }, [key, bot.id]);
    `;
    expect(violationsInSource(mutation, "m")).toEqual([]);
    expect(violationsInSource(unkeyed, "u")).toEqual([]);
    expect(violationsInSource(keyed, "k")).toEqual([]);
  });
});
