// The website's Changelog page is built from CHANGELOG.md (site/build.mjs), so a changelog entry is
// all it takes to update the site.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script, no types
import { inline, parseChangelog, renderReleases, seoHead, sitemap, robots, SITE_URL, PAGES, build, botSvg, botDefs, expandBots, header, footer, EYE_INK } from "../../site/build.mjs";

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

describe("site Bots and shared pieces", () => {
  it("draws a Bot as a flat body with a solid black face: no gradient, filter, highlight or cut-out", () => {
    const svg = botSvg("pill", "#46995f", "md");
    expect(svg).toContain('href="#f-capsule"');
    expect(svg).toContain('fill="#46995f"');
    expect(svg).toContain(`<g class="face" fill="${EYE_INK}">`);
    expect(svg).toContain(`stroke="${EYE_INK}"`);
    expect((svg.match(/class="eye"/g) ?? []).length).toBe(2);
    for (const bad of ["Gradient", "filter", "opacity", "mask", "clipPath", "#fff", "#FFF"]) expect(svg + botDefs()).not.toContain(bad);
  });

  it("falls back to the pebble for an unknown shape, and defines every body form once", () => {
    expect(botSvg("nope", "#3674d8")).toContain('href="#f-pebble"');
    const defs = botDefs();
    for (const f of ["pebble", "orb", "tile", "capsule", "dome", "gem"]) expect(defs.match(new RegExp(`id="f-${f}"`, "g"))?.length).toBe(1);
  });

  it("expands Bot placeholders and leaves other comments alone", () => {
    const out = expandBots("<!--BOT:orb:#ec7431--><!--BOT:gem:#3674d8:sm--><!-- note -->");
    expect(out).toContain('class="bot"');
    expect(out).toContain('class="bot sm"');
    expect(out).toContain("<!-- note -->");
  });

  it("marks the current page in the shared header, with the theme button and download link", () => {
    expect(header("docs")).toContain('<a href="/docs" aria-current="page">');
    expect(header("docs")).not.toContain('<a href="/changelog" aria-current');
    expect(header("home")).toContain('class="theme"');
    expect(header("home")).toContain("data-dl");
    expect(footer()).toContain('class="wordmark"');
  });

  it("leaves no placeholder in the built pages, and every page gets the header, footer and theme boot", () => {
    const dist = build("2026-09-28");
    for (const f of ["index.html", "docs.html", "changelog.html"]) {
      const html = fs.readFileSync(path.join(dist, f), "utf8");
      expect(html).not.toMatch(/<!--(BOT|BOTDEFS|HEADER|FOOTER|THEME|TOC|RELEASES)/);
      for (const t of ['class="site-header"', 'class="site-footer"', 'localStorage.getItem("synapse-theme")']) expect(html).toContain(t);
    }
    const home = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    expect(home).toContain('id="f-pebble"');
    expect(home).toContain("data-dl");
    expect(home).toContain("data-version");
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
