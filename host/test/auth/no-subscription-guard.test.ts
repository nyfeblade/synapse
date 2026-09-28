import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLAUDE_LOGIN_VARS, assertNoClaudeLogin } from "@synapse/shared";

/**
 * synapse-public guard: the public build is API-key only (a Claude subscription or Claude Code login must never be
 * how Bots reach Claude).
 *
 * Review round 3 (S6): structure first, text second.
 *  1. Every claude process starts through one helper: the host's host/claude/spawn.ts (the SDK's query() only via
 *     startClaudeQuery; spawnClaudeProcess; claudeVersion; runClaudeCli), the Mac's macRunEnv
 *     (app/src/coordinator/local-exec/login-scrub.ts), both built on the shared claudeEnv, which deletes every login
 *     var and checks at runtime that none survived. The structure tests fail if another file starts claude, hands a
 *     claude spawn `...process.env`, or builds a Mac run env without macRunEnv.
 *  2. The env every declared file builds is checked at runtime here (no login var survives).
 *  3. A text scan still catches a login path coming back (split strings joined; .mts/.cts/.jsx included), with every
 *     excluded folder and every allowed file declared with its reason.
 */
const ROOT = path.resolve(__dirname, "../../..");
const SCAN = ["host", "app/src", "app/scripts", "app/walk", "app/look", "app/native", "app/motion", "app/perf", "app/build.mjs", "app/vite.config.ts", "shared/src", "box", "scripts"];
/** Not scanned, each with its reason. */
const NOT_SCANNED: Record<string, string> = {
  "node_modules": "third-party code (the CLI itself names every login form)",
  "dist": "build output of the scanned sources",
  "out": "build output of the scanned sources",
  "build": "build output of the scanned sources",
  ".build": "Swift build output of app/native",
  "host/test": "tests plant a Claude login on purpose, to prove it is never used (the perf probes that start a real claude are scanned by the structure tests below)",
  "app/test": "tests plant a Claude login on purpose, to prove it is never used",
  "app/e2e": "end-to-end specs (tests); they sign in with a stand-in API key",
  "app/phone-e2e": "end-to-end specs (tests)",
  "shared/test": "tests",
};
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|html|json|md|swift|py)$|^[^.]+$/;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walkFiles(roots: string[], skipTests = true): string[] {
  const out: string[] = [];
  const skip = (p: string) => Object.keys(NOT_SCANNED).some((k) => (k.includes("/") ? skipTests && rel(p) === k : path.basename(p) === k));
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && EXT.test(e.name) && fs.statSync(p).size < 2_000_000) out.push(p);
    }
  };
  for (const s of roots) {
    const p = path.join(ROOT, s);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p); else out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
/** Joins a string split across a concatenation ("CLAUDE_CODE_" + "OAUTH", 'a' + `b`) so the scan sees it whole. */
const joined = (t: string) => t.replace(/["'`]\s*\+\s*["'`]/g, "");

// ---------- 1. structure ----------
/** The helper modules: the only files that start claude or build a claude env. */
const HOST_HELPER = "host/claude/spawn.ts";
const MAC_HELPER = "app/src/coordinator/local-exec/login-scrub.ts";
const SHARED_HELPER = "shared/src/claude-env.ts";
/** The perf probes start a real claude by hand (RUN_CLAUDE / PROMPT_BUDGET_PROBE): they are held to the same rule. */
const PROBES = fs.readdirSync(path.join(ROOT, "host/test/perf")).filter((f) => /\.probe\.test\.ts$/.test(f)).map((f) => `host/test/perf/${f}`);
const codeFiles = () => [...walkFiles(SCAN).filter((f) => CODE.test(f)), ...PROBES.map((p) => path.join(ROOT, p))];

/** A child-process start (or a dev tool's runner) whose command is claude. */
const STARTS_CLAUDE = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|run)\(\s*(?:["'`]claude(?:["'`]|\s)|process\.env\.CLAUDE_BIN|[\w.]+\s*\?\?\s*["'`]claude["'`])/;
/** Starting the CLI from a spawn hook's command (the SDK's spawnClaudeCodeProcess shape). */
const SPAWNS_HOOK = /\bspawn\(\s*o\.command\b/;
/** A direct SDK query() call (anything but startClaudeQuery handing it the query function). */
const DIRECT_QUERY = /(?<![\w.])(?:query|sdkQuery)\(\s*\{/;
const SPREADS_PROCESS_ENV = /\.\.\.\s*\(?\s*process\.env\b/;

describe("S6 structure: one helper starts every claude", () => {
  const files = codeFiles();
  const text = new Map(files.map((f) => [f, joined(fs.readFileSync(f, "utf8"))]));

  it("the structure patterns recognise what they must", () => {
    for (const t of [`spawn("claude", ["-p"])`, `execFile(executable ?? "claude", ["--version"])`, `run(process.env.CLAUDE_BIN ?? "claude", args)`, "execSync(`claude -p hi`)"]) expect(STARTS_CLAUDE.test(t), t).toBe(true);
    expect(SPAWNS_HOOK.test("const c = spawn(o.command, o.args, { env: o.env })")).toBe(true);
    for (const t of ["const q = query({ prompt, options })", "sdkQuery({ prompt })"]) expect(DIRECT_QUERY.test(t), t).toBe(true);
    expect(DIRECT_QUERY.test("startClaudeQuery({ prompt }, query)")).toBe(false);
    for (const t of ["env: { ...process.env, X: 1 }", "{ ...(process.env as Record<string, string>) }"]) expect(SPREADS_PROCESS_ENV.test(t), t).toBe(true);
  });

  it("only the host helper starts a claude process (by command or from a spawn hook)", () => {
    const bad = files.filter((f) => rel(f) !== HOST_HELPER && (STARTS_CLAUDE.test(text.get(f)!) || SPAWNS_HOOK.test(text.get(f)!))).map(rel);
    expect(bad).toEqual([]);
  });

  it("nothing calls the SDK's query() directly: it goes through startClaudeQuery (metered-query.ts and the probes)", () => {
    const bad = files.filter((f) => DIRECT_QUERY.test(text.get(f)!)).map(rel);
    expect(bad).toEqual([]);
    for (const f of ["host/usage/metered-query.ts", ...PROBES]) expect(text.get(path.join(ROOT, f)), f).toMatch(/startClaudeQuery\(/);
  });

  it("no file that starts claude hands it ...process.env", () => {
    const starters = files.filter((f) => /startClaudeQuery\(|spawnClaudeProcess\(|runClaudeCli\(|claudeVersion\(|macRunEnv\(/.test(text.get(f)!) || [HOST_HELPER, MAC_HELPER, SHARED_HELPER].includes(rel(f)));
    expect(starters.length).toBeGreaterThan(4);
    const bad = starters.filter((f) => SPREADS_PROCESS_ENV.test(text.get(f)!)).map(rel);
    expect(bad).toEqual([]);
  });

  it("the Mac executor builds every run env with macRunEnv (never process.env or a hand-made env)", () => {
    const ex = text.get(path.join(ROOT, "app/src/coordinator/local-exec/executor.ts"))!;
    expect(ex).toMatch(/macRunEnv\(/);
    expect(ex).not.toMatch(SPREADS_PROCESS_ENV);
    for (const m of ex.matchAll(/\bspawn\([^)]*?\{\s*cwd[^}]*\benv:\s*([\w.]+)/g)) expect(["runEnv"], `spawn env ${m[1]}`).toContain(m[1]);
  });

  it("the helpers check at runtime: the shared builder and both spawn helpers call assertNoClaudeLogin", () => {
    for (const f of [SHARED_HELPER, HOST_HELPER, MAC_HELPER]) expect(text.get(path.join(ROOT, f)), f).toMatch(/assertNoClaudeLogin\(/);
  });
});

// ---------- 1b. no child inherits or copies process.env as is (review round 3, finding 2) ----------
/**
 * In any code file that mentions claude, a child process never gets the app's own env untouched: not by
 * `env: process.env`, not by `Object.assign({}, process.env)`, and not by leaving `env` out of a spawn/exec call (the
 * child then inherits process.env). Each such call passes an explicit env (scrubClaudeLogin, claudeEnv, macExecEnv,
 * macRunEnv, ...). Only the declared helper files are exempt, each with its reason.
 */
const ENV_EXEMPT: Record<string, string> = {
  [SHARED_HELPER]: "the one claude env builder: every login var is deleted and the result checked at runtime",
  [HOST_HELPER]: "the host's claude spawn helper: its env comes from claudeEnv and is checked by assertNoClaudeLogin before every start",
  [MAC_HELPER]: "macRunEnv: every Mac run env is built here over claudeEnv and checked at runtime",
};
const CHILD_CALLS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const CHILD_MODULES = /^(cp|child_process|childProcess|proc)$/;
const unwrap = (e: ts.Expression): ts.Expression => {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
};
const isProcessEnv = (e: ts.Expression): boolean => {
  const u = unwrap(e);
  return ts.isPropertyAccessExpression(u) && u.name.text === "env" && ts.isIdentifier(u.expression) && u.expression.text === "process";
};
const hasEnvKey = (o: ts.Expression): boolean => {
  const u = unwrap(o);
  return ts.isObjectLiteralExpression(u) && u.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === "env");
};
/** Env findings in one file's source: `env: process.env`, `Object.assign(x, process.env)`, a child call with no env. */
export function envFindings(src: string, name = "x.ts"): string[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const usesChild = /child_process/.test(src);
  const out: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "env" && isProcessEnv(n.initializer)) out.push(`${line(n)}: env: process.env`);
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c) && c.name.text === "assign" && c.expression.getText() === "Object" && n.arguments.some(isProcessEnv)) out.push(`${line(n)}: Object.assign(…, process.env)`);
      const callee = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && CHILD_MODULES.test(c.expression.text) ? c.name.text : null;
      if (usesChild && callee && CHILD_CALLS.has(callee) && !n.arguments.some(hasEnvKey)) out.push(`${line(n)}: ${callee}(…) with no env`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("S6 structure: no child process gets process.env as is (files that mention claude)", () => {
  it("the env checks recognise what they must", () => {
    const cp = 'import { spawn, execFile, execFileSync } from "node:child_process";\n';
    expect(envFindings(`${cp}spawn("x", [], { env: process.env });`)).toHaveLength(1);
    expect(envFindings(`${cp}spawn("x", [], { env: process.env as NodeJS.ProcessEnv });`)).toHaveLength(1);
    expect(envFindings(`${cp}const o = { env: process.env }; spawn("x", [], o);`)).toHaveLength(2);
    expect(envFindings(`const e = Object.assign({}, process.env);`)).toHaveLength(1);
    expect(envFindings(`${cp}execFile("tar", ["-x"], { cwd: "/" });`)).toEqual(["2: execFile(…) with no env"]);
    expect(envFindings(`${cp}execFileSync("git", ["init"]);`)).toHaveLength(1);
    expect(envFindings(`${cp}execFile("id", ["-u"], (err, out) => out);`)).toHaveLength(1);
    expect(envFindings(`${cp}spawn("x", [], { env: scrubClaudeLogin(process.env) }); spawn("y", [], { cwd, env });`)).toEqual([]);
    expect(envFindings(`const m = /a/.exec(s); re.exec(t);`)).toEqual([]);
  });

  it("every exemption is a declared helper with a reason", () => {
    for (const [f, why] of Object.entries(ENV_EXEMPT)) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
      expect(why.length, f).toBeGreaterThan(20);
    }
  });

  it("no file that mentions claude hands a child process.env (by value, by copy, or by leaving env out)", () => {
    const files = codeFiles().filter((f) => !ENV_EXEMPT[rel(f)]);
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (!/claude/i.test(src)) continue;
      for (const h of envFindings(src, f)) bad.push(`${rel(f)}:${h}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------- 2. the envs the declared files build (runtime) ----------
describe("S6 (d): every env the declared files build holds no login var", () => {
  const everyLogin = Object.fromEntries(CLAUDE_LOGIN_VARS.map((k) => [k, "planted"]));
  const KEY = "sk-ant-api03-" + "G".repeat(80) + "gard";

  it("the box: buildBotEnv, applyAuthEnv, prepareAuthEnv, explicitKeyEnv", async () => {
    const { applyAuthEnv, prepareAuthEnv, setAuthProxy, setAuthSource } = await import("../../auth/auth-env");
    const { buildBotEnv } = await import("../../brain/spawn-options");
    const { explicitKeyEnv } = await import("../../auth/dev-auth");
    const { tmpConfig } = await import("../helpers");
    try {
      const shell = buildBotEnv({ cfg: tmpConfig(), botId: "b1", secrets: {} });
      assertNoClaudeLogin(shell, { apiKey: shell.ANTHROPIC_API_KEY });
      setAuthSource({ apiKey: () => KEY });
      assertNoClaudeLogin(applyAuthEnv<Record<string, string | undefined>>({ ...everyLogin })!, { apiKey: KEY });
      setAuthProxy({ url: "http://127.0.0.1:1", issue: () => "sk-ant-api03-synproxy-g", revoke: () => {} });
      assertNoClaudeLogin(prepareAuthEnv<Record<string, string | undefined>>({ ...everyLogin }, { botId: null }).env!, { apiKey: "sk-ant-api03-synproxy-g" });
      assertNoClaudeLogin(explicitKeyEnv({ ...everyLogin, SYNAPSE_API_KEY: KEY }), { apiKey: KEY });
      assertNoClaudeLogin(explicitKeyEnv({ ...everyLogin }), { apiKey: "sk-ant-api03-synproxy-none" });
    } finally { setAuthProxy(null); setAuthSource(null); }
  });

  it("the Mac: macRunEnv with and without a grant", async () => {
    const { macRunEnv } = await import("../../../app/src/coordinator/local-exec/login-scrub");
    assertNoClaudeLogin(macRunEnv({ ...everyLogin, PATH: "/usr/bin" }, {}), { apiKey: "sk-ant-api03-synproxy-none" });
    assertNoClaudeLogin(macRunEnv({ ...everyLogin }, { grant: { token: "sk-ant-api03-macproxy-g", baseUrl: "http://127.0.0.1:2" } }), { apiKey: "sk-ant-api03-macproxy-g" });
  });
});

// ---------- 3. text ----------
type Pattern = "login-env" | "credentials-file" | "login-command" | "oat-token" | "subscription-ui" | "connect-claude" | "oauth-proxy" | "plan-usage" | "claude-ai-connectors";
const PATTERNS: Record<Pattern, [string, RegExp]> = {
  "login-env": ["a Claude login env var", /CLAUDE_CODE_OAUTH_\w+|CLAUDE_CODE_SUBSCRIPTION_TYPE|CLAUDE_CODE_RATE_LIMIT_TIER|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_(PROVIDER_MANAGED_BY_HOST|HOST_AUTH_ENV_VAR|HOST_CREDS_FILE|CUSTOM_OAUTH_URL|USE_BEDROCK|USE_VERTEX)|ANTHROPIC_CUSTOM_HEADERS/],
  "credentials-file": ["a stored claude.ai login file", /\.credentials\.json|claudeAiOauth/],
  "login-command": ["the `claude setup-token` / `claude auth login` / `/login` flow", /setup[-_]?token|setupToken|SetupToken|claude\s+auth\s+login|claude\s+\/login/],
  "oat-token": ["a Claude OAuth token literal", /sk-ant-oat/],
  "subscription-ui": ["a Claude subscription choice", /Claude subscription|modeSubscription|subscriptionConfigured|setAuthMode|AuthMode\b/],
  "connect-claude": ["\"Connect Claude\" / \"Claude for Bots\"", /Connect Claude|Claude for Bots/],
  "oauth-proxy": ["proxying a Claude login", /(?:BOTS|SYNAPSE)_AUTH_PROXY_OAUTH|sk-ant-oat01-synproxy|oauth-2025-04-20/],
  "plan-usage": ["the Claude plan's usage windows", /api\/oauth\/usage|subscriptionType|planUsage|fiveHourPct|sevenDayPct/],
  // A claude.ai connector (it comes with a Claude login): detected, listed, installed or polled. The reserved-name and
  // classification code that still recognises the claude_ai_ prefix defensively is fine.
  "claude-ai-connectors": ["claude.ai connectors", /claudeAiServers|CLAUDE_CONNECTORS_URL|claudeAiSection|claudeAiNeedsSubscription|claudeAiUnavailable|"claudeai"|claude-gmail|mcp__claude_ai_Gmail__search_threads|ENABLE_CLAUDEAI_MCP_SERVERS:\s*(?!\s|"false")/],
};

/** Files allowed to name a pattern, and why. Anything else that matches fails. */
const DECLARED: Record<string, { allow: Pattern[]; why: string }> = {
  "shared/src/claude-env.ts": { allow: ["login-env"], why: "CLAUDE_LOGIN_VARS: the one list every claude env is scrubbed of (box, Mac, dev tools)" },
  "host/auth/auth-env.ts": { allow: ["credentials-file"], why: "explains the sentinel: with an API key the CLI never reads a stored login" },
  "app/src/coordinator/local-exec/login-scrub.ts": { allow: ["credentials-file", "login-command"], why: "the Mac's friendly early refusal of login commands, and the removal of an app-owned stored login" },
  "app/src/coordinator/local-exec/executor.ts": { allow: ["credentials-file"], why: "the sandbox profile read-denies the stored login files" },
  "box/verify-box.sh": { allow: ["login-env", "credentials-file"], why: "checks that no process holds a login and no config dir stores one" },
  "box/files/retire-claude-login": { allow: ["credentials-file"], why: "removes a stored login from the app's own box accounts" },
};

describe("synapse-public: no Claude subscription or OAuth sign-in path in shipped code (text)", () => {
  const all = walkFiles(SCAN);
  const text = new Map(all.map((f) => [f, joined(fs.readFileSync(f, "utf8"))]));

  it("scans a real tree, bench, evals, walk and .md prompts included", () => {
    const names = all.map(rel);
    expect(all.length).toBeGreaterThan(300);
    for (const must of ["host/auth/auth-env.ts", "host/claude/spawn.ts", "host/bench/coding/cli.ts", "host/evals/routing/real-sdk.ts", "host/prompts/sections/plugins.md", "box/provision.sh", "scripts/tmp-hygiene.ts"]) expect(names).toContain(must);
    expect(names.some((n) => n.startsWith("app/walk/"))).toBe(true);
    for (const d of Object.keys(DECLARED)) expect(names, `declared file ${d} exists and is scanned`).toContain(d);
  });

  for (const [id, [what, re]] of Object.entries(PATTERNS) as [Pattern, [string, RegExp]][]) {
    it(`no ${what} outside the declared files`, () => {
      const hits = all.filter((f) => !DECLARED[rel(f)]?.allow.includes(id) && re.test(text.get(f)!)).map(rel);
      expect(hits).toEqual([]);
    });
  }

  it("catches a split string", () => {
    expect(PATTERNS["login-env"][1].test(joined(`const k = "CLAUDE_CODE_" + "OAUTH_TOKEN";`))).toBe(true);
    expect(PATTERNS["oat-token"][1].test(joined("'sk-ant-' + `oat01-x`"))).toBe(true);
  });

  it("the shared list names every login form, and both scrub lists are it", async () => {
    const { CLAUDE_AUTH_SCRUB } = await import("../../auth/auth-env");
    const { MAC_LOGIN_SCRUB } = await import("../../../app/src/coordinator/local-exec/login-scrub");
    expect(CLAUDE_AUTH_SCRUB).toBe(CLAUDE_LOGIN_VARS);
    expect(MAC_LOGIN_SCRUB).toBe(CLAUDE_LOGIN_VARS);
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_CUSTOM_HEADERS"]) {
      expect(CLAUDE_LOGIN_VARS as readonly string[], k).toContain(k);
    }
  });
});
