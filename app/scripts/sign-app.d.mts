/** Types for sign-app.mjs, which scripts/package.mjs runs as plain ESM at build time. */
export const APP_IDENTIFIER: string;
export function chooseSigningIdentity(o?: {
  env?: Record<string, string | undefined>;
  find?: () => string | null;
  warn?: (message: string) => void;
}): { identity: string; adhoc: boolean };
export function preflightSigning(identity: string, run?: (file: string) => void): void;
export function signApp(app: string, o: { identity: string; entitlements: string; run?: (args: string[]) => void }): string;
