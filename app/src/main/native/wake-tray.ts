import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron";
import { STRV } from "@synapse/shared";
import { wakeStatusText, type WakeState } from "./wake-word";

/**
 * The honest microphone indicator for the wake word: a menu-bar item that exists only while the wake
 * word is turned on. A solid microphone = listening now; a faint one = paused (the menu says why).
 * macOS's own orange dot shows as well whenever the helper has the microphone open.
 */
export function micGlyph(px: number, solid: boolean): Buffer {
  const buf = Buffer.alloc(px * px * 4); // BGRA; a template image only uses alpha
  const s = px / 16;
  const alpha = solid ? 255 : 110;
  const inside = (x: number, y: number): boolean => {
    // capsule: x 5.5–10.5, y 1.5–10.5, radius 2.5
    const cx = 8, r = 2.5;
    const cy = Math.min(Math.max(y, 4), 8);
    if (Math.hypot(x - cx, y - cy) <= r) return true;
    // the cradle: a ring of radius 4.5–5.7 around (8, 8), lower half only
    const d = Math.hypot(x - 8, y - 8);
    if (y >= 8 && d >= 4.4 && d <= 5.6) return true;
    // stem and base
    if (x >= 7.4 && x <= 8.6 && y >= 13.4 && y <= 15) return true;
    if (x >= 5.5 && x <= 10.5 && y >= 14.2 && y <= 15.2) return true;
    return false;
  };
  for (let py = 0; py < px; py++) {
    for (let pxx = 0; pxx < px; pxx++) {
      // 2×2 supersampling for smooth edges
      let hits = 0;
      for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) if (inside((pxx + ox) / s, (py + oy) / s)) hits += 1;
      if (!hits) continue;
      const i = (py * px + pxx) * 4;
      buf[i + 3] = Math.round((alpha * hits) / 4);
    }
  }
  return buf;
}

function icon(solid: boolean): NativeImage {
  const img = nativeImage.createFromBitmap(micGlyph(16, solid), { width: 16, height: 16, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: 16, height: 16, buffer: micGlyph(32, solid) });
  img.setTemplateImage(true);
  return img;
}

export function createWakeTray(o: { pause(on: boolean): void; turnOff(): void; openSettings(): void; callItems?(): MenuItemConstructorOptions[] }): { update(s: WakeState): void; refresh(): void; dispose(): void } {
  let tray: Tray | null = null;
  let solid: boolean | null = null;
  let last: WakeState | null = null;
  return {
    refresh() { if (last) this.update(last); },
    update(s) {
      last = s;
      if (!s.enabled) { tray?.destroy(); tray = null; solid = null; return; }
      if (!tray) tray = new Tray(icon(s.listening));
      else if (solid !== s.listening) tray.setImage(icon(s.listening));
      solid = s.listening;
      const text = wakeStatusText(s);
      tray.setToolTip(`Synapse: ${text}`);
      const userPaused = s.pausedFor.includes("user");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: text, enabled: false },
        { type: "separator" },
        { label: userPaused ? "Resume listening" : "Pause listening", click: () => o.pause(!userPaused) },
        { label: "Turn off “Hey” + Bot name", click: () => o.turnOff() },
        { label: "Voice settings…", click: () => o.openSettings() },
        // Bug 134: call from anywhere.
        ...(o.callItems?.().length ? [{ type: "separator" as const }, { label: STRV.trayCall, submenu: o.callItems() }] : []),
      ]));
    },
    dispose() { tray?.destroy(); tray = null; },
  };
}
