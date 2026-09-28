import { execFile, spawn as nodeSpawn } from "node:child_process";
import type { Options, Query, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { SENTINEL_API_KEY, assertNoClaudeLogin, claudeEnv } from "@synapse/shared";

/**
 * Review round 3 (S6): the ONLY place the host starts claude, the Agent SDK's query() included. Every env that reaches
 * a claude process is checked here at runtime (assertNoClaudeLogin: no login var but the one API key it was given), so
 * a code path that adds a login back fails loudly instead of signing in. The SDK's query() itself is imported only by
 * usage/metered-query.ts (the metering guard), which starts every query through startClaudeQuery here. A guard test
 * (host/test/auth/no-subscription-guard.test.ts) fails if any other file starts claude.
 */

type Env = Record<string, string | undefined>;
type QueryParams = { prompt: unknown; options?: Options };
type AnyQueryFn = (p: never) => Query;

/**
 * The final check on an env about to start claude: returns it unchanged, or throws ClaudeLoginEnvError naming the
 * variable (never its value). `apiKey`: the one key this spawn may carry (null = the dead sentinel or none).
 */
export function claudeSpawnEnv<E extends Env>(env: E, o: { apiKey: string | null }): E {
  assertNoClaudeLogin(env, { apiKey: o.apiKey ?? SENTINEL_API_KEY });
  return env;
}

/**
 * query(), with its env checked. An absent env would make the SDK hand the CLI this process's own env: it gets the
 * dead sentinel instead (claudeEnv with no key), so nothing inherited can sign in.
 */
export function startClaudeQuery<F extends AnyQueryFn>(params: QueryParams, queryFn: F): Query {
  const env = params.options?.env as Env | undefined;
  const checked = env === undefined ? claudeEnv(process.env as Env, { apiKey: null }) : claudeSpawnEnv(env, { apiKey: env.ANTHROPIC_API_KEY ?? null });
  const next = env === undefined ? { ...params, options: { ...params.options, env: checked } } : params;
  return queryFn(next as never);
}

/**
 * The SDK's spawnClaudeCodeProcess, for callers that start the CLI themselves (ClaudeBrain, conformance probes). The SDK
 * builds the child env from our options.env and adds its own sdk-… entrypoint marker; that value alone is allowed here.
 */
export function spawnClaudeProcess(o: SpawnOptions, d: { apiKey?: string | null; spawnFn?: typeof nodeSpawn; onStderr?: (line: string) => void; drainStderr?: boolean } = {}): SpawnedProcess {
  const env = o.env as Env;
  assertNoClaudeLogin(env, { apiKey: d.apiKey ?? env.ANTHROPIC_API_KEY, sdkEntrypoint: true });
  const child = (d.spawnFn ?? nodeSpawn)(o.command, o.args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, signal: o.signal, stdio: ["pipe", "pipe", "pipe"], detached: true });
  if (d.onStderr) child.stderr?.on("data", (b: Buffer) => d.onStderr!(b.toString()));
  else if (d.drainStderr) child.stderr?.resume();
  return child as unknown as SpawnedProcess;
}

/** `claude --version` (conformance's CLI version probe): no model call, still never with an inherited login. */
export function claudeVersion(executable?: string): Promise<string | null> {
  const env = claudeEnv(process.env as Env, { apiKey: null });
  return new Promise((resolve) => {
    execFile(executable ?? "claude", ["--version"], { timeout: 20_000, env }, (err, stdout) => {
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(err || !m ? null : (m[1] as string));
    });
  });
}

/**
 * A headless `claude -p` for a dev tool (the coding bench's CLI baseline), started with the runner the tool uses for
 * its other processes. `env` must come from explicitKeyEnv (an explicit key, else the sentinel); it is checked here.
 */
export function runClaudeCli<R>(args: string[], o: { env: Record<string, string>; bin?: string }, run: (cmd: string, args: string[], env: Record<string, string>) => R): R {
  return run(o.bin ?? "claude", args, claudeSpawnEnv(o.env, { apiKey: o.env.ANTHROPIC_API_KEY ?? null }));
}
