// Bot sharing, phase 1: the /bot page. It decodes the link in the browser, loads no analytics, and is served
// with a strict CSP and no referrer.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script, no types
import { build, seoHead, sitemap, themeBoot, PAGES } from "../../site/build.mjs";

const root = path.join(__dirname, "../..");
let dist = "", html = "";
beforeAll(() => { dist = build("2026-09-29", fs.mkdtempSync(path.join(os.tmpdir(), "site-bot-"))); html = fs.readFileSync(path.join(dist, "bot.html"), "utf8"); });

describe("site /bot", () => {
  it("is built with the shared pieces and the Bot forms, and loads no analytics", () => {
    for (const p of ["<!--THEME-->", "<!--HEADER", "<!--FOOTER-->", "<!--SEO", "<!--BOTDEFS-->"]) expect(html).not.toContain(p);
    expect(html).toContain('id="f-pebble"');
    expect(html).not.toContain("/_vercel/insights");
    expect(seoHead("bot", "0.1.3")).not.toContain("/_vercel/insights");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("latest.js"); // no request to GitHub from a page that holds someone's Bot
    expect(sitemap("2026-09-29")).not.toMatch(/\/bot</);
    expect(Object.keys(PAGES)).not.toContain("bot");
  });

  it("loads the codec as hashed modules (hashed file names, leaf first), one copy of each shared file", () => {
    const m = html.match(/<script type="module" src="\/assets\/(bot\.[0-9a-f]{10}\.js)"><\/script>/);
    expect(m).toBeTruthy();
    const names = fs.readdirSync(path.join(dist, "assets"));
    const named = (base: string) => names.find((n) => new RegExp(`^${base}\\.[0-9a-f]{10}\\.js$`).test(n))!;
    const asset = (f: string) => fs.readFileSync(path.join(dist, "assets", f), "utf8");
    const botJs = asset(m![1]!);
    expect(botJs).toContain(`from "./${named("bot-share")}"`);
    expect(botJs).toContain(`from "./${named("bot-face")}"`);
    expect(asset(named("bot-share"))).toContain(`from "./${named("feedback-content")}"`);
    // The hash in each name is the hash of the file actually served.
    for (const base of ["bot-share", "bot-face", "feedback-content"]) {
      const f = named(base);
      expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, "assets", f))).digest("hex").slice(0, 10)).toBe(f.split(".").at(-2));
    }
    expect(asset(named("bot-face"))).toBe(fs.readFileSync(path.join(root, "shared/src/bot-face.js"), "utf8"));
    expect(names.filter((n) => n.startsWith("bot-share."))).toHaveLength(1);
  });

  it("sets every field with textContent, never innerHTML, and renders instructions as plain text", () => {
    const js = fs.readFileSync(path.join(root, "site/assets/bot.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(js).toContain("textContent");
    expect(html).toMatch(/<pre class="bp-instructions" data-instructions><\/pre>/);
    expect(js).not.toMatch(/fetch\(/);
  });

  it("has the calm copy and the three buttons, Download only on the fallback", () => {
    expect(html).toContain(">Add to Synapse</button>");
    expect(html).toContain(">Save .botpack</button>");
    expect(html).toMatch(/data-download hidden>Download Synapse</);
    expect(html).toContain("Nothing happened?");
  });
});

describe("vercel.json for /bot and /bots", () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  // The global rule comes first; these later rules win for /bot and /bots (Vercel applies matching rules in order).
  const headersFor = (src: string) => Object.fromEntries((v.headers.find((h: { source: string }) => h.source === src)?.headers ?? []).map((h: { key: string; value: string }) => [h.key, h.value]));
  it("serves both with a strict CSP (self scripts plus the theme boot's hash) and no referrer", () => {
    const inline = themeBoot.replace(/^<script>/, "").replace(/<\/script>$/, "");
    const hash = `'sha256-${crypto.createHash("sha256").update(inline).digest("base64")}'`;
    for (const src of ["/bot", "/bots"]) {
      const h = headersFor(src);
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      const csp = h["Content-Security-Policy"] as string;
      expect(csp).toContain(`script-src 'self' ${hash}`);
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/);
      expect(csp).not.toMatch(/vercel|github|googleapis|gstatic/); // no analytics, GitHub or font host
      expect(v.headers.findIndex((x: { source: string }) => x.source === src)).toBeGreaterThan(v.headers.findIndex((x: { source: string }) => x.source === "/(.*)"));
    }
  });
});
