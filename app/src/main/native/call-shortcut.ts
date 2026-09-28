import { STRV } from "@synapse/shared";
import { registerNative } from "../native";

/**
 * Bug 134 (item 9): call from anywhere. A global shortcut (⌥⌘C by default, configurable in Settings →
 * Voice, or off) calls the Bot whose chat is open; the menu bar's Call menu (and the wake word's
 * menu-bar item) lists the Bots to call. Main only relays the choice; the renderer places the call.
 */

export const DEFAULT_CALL_SHORTCUT = "Alt+CommandOrControl+C";
const MODS = new Set(["Command", "Cmd", "CommandOrControl", "CmdOrCtrl", "Control", "Ctrl", "Alt", "Option", "Shift", "Super"]);
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|[`\-=[\];',./\\])$/;

/** An Electron accelerator with at least one of ⌘ / ⌥ / ⌃ and exactly one key ("Alt+CommandOrControl+C"). */
export function validCallShortcut(a: unknown): a is string {
  if (typeof a !== "string" || a.length > 60) return false;
  const parts = a.split("+");
  const key = parts.pop() ?? "";
  if (!parts.length || !parts.every((p) => MODS.has(p)) || new Set(parts).size !== parts.length) return false;
  if (!parts.some((p) => p !== "Shift")) return false;
  return KEY.test(key);
}

interface Shortcuts { register(accel: string, fn: () => void): boolean; unregister(accel: string): void }

export function registerCallShortcut(o: { shortcuts: Shortcuts; read(): string | null | undefined; write(a: string | null): void; onFire(): void; log?: (line: string) => void }): { current(): string | null } {
  let current: string | null = null;
  const apply = (a: string | null): boolean => {
    if (current) o.shortcuts.unregister(current);
    current = null;
    if (!a) return true;
    let ok = false;
    try { ok = o.shortcuts.register(a, o.onFire); } catch { ok = false; }
    if (ok) current = a;
    return ok;
  };
  const saved = o.read();
  const first = saved === undefined ? DEFAULT_CALL_SHORTCUT : saved;
  if (first && validCallShortcut(first) && !apply(first)) o.log?.(`call shortcut ${first} is taken by another app; none set`);
  registerNative("calls.shortcut.get", () => ({ accelerator: current, saved: saved === undefined ? DEFAULT_CALL_SHORTCUT : saved }));
  registerNative("calls.shortcut.set", (a: { accelerator?: unknown }) => {
    const next = a?.accelerator ?? null;
    if (next !== null && !validCallShortcut(next)) throw new Error(STRV.callShortcutInvalid);
    const before = current;
    if (!apply(next as string | null)) {
      apply(before); // keep the one that worked
      throw new Error(STRV.callShortcutTaken);
    }
    o.write(next as string | null);
    return { accelerator: current };
  });
  return { current: () => current };
}

/** The menu bar's Call menu: one item per Bot (the first 20, the renderer's order), or a disabled line. */
export function callMenuItems(bots: { id: string; name: string }[], onCall: (botId: string) => void): { label: string; enabled?: boolean; click?: () => void }[] {
  if (!bots.length) return [{ label: "No Bots yet", enabled: false }];
  return bots.slice(0, 20).map((b) => ({ label: STRV.callBot(b.name), click: () => onCall(b.id) }));
}
