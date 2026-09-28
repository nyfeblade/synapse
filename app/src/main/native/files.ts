import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import { registerNative } from "../native";

type Filters = { name: string; extensions: string[] }[];

/** P5 review minor: readDroppedFile reads only paths that came from a real drop (preload's webUtils) or a dialog. */
const dropped = new Set<string>();
export function allowDroppedPath(p: string): void {
  if (typeof p !== "string" || !p || !path.isAbsolute(p)) return;
  dropped.add(p);
  if (dropped.size > 200) dropped.delete(dropped.values().next().value!);
}

export function registerFiles(getWin: () => BrowserWindow | null): void {
  registerNative("saveFile", async (a: { defaultName: string; bytesBase64: string; filters?: Filters }) => {
    const e2eDir = process.env.E2E_SAVE_DIR;
    if (e2eDir) {
      // E2E: write without a dialog. basename() keeps a hostile defaultName inside the folder.
      const p = path.join(e2eDir, path.basename(a.defaultName));
      fs.writeFileSync(p, Buffer.from(a.bytesBase64, "base64"));
      return { path: p };
    }
    const win = getWin();
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: a.defaultName, filters: a.filters }) : await dialog.showSaveDialog({ defaultPath: a.defaultName, filters: a.filters });
    if (r.canceled || !r.filePath) return { path: null };
    fs.writeFileSync(r.filePath, Buffer.from(a.bytesBase64, "base64"));
    return { path: r.filePath };
  });
  registerNative("openFile", async (a: { filters?: Filters; maxBytes?: number }) => {
    let p = process.env.E2E_OPEN_FILE;
    if (!p) {
      const win = getWin();
      const r = win ? await dialog.showOpenDialog(win, { properties: ["openFile"], filters: a.filters }) : await dialog.showOpenDialog({ properties: ["openFile"], filters: a.filters });
      p = r.filePaths[0];
      if (r.canceled || !p) return null;
      allowDroppedPath(p);
    }
    const size = fs.statSync(p).size;
    if (a.maxBytes && size > a.maxBytes) throw new Error(`The file is larger than ${Math.round(a.maxBytes / 1048576)} MB.`);
    return { path: p, name: path.basename(p), bytesBase64: fs.readFileSync(p).toString("base64") };
  });
  // Final secfix round 2 (ruling A): Settings → Computer picks an auto-run folder (the Mac policy re-validates it).
  registerNative("pickFolder", async () => {
    const win = getWin();
    const o = { properties: ["openDirectory" as const] };
    const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
    return { path: r.canceled ? null : r.filePaths[0] ?? null };
  });
  registerNative("readDroppedFile", async (a: { path: string; maxBytes: number }) => {
    if (!dropped.has(a.path)) throw new Error("That file wasn't dropped or picked in this window.");
    if (fs.lstatSync(a.path).isSymbolicLink()) throw new Error("That file is a link; drop the file itself.");
    const size = fs.statSync(a.path).size;
    if (size > a.maxBytes) throw new Error(`The file is larger than ${Math.round(a.maxBytes / 1048576)} MB.`);
    return { path: a.path, name: path.basename(a.path), bytesBase64: fs.readFileSync(a.path).toString("base64") };
  });
  registerNative("revealPath", async (a: { path: string }) => {
    shell.showItemInFolder(a.path);
    return {};
  });
}
