import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Lines that are neither blank nor a `//` / `*` comment. */
const code = (file: string): string[] =>
  fs.readFileSync(file, "utf8").split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });

/**
 * The packaged app shipped a launch that never drew a window: the main process blocked forever on
 * the main thread inside SecItemCopyMatching, called from the FIRST safeStorage touch in start()
 * — before `win.loadFile()`, so there was no window, and the macOS keychain prompt behind the
 * stall could never be answered.
 *
 * safeStorage is synchronous and can block indefinitely, so exactly one module may call it:
 * keychain.ts, whose gate refuses every call until the window is up and a probe has said the
 * keychain answers. A direct import anywhere else re-opens that hole, and nothing short of
 * launching the packaged bundle would notice — so notice here instead.
 */
describe("safeStorage has exactly one entry point", () => {
  it("is named in running code only by src/main/keychain.ts", () => {
    const offenders = walk(src)
      // `\b…\b` so `safeStorageName`/`safeStorageNamespace` — which are not the Electron API — pass.
      .filter((f) => code(f).some((l) => /\bsafeStorage\b/.test(l)))
      .map((f) => path.relative(src, f));
    expect(offenders).toEqual([path.join("main", "keychain.ts")]);
  });

  /**
   * Bug-log 279: the keychain is retired. keychain.ts only serves the one-time migration, which index.ts hands to
   * sealing.ts; nothing else may reach safeStorage through it, and sealing is owned by sealing.ts's gate.
   */
  it("keychain.ts is imported by running code only in src/main/index.ts", () => {
    const importers = walk(src)
      .filter((f) => code(f).some((l) => /from\s+["'][./]*(?:main\/)?keychain["']/.test(l)))
      .map((f) => path.relative(src, f));
    expect(importers).toEqual([path.join("main", "index.ts")]);
  });

  it("the key-file store is built only in src/main/index.ts, and handed to the gate in sealing.ts", () => {
    const builders = walk(src)
      .filter((f) => code(f).some((l) => /new FileKeyStore\(/.test(l)))
      .map((f) => path.relative(src, f));
    expect(builders).toEqual([path.join("main", "index.ts")]);
  });
});
