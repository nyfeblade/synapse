import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bug 298: the public repo's front page. The README says what Synapse is, how to install and run it on
 * an API key, and is honest about the self-signed certificate; its banner is an animated SVG in a light
 * and a dark version that ends on the app icon's Bot; every image it names exists in docs/media/.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const readme = read("README.md");
const BANNERS = ["docs/media/banner-dark.svg", "docs/media/banner-light.svg"];

describe("the public README (bug 298)", () => {
  it("opens by saying what Synapse is, and runs on the user's own Anthropic API key", () => {
    const intro = readme.split("\n## ")[0]!;
    expect(intro).toMatch(/Mac app/);
    expect(intro).toMatch(/Bots/);
    expect(intro).toMatch(/Anthropic API key/);
  });

  it("has the sections a newcomer needs, in order", () => {
    const heads = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.toLowerCase());
    const want = ["install", "requirements", "first run", "features", "privacy and security", "building from source", "licence"];
    const at = want.map((w) => heads.findIndex((h) => h.includes(w)));
    expect(at.every((i) => i >= 0), `sections: ${heads.join(" | ")}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("names the requirements and is honest that the app is self-signed, so the first open is right-click → Open", () => {
    for (const re of [/Apple silicon/i, /OrbStack/, /Anthropic API key/, /self-signed/i, /right-click/i, /\*\*Open\*\*/]) expect(readme).toMatch(re);
  });

  it("shows the banner with <picture>, the dark file for dark mode and the light file otherwise", () => {
    expect(readme).toMatch(/<picture>[\s\S]*media="\(prefers-color-scheme: dark\)"[\s\S]*srcset="docs\/media\/banner-dark\.svg"[\s\S]*<img [^>]*src="docs\/media\/banner-light\.svg"[\s\S]*<\/picture>/);
  });

  it("every image it names exists", () => {
    const refs = [...readme.matchAll(/(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => (m[1] ?? m[2])!);
    expect(refs.filter((r) => r.startsWith("docs/media/")).length).toBeGreaterThanOrEqual(5);
    for (const r of refs) if (!/^https?:/.test(r)) expect(fs.existsSync(path.join(root, r)), r).toBe(true);
  });
});

describe("the banner (bug 298)", () => {
  const icon = read("app/build/icon.svg");
  const plate = /<path d="(M924 512[^"]+)" fill="#000000"/.exec(icon)![1]!;
  const body = /<g transform="translate\(520 544\) rotate\(0\)"><path d="([^"]+)"/.exec(icon)![1]!;

  it.each(BANNERS)("%s is a small, self-contained, animated SVG", (f) => {
    const svg = read(f);
    expect(fs.statSync(path.join(root, f)).size).toBeLessThan(60 * 1024);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/@import|@font-face|url\(\s*['"]?https?:|(?:xlink:)?href="https?:/);
    expect(svg).toMatch(/@keyframes/);
    expect(svg).toMatch(/prefers-reduced-motion/);
    expect(svg).toMatch(/>Synapse</);
    expect(svg).toMatch(/font-family:[^;]*-apple-system/);
  });

  it.each(BANNERS)("%s ends on the app icon's Bot: its plate, its body and a 36° cut", (f) => {
    const svg = read(f);
    expect(svg).toContain(plate);
    expect(svg).toContain(body);
    expect(svg).toContain("M1175.6 -1618L-442.5 -2793.6L-2793.6 442.5L-1175.6 1618Z");
  });

  it("the two versions differ only in colour", () => {
    const [dark, light] = BANNERS.map(read);
    const strip = (s: string) => s.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, "C");
    expect(strip(dark!)).toBe(strip(light!));
    expect(dark).not.toBe(light);
  });
});
