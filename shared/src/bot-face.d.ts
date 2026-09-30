export const FORM_SPECS: Record<"pebble" | "orb" | "tile" | "capsule" | "dome" | "gem", { a: number; b: number; n: number; cy: number; nLow?: number; bLow?: number }>;
export const FORM_OF: Record<string, string>;
export const EYE_INK: string;
export function formPath(form: string, N?: number): string;
export function botSvg(shape: string, color: string, cls?: string): string;
export function botDefs(): string;
export function botNode(doc: Document, shape: string, color: string, cls?: string): SVGSVGElement;
