import path from "node:path";

/**
 * Electron cannot spawn (child_process.spawn) an executable that lives inside app.asar — only
 * execFile is supported there, and even that extracts to a temp copy first, which would break the
 * dictation helper's ad-hoc code signature and therefore its macOS microphone/Speech TCC grant.
 * scripts/package.mjs asks electron-packager to unpack dist/native/** next to the archive
 * (app.asar.unpacked); this maps a path built against the archive onto that unpacked sibling.
 * A dev path (no "app.asar" path segment) is returned unchanged.
 */
export function resolveUnpacked(p: string): string {
  const parts = p.split(path.sep);
  const idx = parts.indexOf("app.asar");
  if (idx === -1) return p;
  parts[idx] = "app.asar.unpacked";
  return parts.join(path.sep);
}
