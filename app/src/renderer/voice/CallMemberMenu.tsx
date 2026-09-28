import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { STR5 } from "@synapse/shared";
import { Menu } from "../components/Menus";

/**
 * Bug 158: "Remove from call" for ONE Bot, in one place so the call screen's avatar row and the mini
 * pill behave identically. Opened by right-click, by a long press (touch / pen) and by the keyboard's
 * own menu gesture (the ContextMenu key or Shift+F10), on top of the × the avatar shows on hover.
 * The Bot the call started with never gets a menu: its avatar carries the reason as a tooltip instead.
 */
export const LONG_PRESS_MS = 500;

export interface MemberMenu {
  /** Spread onto the Bot's avatar; `{}` for the call's own Bot, which can't be removed. */
  triggerProps(bot: { id: string; name: string }, removable: boolean): Record<string, unknown>;
  /** Rendered once, next to the row. */
  element: ReactNode;
}

export function useCallMemberMenu(remove: (botId: string) => void): MemberMenu {
  const [menu, setMenu] = useState<{ botId: string; name: string; x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  const open = (botId: string, name: string, x: number, y: number) => { clear(); setMenu({ botId, name, x, y }); };
  return {
    triggerProps(bot, removable) {
      if (!removable) return {};
      return {
        onContextMenu: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); open(bot.id, bot.name, e.clientX, e.clientY); },
        onPointerDown: (e: PointerEvent) => {
          if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
          const { clientX, clientY } = e;
          clear();
          timer.current = window.setTimeout(() => open(bot.id, bot.name, clientX, clientY), LONG_PRESS_MS);
        },
        onPointerUp: clear,
        onPointerLeave: clear,
        onPointerCancel: clear,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          open(bot.id, bot.name, r.left, r.bottom);
        },
      };
    },
    element: menu && (
      <Menu label={STR5.callBotActions(menu.name)} x={menu.x} y={menu.y} onClose={() => setMenu(null)}
        items={[{ label: STR5.callRemoveFromCall, danger: true, onSelect: () => remove(menu.botId) }]} />
    ),
  };
}
