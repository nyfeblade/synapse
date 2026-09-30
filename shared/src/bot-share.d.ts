export interface ShareTool { catalogId: string; name: string }
export interface ShareSkill { id: string; name: string; description: string; files: Record<string, string> }
export interface SharePayload { v: 1; name: string; title: string; instructions: string; shape: string; color: string; model?: string; tools: ShareTool[]; skills: ShareSkill[] }
export type ShareFailureCode = "damaged" | "too-long" | "newer";
export type ShareResult = { ok: true; payload: SharePayload; hiddenRemoved: boolean } | { ok: false; code: ShareFailureCode; message: string; payload?: undefined };
export interface ShareFlag { field: string; kind: "injection" }

export const SHARE_VERSION: 1;
export const SHARE_SITE: string;
export const SHARE_LIMITS: Readonly<{ linkMaxChars: number; decodeMaxChars: number; inflateMaxBytes: number; name: number; title: number; instructions: number; tools: number; skills: number; skillFiles: number; skillFileChars: number; skillDescription: number; catalogId: number; blurb: number }>;
export const SHARE_MESSAGES: Readonly<{ damaged: string; "too-long": string; newer: string; "too-big": string }>;
export const SHARE_MODELS: readonly string[];
export const SHARE_SHAPES: readonly string[];

export function validateShare(x: unknown): ShareResult;
export function scanShare(payload: SharePayload): { payload: SharePayload; hiddenRemoved: boolean; flags: ShareFlag[] };
export function runsCode(files: Record<string, string> | null | undefined): boolean;
export function canonicalJson(payload: SharePayload): string;
export function encodeShareRaw(payload: unknown): Promise<string>;
export function encodeShare(payload: unknown): Promise<string>;
export function decodeShare(input: unknown): Promise<ShareResult>;
export function fragmentOf(input: unknown): string | null;
export function shareLinks(fragment: string, site?: string): { web: string; app: string };
export function shareHash(payload: SharePayload): Promise<string>;
export function botpackFiles(payload: SharePayload, id: string, now?: number): Record<string, string>;
export function zipStore(files: Record<string, string | Uint8Array>): Uint8Array;
