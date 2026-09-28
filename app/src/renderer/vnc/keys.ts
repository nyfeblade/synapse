import type { RfbLike } from "./rfb";

const XK_CONTROL_L = 0xffe3;

/** CMP-09: Cmd+A/C/V/X/Z on the Mac becomes Ctrl+… on the Linux screen. */
export function isMacChord(e: { metaKey: boolean; key: string }): string | null {
  const k = e.key.toLowerCase();
  return e.metaKey && ["a", "c", "v", "x", "z"].includes(k) ? k : null;
}

export function ctrlChord(rfb: RfbLike, letter: string): void {
  const sym = letter.charCodeAt(0);
  const code = `Key${letter.toUpperCase()}`;
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  rfb.sendKey(sym, code, true);
  rfb.sendKey(sym, code, false);
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
}
