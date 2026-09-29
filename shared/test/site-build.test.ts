// The website's Changelog page is built from CHANGELOG.md (site/build.mjs), so a changelog entry is
// all it takes to update the site.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script, no types
import { inline, parseChangelog, renderReleases, seoHead, sitemap, robots, SITE_URL, PAGES, build } from "../../site/build.mjs";

const md = `# Changelog\n\nintro\n\n## 0.2.0 — Unreleased\n\n- **New.** A thing.\n\n## 0.1.0 — 2026-09-28 — beta\n\nFirst.\n\n### Bots\n\n- One\n- Two\n`;

describe("site changelog", () => {
  it("reads versions, dates, labels and unreleased", () => {
    const r = parseChangelog(md);
    expect(r.map((x: { version: string }) => x.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(r[0]).toMatchObject({ unreleased: true, date: null });
    expect(r[1]).toMatchObject({ unreleased: false, date: "2026-09-28", label: "beta" });
  });

  it("renders an in-progress entry and a dated one, with headings and lists", () => {
    const { toc, body } = renderReleases(parseChangelog(md));
    expect(toc).toContain('href="#next"');
    expect(toc).toContain('href="#v0.1.0"');
    expect(body).toContain('<span class="tag next">in progress</span>');
    expect(body).toContain('<time datetime="2026-09-28">Sep 28, 2026</time>');
    expect(body).toContain("<h3>Bots</h3>");
    expect(body).toContain("<ul><li>One</li><li>Two</li></ul>");
  });

  it("escapes HTML and only links http(s)", () => {
    expect(inline("<script>x</script> **b** [ok](https://a.b) [no](javascript:alert(1))")).toBe(
      '&lt;script&gt;x&lt;/script&gt; <b>b</b> <a href="https://a.b">ok</a> [no](javascript:alert(1))',
    );
  });

  it("the repo's own CHANGELOG.md parses, newest first", () => {
    const real = parseChangelog(fs.readFileSync(path.join(__dirname, "../../CHANGELOG.md"), "utf8"));
    expect(real.length).toBeGreaterThan(0);
    expect(real.some((x: { version: string }) => x.version === "0.1.0")).toBe(true);
  });
});

describe("site SEO", () => {
  it("gives every page its own title, description, canonical and share tags", () => {
    for (const key of Object.keys(PAGES)) {
      const h = seoHead(key, "0.1.0");
      expect(h).toContain(`<link rel="canonical" href="${SITE_URL}${PAGES[key].path}">`);
      for (const t of ["<title>", 'name="description"', 'property="og:url"', 'property="og:image" content="https://', 'name="twitter:title"']) expect(h).toContain(t);
    }
  });

  it("marks the home page as a free macOS app, with the version from the changelog", () => {
    const h = seoHead("home", "0.1.0");
    const app = JSON.parse(h.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
    expect(app).toMatchObject({ "@type": "SoftwareApplication", softwareVersion: "0.1.0", offers: { price: "0" } });
    expect(seoHead("docs", "0.1.0")).not.toContain("ld+json");
  });

  it("lists every page in the sitemap and points robots at it", () => {
    const xml = sitemap("2026-09-28");
    for (const p of Object.values(PAGES) as { path: string }[]) expect(xml).toContain(`<loc>${SITE_URL}${p.path}</loc>`);
    expect(robots()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it("leaves no SEO placeholder in the built pages", () => {
    const dist = build("2026-09-28");
    for (const f of ["index.html", "docs.html", "changelog.html"]) expect(fs.readFileSync(path.join(dist, f), "utf8")).not.toContain("<!--SEO");
  });
});

describe("the docs say what the app does (code audit 2026-09-29)", () => {
  const docs = fs.readFileSync(path.join(__dirname, "../../site/docs.html"), "utf8");
  it("two macOS accounts are supported since 0.1.1, not \"fixed in the next version\"", () => {
    expect(docs).not.toMatch(/Not supported yet|Fixed in the next version/i);
    expect(docs).toMatch(/two macOS accounts[\s\S]{0,300}0\.1\.1/i);
  });
  it("updates: always checked, and the switch only decides whether they install by themselves", () => {
    expect(docs).toMatch(/Synapse checks for new versions itself/);
    expect(docs).toMatch(/<b>Automatic Updates<\/b>/);
  });
});
