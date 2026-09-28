/** Types for gpl-sources.mjs (the GPL-3.0 source archives attached to every release). */
export interface GplSource { name: string; version: string; bundledBy: string; commit?: string; asset: string; url: string; sha256: string }
export const GPL_SOURCES_FILE: string;
export function gplSources(file?: string): GplSource[];
export function gplSourcesDir(repoRoot?: string, env?: Record<string, string | undefined>): string;
export function fetchGplSources(dir: string, o?: { fetch?: (url: string, dest: string, sha256: string, log?: (line: string) => void) => string; log?: (line: string) => void }): string[];
