import { LIMITSC, catalogModel, parseProviderModelRef, type ScreenView } from "@synapse/shared";
import { quirksFor } from "../brain/provider/adapters/quirks";

/**
 * The one place coordinates are scaled (provider-neutral computer tools). The display is always 1280×800. A model sees
 * the screen at `view` size: its screenshots are taken at that size, and every coordinate it sends is in that space and
 * is mapped back to the display here, so a click lands where the model saw the thing it clicked.
 *
 * Claude, and every provider that doesn't shrink a 1280×800 image, sees the display 1:1.
 */
export const NATIVE_VIEW: ScreenView = { w: LIMITSC.displayWidth, h: LIMITSC.displayHeight };

export function screenViewFor(modelRef: string): ScreenView {
  const p = parseProviderModelRef(modelRef);
  const max = p ? quirksFor(p.provider).imageShortSideMax : undefined;
  const short = Math.min(NATIVE_VIEW.w, NATIVE_VIEW.h);
  if (!max || short <= max) return NATIVE_VIEW;
  const k = max / short;
  return { w: Math.round(NATIVE_VIEW.w * k), h: Math.round(NATIVE_VIEW.h * k) };
}

export const isNative = (v: ScreenView): boolean => v.w === NATIVE_VIEW.w && v.h === NATIVE_VIEW.h;

const clamp = (n: number, max: number) => Math.max(0, Math.min(max - 1, n));

/** A point the model gave (in its view) → the display. */
export function toScreen(v: ScreenView, x: number, y: number): { x: number; y: number } {
  if (isNative(v)) return { x, y };
  return { x: clamp(Math.round((x * NATIVE_VIEW.w) / v.w), NATIVE_VIEW.w), y: clamp(Math.round((y * NATIVE_VIEW.h) / v.h), NATIVE_VIEW.h) };
}

/** A display point (the pointer, an element's centre) → the model's view. */
export function toView(v: ScreenView, x: number, y: number): { x: number; y: number } {
  if (isNative(v)) return { x, y };
  return { x: clamp(Math.round((x * v.w) / NATIVE_VIEW.w), v.w), y: clamp(Math.round((y * v.h) / NATIVE_VIEW.h), v.h) };
}

/**
 * Whether a model reads the images a tool returns (a screenshot). Claude does. A provider model: what conformance
 * measured (PC-09 image in a tool result, else PC-08 image in), else the catalog's word; an unknown model is treated as
 * text-only, since an image sent to a model that can't read it fails the call, while text reads work on every model.
 */
export function seesImagesFor(modelRef: string, measured: { toolImages: boolean | null; vision: boolean | null } | null): boolean {
  const p = parseProviderModelRef(modelRef);
  if (!p) return true;
  if (quirksFor(p.provider).toolImages === "none") return false;
  if (typeof measured?.toolImages === "boolean") return measured.toolImages;
  if (measured?.vision === false) return false;
  return catalogModel(modelRef)?.vision ?? false;
}
