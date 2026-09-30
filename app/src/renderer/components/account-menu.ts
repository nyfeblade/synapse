import { STR, STRL } from "@synapse/shared";
import { useMarketplace } from "../marketplace/store";
import { useUi } from "../store";
import type { MenuItem } from "./Menus";

const items: { id: string; order: number; item: () => MenuItem | null }[] = [];

export function registerAccountItem(id: string, order: number, item: () => MenuItem | null): void {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) items.splice(i, 1);
  items.push({ id, order, item });
  items.sort((a, b) => a.order - b.order);
}

// UI polish pass (critique 5.6): no "Weekly usage 38%" row here. It was data, not an action, and it
// repeated the "38% this week" line on the account row directly beneath the menu.
// The quiet sidebar (the smooth pass, Task 2): Home, Schedules, Usage and Marketplace no longer sit
// as their own sidebar rows/foot — they live here, in the account menu, ahead of Settings.
// New-user walk, finding 15: each label names where it goes ("Home" opened New chat; Usage now has its own section).
registerAccountItem("home", 21, () => ({ label: STR.newChat, onSelect: () => useUi.getState().openNewChat() }));
registerAccountItem("schedules", 22, () => ({ label: STRL.schedules, onSelect: () => useUi.getState().openSettings("schedules") }));
registerAccountItem("usage", 23, () => ({ label: STRL.usage, onSelect: () => useUi.getState().openSettings("usage") }));
registerAccountItem("marketplace", 24, () => ({ label: STR.marketplace, onSelect: () => useMarketplace.getState().openMarketplace() }));
// Fix round 1 (spec gap): a hairline separator ahead of Settings, as the approved mockup draws it.
registerAccountItem("settings-separator", 30, () => ({ separator: true }));
registerAccountItem("settings", 50, () => ({ label: STR.settings, title: "⌘,", onSelect: () => useUi.getState().openSettings() }));

export function accountMenuItems(): MenuItem[] {
  return items.map((x) => x.item()).filter((x): x is MenuItem => x !== null);
}
