const ENTRY_ID = /^t(?:\d+u(?:a\d+)?|(?:\d+|b)[as]\d+)$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEntryId(id: string): boolean {
  return ENTRY_ID.test(id);
}
export function userEntryId(n: number): string {
  return `t${n}u`;
}
export function sendEntryId(turn: number | "b", k: number): string {
  return `t${turn}s${k}`;
}
export function activityEntryId(turn: number | "b", k: number): string {
  return `t${turn}a${k}`;
}
export function isSafeFolderId(id: string): boolean {
  return id.length > 0 && id === id.trim() && id !== "." && id !== ".." && !/[/\\\u0000]/.test(id);
}
