// Battle plan (distribution): the "Works with" pages, one per provider, published with 0.1.6.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REFERENCE_NAME } from "../../scripts/public-scan";
import { ACP_VENDORS, MODEL_CATALOG } from "../src";
// @ts-expect-error plain ESM build script, no types
import { build, PAGES, DRAFT_PAGES, WORKS_WITH_PAGES } from "../../site/build.mjs";

type Page = { file: string; path: string; title: string; noindex?: boolean };
const drafts = Object.entries(WORKS_WITH_PAGES as Record<string, Page>);
const draftPaths = new Set(drafts.map(([, p]) => p.path));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "site-ww-"));
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));
const dist = build("2026-09-30", out);
const html = (p: Page) => fs.readFileSync(path.join(dist, p.file), "utf8");
/** The page's visible text, tags dropped. */
const text = (p: Page) => html(p).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const usd = (n: number) => `$${n >= 1 && Number.isInteger(n) ? n : n < 0.1 ? String(n) : n.toFixed(2)}`;

describe("the Works with pages", () => {
  it("are an index plus the seven provider pages", () => {
    expect(drafts.map(([, p]) => p.path).sort()).toEqual(["/works-with", "/works-with-coding-subscriptions", "/works-with-deepseek", "/works-with-gemini",
      "/works-with-local-models", "/works-with-mistral", "/works-with-openai", "/works-with-openrouter"]);
  });

  it.each(drafts)("%s builds, is published (indexed, not a draft) and uses the hashed assets", (key, p) => {
    const h = html(p);
    expect((PAGES as Record<string, Page>)[key]).toBe(p);
    expect((DRAFT_PAGES as Record<string, Page>)[key]).toBeUndefined();
    expect(h).not.toContain('name="robots"');
    expect(h).toContain(`<link rel="canonical" href="https://`);
    expect(h).toContain(`<title>${p.title.replace(/&/g, "&amp;")}</title>`);
    expect(h).toMatch(/\/assets\/site\.[0-9a-f]{10}\.css/);
    expect(h).toContain('class="site-header"');
    expect(h).toContain('class="site-footer"');
    for (const left of ["<!--BODY-->", "@KEY@", "<!--SEO", "<!--HEADER", "<!--FOOTER-->", "<!--THEME-->"]) expect(h).not.toContain(left);
    // The CSP allows one inline script (the theme boot); a page adds none of its own.
    expect(h.match(/<script>/g)?.length).toBe(1);
    // A provider page names no competitor product (the public-tree guard's list).
    expect(REFERENCE_NAME.test(h)).toBe(false);
  });

  it("are in the sitemap, and every page's footer links the index as \"Works with\"", () => {
    const sitemap = fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8");
    for (const p of draftPaths) expect(sitemap).toContain(`${p}</loc>`);
    for (const f of ["index.html", "docs.html", "changelog.html", "works-with-openai.html"]) {
      const footer = fs.readFileSync(path.join(dist, f), "utf8").split('class="site-footer"')[1] ?? "";
      expect(footer, f).toContain('<a href="/works-with">Works with</a>');
    }
  });

  it("link only to each other's real paths and sections", () => {
    for (const [, p] of drafts) {
      for (const [, to, hash] of html(p).matchAll(/href="(\/works-with[\w-]*)(?:#([\w-]+))?"/g)) {
        expect(draftPaths.has(to), `${p.path} → ${to}`).toBe(true);
        const target = drafts.find(([, d]) => d.path === to)![1];
        if (hash) expect(html(target), `${p.path} → ${to}#${hash}`).toContain(`id="${hash}"`);
      }
    }
  });

  it("show the catalog's prices and the date they were checked", () => {
    const byProvider: Record<string, Page> = { openai: WORKS_WITH_PAGES.wwOpenai, gemini: WORKS_WITH_PAGES.wwGemini, mistral: WORKS_WITH_PAGES.wwMistral, deepseek: WORKS_WITH_PAGES.wwDeepseek };
    for (const row of MODEL_CATALOG) {
      const page = byProvider[row.ref.split(":")[0]!]!;
      const t = text(page);
      const cells = [row.label, usd(row.usdPerMTok.input), ...(row.usdPerMTok.cachedInput !== row.usdPerMTok.input ? [usd(row.usdPerMTok.cachedInput)] : []), usd(row.usdPerMTok.output)];
      expect(t, row.ref).toContain(cells.join(" "));
      expect(row.verifiedAt).toBe("2026-09-30");
      expect(html(page)).toContain(`checked on <time datetime="${row.verifiedAt}">`);
    }
  });

  it("call every coding CLI Experimental and never claim a Supported model", () => {
    const coding = text(WORKS_WITH_PAGES.wwCoding);
    expect(coding).toContain("Experimental");
    for (const v of Object.values(ACP_VENDORS)) {
      expect(v.status).toBe("experimental");
      expect(coding).toContain(v.label);
    }
    for (const [, p] of drafts) {
      if (p === WORKS_WITH_PAGES.worksWith) continue;
      expect(text(p), p.path).not.toContain("Supported");
    }
    // The subscription sign-ins that aren't allowed are named as not supported.
    expect(text(WORKS_WITH_PAGES.worksWith)).toContain("Signing in with a Claude subscription");
    expect(coding).toContain("Not supported: signing in with a Claude subscription, or with a Google account for the Gemini CLI or Antigravity.");
  });
});
