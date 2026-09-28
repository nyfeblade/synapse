import { LOOK_LIMITS } from "@synapse/shared";

/**
 * Screen share on a call. Not a video stream: while the user shares, a still of the screen goes only
 * when the user asks the Bot to look, or the Bot asks (SendMessage call: "look"). Pure (Electron is injected) so it is unit-tested;
 * index.ts plugs in systemPreferences, screen and desktopCapturer.
 *
 * macOS gates this behind Screen & System Audio Recording. Without it desktopCapturer still answers,
 * but with an empty (or wallpaper-only) image, so the status is checked first and an empty image is
 * treated as "no permission" too. The error text is a code the renderer turns into plain words.
 */

/**
 * The longest side of the still sent to the Bot (the spec's LOOK_LIMITS): enough to read UI text.
 * Image tokens ≈ w·h/750 and Sonnet 5 / Opus 5 don't downscale below 2576 px, so the size is the
 * cost: 1280×831 ≈ 1,420 tokens a frame, vs ≈ 2,220 at 1600×1039.
 */
export const SHARE_MAX_SIDE = LOOK_LIMITS.maxEdge;
export const SHARE_JPEG_QUALITY = LOOK_LIMITS.jpegQuality;
/** Image tokens for a w×h still (Anthropic's vision formula; no server resize at these sizes). */
export const imageTokens = (w: number, h: number): number => Math.ceil((w * h) / 750);

export interface ShareImage { isEmpty(): boolean; getSize(): { width: number; height: number }; toJPEG(quality: number): Buffer }
export interface ShareSource { display_id: string; thumbnail: ShareImage }
export interface ScreenDeps {
  status(): string;
  primary(): { id: number; size: { width: number; height: number }; scaleFactor: number };
  sources(o: { types: ["screen"]; thumbnailSize: { width: number; height: number } }): Promise<ShareSource[]>;
}
export interface ScreenStill { jpegBase64: string; width: number; height: number; bytes: number; tokens: number }

/** The thumbnail size that keeps the display's aspect with its longest side at most `max` pixels. */
export function fitSize(size: { width: number; height: number }, scale: number, max = SHARE_MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export async function captureScreen(d: ScreenDeps): Promise<ScreenStill> {
  const status = d.status();
  if (status === "denied" || status === "restricted") throw new Error(`permission:screen:${status}`);
  const p = d.primary();
  const list = await d.sources({ types: ["screen"], thumbnailSize: fitSize(p.size, p.scaleFactor) });
  const src = list.find((s) => s.display_id === String(p.id)) ?? list[0];
  // "not-determined" + an empty image = the user hasn't allowed it (the prompt, if any, just showed).
  if (!src || src.thumbnail.isEmpty()) throw new Error("permission:screen:denied");
  const jpeg = src.thumbnail.toJPEG(SHARE_JPEG_QUALITY);
  const { width, height } = src.thumbnail.getSize();
  return { jpegBase64: jpeg.toString("base64"), width, height, bytes: jpeg.length, tokens: imageTokens(width, height) };
}
