import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The UI font is SF Pro, reached ONLY through the OS system-font stack (`-apple-system` etc.).
// Nothing is bundled, copied or downloaded: no @font-face, no .ttf/.otf/.woff* ships with the app.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFileSync(path.join(app, p), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the UI font", () => {
  it("--font is the OS system-font stack, leading with -apple-system", () => {
    const css = strip(read("src/renderer/styles/tokens.css"));
    const font = css.match(/--font:\s*([^;]+);/)![1]!;
    expect(font.split(",").map((s) => s.trim())[0]).toBe("-apple-system");
    expect(font).toBe('-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif');
  });

  it("tokens.css declares no @font-face: SF Pro comes from the OS only, nothing is bundled", () => {
    const css = strip(read("src/renderer/styles/tokens.css"));
    expect(css).not.toMatch(/@font-face/);
  });

  it("no font file ships with the app: the assets/fonts folder is gone (or empty of font files)", () => {
    const dir = path.join(app, "src/renderer/assets/fonts");
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    const fontFiles = files.filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
    expect(fontFiles, `font file(s) still bundled: ${fontFiles.join(", ")}`).toEqual([]);
  });

  it("no stylesheet or page pulls a font from the web", () => {
    const dir = path.join(app, "src/renderer/styles");
    const files = [...fs.readdirSync(dir).map((f) => `src/renderer/styles/${f}`), "src/renderer/index.html"];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/fonts\.googleapis|fonts\.gstatic|rsms\.me|@import\s+url\(\s*["']?https?:/);
      for (const m of strip(src).matchAll(/@font-face\s*\{([^}]*)\}/g)) expect(m[1], f).not.toMatch(/url\(\s*["']?https?:/);
    }
  });
});
