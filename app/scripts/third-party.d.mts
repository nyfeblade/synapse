/** Types for third-party.mjs (the package list in THIRD-PARTY-NOTICES.txt). */
export const NOTICES: string;
export function hostExternals(repoRoot: string): string[];
export function bundledPackages(repoRoot: string): { app: Map<string, string>; mcp: Map<string, string>; host: Map<string, string>; box: Map<string, string> };
export function renderPackageList(pkgs: { app: Map<string, string>; mcp: Map<string, string>; host: Map<string, string>; box: Map<string, string> }): string;
export const MCP_HELPER: string[];
