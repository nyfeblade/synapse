/** Types for signing-identity.mjs (bug 99: the stable local code-signing identity). */
export const IDENTITY_NAME: string;
export function parseIdentityHash(findIdentityOutput: string, name?: string): string | null;
export function findIdentity(name?: string): string | null;
export function ensureIdentity(name?: string): string;
