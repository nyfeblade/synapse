/** Types for release-lib.mjs (npm run release). */
export interface LocalReleaseManifest { name: string; version: string; zip: string; sha256: string; sig: string; bytes: number; hostBuild: string | null; requirement: string; createdAt: number }
export function releaseArtifacts(version: string): { zip: string; dmg: string; tag: string };
export function parseRequirement(text: string): string;
export function assertSignedForUpdates(requirement: string): void;
export function assertPrivateRepo(visibility: string): void;
export function writeLocalRelease(o: { zip: string; name: string; version: string; hostBuild: string | null; requirement: string; dir: string; sig: string; now?: () => number; keep?: number }): LocalReleaseManifest;
