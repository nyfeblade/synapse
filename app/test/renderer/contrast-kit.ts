// The colour-measuring instrument shared by the two contrast guards (bug 41):
//   - contrast-pairs.test.ts   — STATIC: pairs the stylesheet itself puts on the same element.
//   - contrast-surfaces.test.tsx — RENDERED: every text node of a real surface, measured against the
//     fill of the element it actually sits on, found by walking the real DOM.
// Extracted from contrast-pairs.test.ts unchanged, so both guards measure with the same ruler.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Concatenated on purpose: Vite rewrites `new URL("<literal>", import.meta.url)` into an asset URL,
// which under jsdom resolves against the document and is not a file: URL.
export const STYLES = fileURLToPath(new URL("../../src/" + "renderer/styles/", import.meta.url));
export const read = (file: string) => readFileSync(STYLES + file, "utf8");
export const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every renderer stylesheet except the token file itself, which defines colours rather than pairing them. */
export const SHEETS = readdirSync(STYLES).filter((f) => f.endsWith(".css") && f !== "tokens.css").sort();

// ---------------------------------------------------------------------------------------------
// WCAG 2.1 relative luminance and contrast.
// ---------------------------------------------------------------------------------------------
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch[0]!) + 0.7152 * f(ch[1]!) + 0.0722 * f(ch[2]!);
}
export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
export const isHex = (s: string | undefined): s is string => !!s && /^#[0-9A-Fa-f]{6}$/.test(s);

// ---------------------------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------------------------
export type Rule = { sheet: string; selector: string; decls: Record<string, string>; order: number };

/** Flattens a stylesheet to its style rules. @media / @supports bodies are walked into (a colour pair
 *  inside a query is still a colour pair); @keyframes and @font-face are not rule sets and are dropped. */
export function rules(sheet: string, css: string): Rule[] {
  const src = stripComments(css);
  const out: Rule[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|layer|container)\b/.test(prelude)) walk(body);
      } else if (prelude) {
        const decls: Record<string, string> = {};
        for (const part of body.split(";")) {
          const c = part.indexOf(":");
          if (c < 0) continue;
          const prop = part.slice(0, c).trim();
          if (!/^[-a-zA-Z]+$/.test(prop)) continue; // a nested rule's leftovers, not a declaration
          decls[prop] = part.slice(c + 1).trim();
        }
        out.push({ sheet, selector: prelude.replace(/\s+/g, " "), decls, order: out.length });
      }
      i = j;
    }
  };
  walk(src);
  return out;
}

export const TOKEN = /^var\((--[\w-]+)\)$/;

/** The raw background a rule declares, from `background-color` or the `background` shorthand. */
export const bgOf = (decls: Record<string, string>): string | undefined => decls["background-color"] ?? decls.background;

/** WCAG 1.4.3: 4.5:1 for body text, 3:1 for large text (>= 24px, or >= 18.66px bold).
 *  A rule that does not declare its own type inherits the app's body type, which app.css fixes at
 *  14px/400 on `body` — the conservative reading. */
export function threshold(decls: Record<string, string>): { need: number; why: string } {
  const size = parseFloat(decls["font-size"] ?? "") || 14;
  const weightRaw = decls["font-weight"] ?? "400";
  const weight = weightRaw === "bold" ? 700 : parseFloat(weightRaw) || 400;
  if (size >= 24 || (size >= 18.66 && weight >= 700)) return { need: 3, why: `large text (${size}px/${weight})` };
  return { need: 4.5, why: `body text (${size}px/${weight})` };
}

// ---------------------------------------------------------------------------------------------
// The theme blocks, and one level of var() indirection.
// ---------------------------------------------------------------------------------------------
export type Blocks = { light: string; dark: string };
export function themeBlocks(): Blocks {
  const src = stripComments(read("tokens.css"));
  const light = src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1];
  const dark = src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!light) throw new Error("no `:root` block in tokens.css");
  if (!dark) throw new Error("no dark block in tokens.css");
  // theme-literals.test.ts is what keeps `:root[data-theme="dark"]` byte-identical to the media block,
  // so resolving against one of the two is resolving against both.
  return { light, dark };
}

/** `a` laid over `b` at `alpha`, as the compositor does it, back to a hex. */
function over(a: string, b: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(ch(a, i) * alpha + ch(b, i) * (1 - alpha));
  return "#" + [0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0").toUpperCase()).join("");
}

/**
 * Resolves a token to a hex literal in one theme, following `var(--other)` indirection.
 * A token with no dark value falls back to `:root`, which is exactly what the cascade does.
 *
 * IT ALSO FLATTENS A TRANSLUCENT FILL, and that is not a convenience — it is what keeps this whole
 * instrument pointed at the app. The Apple pass made the interaction fills a wash of the page's own
 * ink (`--fill-hover: color-mix(in srgb, var(--ink) 4%, transparent)`), because a hover has to
 * composite correctly on the canvas, on a card and on an inset fill rather than being a solid grey
 * that is right on one of them. `isHex` would have rejected that value, and the cross-rule walk
 * SKIPS any pair it cannot resolve — so every `:hover` and `:active` pair in the app would have
 * dropped silently out of the contrast guard and the file would still have been green. A guard that
 * stops measuring is worse than a guard that fails.
 *
 * The flattening is against the theme's PAGE (--bg), which is the lightest surface a hover is ever
 * painted on in light and the darkest in dark, so it is the worst case for the ink that lands on it:
 * a pair that clears here clears on the cards and inset fills too.
 */
export function resolve(blocks: Blocks, theme: "light" | "dark", name: string): string {
  const from = (block: string) => block.match(new RegExp(escapeSel(name) + ":\\s*([^;]+);"))?.[1]?.trim();
  const raw = (theme === "dark" ? from(blocks.dark) : undefined) ?? from(blocks.light);
  if (!raw) throw new Error(`${name} is defined in neither block`);
  const indirect = raw.match(/^var\((--[\w-]+)\)$/);
  if (indirect) return resolve(blocks, theme, indirect[1]!);
  const mix = raw.match(/^color-mix\(\s*in srgb\s*,\s*var\((--[\w-]+)\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/);
  if (mix) {
    if (name === "--bg") throw new Error("--bg cannot be translucent: there is nothing behind the page");
    return over(resolve(blocks, theme, mix[1]!), resolve(blocks, theme, "--bg"), Number(mix[2]) / 100);
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Selectors, for the cross-rule half of the instrument.
// ---------------------------------------------------------------------------------------------
/** Splits on `ch` outside parentheses and brackets. */
export function splitTop(s: string, ch: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === ch && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** A selector as its compounds, subject last; each compound as its simple selectors. */
export function compounds(selector: string): string[][] {
  return splitTop(selector.replace(/\s*([>+~])\s*/g, " "), " ")
    .map((c) => c.match(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?|\.[\w-]+|#[\w-]+|\[[^\]]*\]|^[\w-]+|\*/g) ?? []);
}

/** Specificity as one comparable number: ids, then classes / attributes / pseudo-classes, then types. */
export function specificity(selector: string): number {
  let [a, b, c] = [0, 0, 0];
  for (const simple of compounds(selector).flat()) {
    if (simple.startsWith("#")) a++;
    else if (simple.startsWith("::")) c++;
    else if (simple.startsWith(".") || simple.startsWith("[") || simple.startsWith(":")) b++;
    else if (simple !== "*") c++;
  }
  return a * 10_000 + b * 100 + c;
}
