export interface PersonalFound { key: number; email: number; card: number; ssn: number; phone: number; address: number }
export function stripHidden(input: unknown): { text: string; removed: boolean };
export function redactPersonal(input: unknown): { text: string; found: PersonalFound };
export function describeHidden(found: Partial<PersonalFound> | null | undefined): string;
export function cleanMessage(input: unknown): { text: string; hiddenRemoved: boolean; found: PersonalFound };
export function isAbusive(text: unknown): boolean;
export function maskAbuse(title: unknown): string;
export function spamSignals(text: unknown): string[];
export function isSpam(text: unknown, extra?: string[]): boolean;
export function spamReason(text: unknown): string;
export function looksLikeInjection(text: unknown): boolean;
export function dropLinks(s: unknown): string;
export function cleanReply(s: unknown): string;
