import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

/** Final secfix item 11: a ditto stand-in that really unpacks a bundle into a temp dir, with this Info.plist version. */
export function fakeDitto(version: string | (() => string), app = "Bots.app") {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd !== "ditto") return;
    const out = args[args.length - 1]!;
    fs.mkdirSync(path.join(out, app, "Contents"), { recursive: true });
    const v = typeof version === "function" ? version() : version;
    fs.writeFileSync(path.join(out, app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>app.bots</string>\n<key>CFBundleShortVersionString</key>\n<string>${v}</string>\n</dict></plist>\n`);
  });
}
