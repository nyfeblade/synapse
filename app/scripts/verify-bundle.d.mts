/** Types for verify-bundle.mjs, which scripts/package.mjs runs as plain ESM at build time. */
export interface AsarEntry { path: string; unpacked?: boolean }

export const RUNTIME_PATHS: readonly string[];
export const EXECUTABLE_PATHS: readonly string[];
export const REQUIRED_ASAR_PACKAGES: readonly string[];
export const BUNDLED_VOICES: readonly string[];
export const MIN_MACOS: string;

export function forbiddenAsarEntries(entries: readonly AsarEntry[]): string[];
export function packedNativeEntries(entries: readonly AsarEntry[]): string[];
export function missingRuntimePaths(app: string, exists: (p: string) => boolean): string[];
export function verifyBundle(o: {
  app: string;
  asarEntries: () => readonly AsarEntry[];
  exists?: (p: string) => boolean;
  isExecutable?: (p: string) => boolean;
  resourceFiles?: () => readonly string[];
}): string[];
export function asarEntriesFrom(header: unknown): AsarEntry[];
export function machOFiles(dir: string, o?: { readMagic?: (file: string) => string }): string[];
export function unsignedMachO(files: readonly string[], o: { authority: string; adhoc?: boolean; verify(file: string): unknown; describe(file: string): string }): string[];
export function parseMinos(text: string): string | null;
export function versionLE(a: string, b: string): boolean;
export function helperProblems(o: { helpers: readonly string[]; showBuild(helper: string): string; dictation?: string; hasWhisper(helper: string): boolean }): string[];
export function builderPathLeaks(files: readonly string[], read?: (file: string) => Buffer): string[];
