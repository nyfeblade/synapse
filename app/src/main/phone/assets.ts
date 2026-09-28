import fs from "node:fs";
import path from "node:path";
import { iconPng } from "./png";
import type { Asset } from "./server";

/** Bug 198: the phone app's Home Screen manifest (standalone, its own icon, one colour). */
export function manifest(): string {
  return JSON.stringify({
    name: "Synapse",
    short_name: "Synapse",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
};

/**
 * The files the phone is served: the built client (dist/phone — index.html, app.js, app.css, sw.js,
 * worklet.js) plus what is made here (the manifest and the icons). Read once and kept in memory.
 */
export function phoneAssets(dir: string): (p: string) => Asset | null {
  const files = new Map<string, Asset>();
  for (const name of ["index.html", "app.js", "app.css", "sw.js", "worklet.js"]) {
    try { files.set(`/${name}`, { type: TYPES[path.extname(name)]!, body: fs.readFileSync(path.join(dir, name)) }); } catch { /* a dev tree without the client built */ }
  }
  files.set("/manifest.webmanifest", { type: "application/manifest+json; charset=utf-8", body: manifest() });
  let icons: Map<string, Asset> | null = null;
  const icon = (p: string): Asset | null => {
    icons ??= new Map([
      ["/icon-192.png", { type: "image/png", body: iconPng(192), cache: "long" as const }],
      ["/icon-512.png", { type: "image/png", body: iconPng(512), cache: "long" as const }],
      ["/icon-maskable-512.png", { type: "image/png", body: iconPng(512), cache: "long" as const }],
      ["/apple-touch-icon.png", { type: "image/png", body: iconPng(180), cache: "long" as const }],
      ["/favicon.png", { type: "image/png", body: iconPng(64), cache: "long" as const }],
    ]);
    return icons.get(p) ?? null;
  };
  return (p) => files.get(p) ?? icon(p);
}
