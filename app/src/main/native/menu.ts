import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { APP_NAME } from "@synapse/shared";

/**
 * The app's menu bar. Bug 134: a Call menu lists the Bots ("Call Nova", …) and is rebuilt when the
 * renderer sends a new list; its shortcut line shows the global call shortcut, if one is set.
 */
export function installAppMenu(emit: (channel: string) => void, calls?: { items: MenuItemConstructorOptions[] }): void {
  const template: MenuItemConstructorOptions[] = [
    { label: APP_NAME, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }] },
    { label: "File", submenu: [
      { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => emit("new-chat") },
      { label: "Import Bot…", click: () => emit("import-bot") },
      { type: "separator" }, { role: "close", label: "Close Window" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ label: "Command Palette", accelerator: "CmdOrCtrl+K", click: () => emit("palette") }, { type: "separator" }, { role: "reload", visible: !app.isPackaged }, { role: "toggleDevTools", visible: !app.isPackaged }] },
  ];
  if (calls?.items.length) template.push({ label: "Call", submenu: calls.items });
  template.push({ role: "windowMenu" }, { role: "help", submenu: [{ label: `${APP_NAME} Help`, click: () => emit("help") }, { label: "Send Feedback…", click: () => emit("feedback") }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
