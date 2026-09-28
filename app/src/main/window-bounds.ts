/** A display rectangle in Electron's screen coordinates. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Never turn this on. simpleFullScreen covers the Dock and menu-bar hover strips, which is the
 * Mac contract we are matching (UI-01 hidden-inset). Maximize fills workArea instead.
 */
export const SIMPLE_FULL_SCREEN = false;

/** The rectangle a zoomed/maximized window must occupy — the display's workArea, never bounds. */
export function maximizeRect(workArea: ScreenRect): ScreenRect {
  return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

/** Clip a proposed window rectangle so it cannot sit on the Dock or menu-bar hotspots. */
export function clampRectToWorkArea(rect: ScreenRect, workArea: ScreenRect): ScreenRect {
  const x = Math.max(rect.x, workArea.x);
  const y = Math.max(rect.y, workArea.y);
  const right = Math.min(rect.x + rect.width, workArea.x + workArea.width);
  const bottom = Math.min(rect.y + rect.height, workArea.y + workArea.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
