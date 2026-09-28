import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: the host makes model calls ONLY through usage/metered-query.ts, which records every result.
 * No other host source may import the SDK's model-calling entry points, by name, by namespace or
 * dynamically — so a new call path cannot skip recording. There is no allowlist of call sites.
 */
const HOST = path.resolve(__dirname, "../..");
const WRAPPER = path.join(HOST, "usage", "metered-query.ts");
const SDK = "@anthropic-ai/claude-agent-sdk";
const CALLERS = new Set(["query", "unstable_v2_createSession", "unstable_v2_resumeSession", "unstable_v2_prompt"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join(HOST, "test")) out.push(...sources(p)); }
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function sdkCallImports(src: string): string[] {
  const bad: string[] = [];
  const esc = SDK.replace(/[/-]/g, "\\$&");
  for (const m of src.matchAll(new RegExp(`import\\s+(type\\s+)?([^;]*?)\\s+from\\s+["']${esc}["']`, "g"))) {
    if (m[1]) continue; // `import type { … }` can't call anything
    const clause = m[2]!;
    if (/\*\s+as\s+/.test(clause)) { bad.push("namespace import"); continue; }
    if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim())) bad.push("default import");
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    for (const spec of named.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (spec.startsWith("type ")) continue;
      const name = spec.split(/\s+as\s+/)[0]!.trim();
      if (CALLERS.has(name)) bad.push(name);
    }
  }
  if (new RegExp(`(import|require)\\s*\\(\\s*["']${esc}["']`).test(src)) bad.push("dynamic import");
  if (new RegExp(`export\\s+\\*\\s+from\\s+["']${esc}["']`).test(src)) bad.push("re-export");
  return bad;
}

describe("metering guard (every host model call is recorded)", () => {
  it("recognizes each way of reaching the SDK's query", () => {
    expect(sdkCallImports(`import { query, type Options } from "${SDK}";`)).toEqual(["query"]);
    expect(sdkCallImports(`import { type Query, query as q } from "${SDK}";`)).toEqual(["query"]);
    expect(sdkCallImports(`import * as sdk from "${SDK}";`)).toEqual(["namespace import"]);
    expect(sdkCallImports(`const s = await import("${SDK}");`)).toEqual(["dynamic import"]);
    expect(sdkCallImports(`import type { query } from "${SDK}";`)).toEqual([]);
    expect(sdkCallImports(`import { createSdkMcpServer, type Query } from "${SDK}";`)).toEqual([]);
  });

  it("no host source but the metering wrapper imports the SDK's model-calling entry points", () => {
    const offenders = sources(HOST).filter((f) => f !== WRAPPER).flatMap((f) => sdkCallImports(fs.readFileSync(f, "utf8")).map((b) => `${path.relative(HOST, f)}: ${b}`));
    expect(offenders).toEqual([]);
  });

  it("the wrapper itself hands out only metered calls, never the raw SDK function", () => {
    const src = fs.readFileSync(WRAPPER, "utf8");
    expect(src).toMatch(/import\s+\{\s*query as sdkQuery[^}]*\}\s+from/);
    expect(src).not.toMatch(/export\s+(const|\{)[^;]*\bsdkQuery\b(?!\s*>)/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bquery\b/);
  });
});
