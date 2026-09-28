/** Types for kokoro-runtime.mjs (the bundled Kokoro runtime; scripts/package.mjs runs it as plain ESM). */
export const KOKORO_RESOURCE: string;
export const PYTHON_REL: string;
export const MODEL_REL: string;
export function cacheRoot(repoRoot: string, env?: Record<string, string | undefined>): string;
export function sha256File(file: string): string;
export function runtimeKey(lockText: string, reqsText: string): string;
export function fetchVerified(url: string, dest: string, sha256: string, log?: (line: string) => void): string;
export function trimRuntime(py: string): void;
export function treeHash(dir: string): string;
export function sealCachedRuntime(dir: string): void;
export function cachedRuntimeIntact(dir: string): boolean;
export function symlinksUnder(dir: string): string[];
export function probeRuntime(kokoroDir: string): void;
export function stageKokoro(repoRoot: string, destDir: string, o?: { log?: (line: string) => void }): string;
export function speak(kokoroDir: string, out: string, text?: string, o?: { server?: string }): Promise<{ rms: number; seconds: number }>;
