/** Small JSON-shape helpers shared by the trigger adapters (github.ts, slack.ts, adapters.ts). */
export type O = Record<string, unknown>;
export const obj = (x: unknown): O => (x && typeof x === "object" ? (x as O) : {});
export const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
