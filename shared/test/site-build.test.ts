// The website's Changelog page is built from CHANGELOG.md (site/build.mjs), so a changelog entry is
// all it takes to update the site.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script, no types
import { inline, parseChangelog, renderReleases, seoHead, sitemap, robots, SITE_URL, PAGES, NO_ANALYTICS, build, botSvg, botDefs, expandBots, header, footer, EYE_INK, themeBoot } from "../../site/build.mjs";
import crypto from "node:crypto";

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

/** The built file for an asset's source name: site.css → dist/assets/site.<hash>.css. */
function built(dist: string, name: string): string {
  const [dir, base] = name.includes("/") ? [path.dirname(name), path.basename(name)] : [".", name];
  const dot = base.lastIndexOf(".");
  const re = new RegExp(`^${base.slice(0, dot).replace(/[.-]/g, "\\$&")}\\.[0-9a-f]{10}\\${base.slice(dot)}$`);
  const hit = fs.readdirSync(path.join(dist, "assets", dir)).find((f) => re.test(f));
  if (!hit) throw new Error(`no built file for ${name}`);
  return path.join(dist, "assets", dir, hit);
}

// Pressure test 2026-09-29 (S1, S2): hashed assets were cached for an hour only, and a module's ?v= ignored what it imports.
describe("hashed asset names", () => {
  const dist = build("2026-09-29");
  const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 10);
  it("every asset but the share image, favicon and font licence has its content hash in its name", () => {
    for (const f of all(path.join(dist, "assets"))) {
      const rel = path.relative(path.join(dist, "assets"), f);
      if (["og.png", "favicon.png", path.join("fonts", "OFL.txt")].includes(rel)) continue;
      const m = /\.([0-9a-f]{10})\.[a-z0-9]+$/.exec(rel);
      expect(m, rel).not.toBeNull();
      expect(m![1], rel).toBe(hash(f));
    }
  });
  it("every /assets reference in pages, stylesheets and modules points at a file that exists", () => {
    const refs = new Set<string>();
    for (const f of all(dist).filter((x) => /\.(html|css|js)$/.test(x))) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/\/assets\/[\w./-]+\.[a-z0-9]+(?=["')\s?#])/g)) refs.add(m[0]);
      for (const m of text.matchAll(/from "\.\/([\w.-]+)"/g)) refs.add(`/assets/${m[1]}`);
    }
    expect(refs.size).toBeGreaterThan(10);
    for (const r of refs) expect(fs.existsSync(path.join(dist, r)), r).toBe(true);
    for (const f of ["index.html", "docs.html", "changelog.html", "feedback.html"]) expect(fs.readFileSync(path.join(dist, f), "utf8"), f).not.toMatch(/\/assets\/[\w-]+\.(?:css|js)["?]/);
  });
  it("hashes leaf first: a module's name covers the hashed name of what it imports", () => {
    const leaf = path.basename(built(dist, "feedback-content.js"));
    for (const parent of ["feedback.js", "feedback-thread.js"]) {
      const f = built(dist, parent);
      expect(fs.readFileSync(f, "utf8")).toContain(`from "./${leaf}"`);
      expect(path.basename(f)).toContain(`.${hash(f)}.js`);
    }
    expect(fs.readFileSync(built(dist, "site.css"), "utf8")).toMatch(/url\(\/assets\/fonts\/geist-latin\.[0-9a-f]{10}\.woff2\)/);
  });
  it("hashed names are cached for a year, immutable; fixed names for an hour", () => {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vercel.json"), "utf8"));
    const cache = (src: RegExp) => v.headers.find((h: { source: string }) => src.test(h.source))?.headers.find((x: { key: string }) => x.key === "Cache-Control")?.value;
    expect(cache(/\[0-9a-f\]\{10\}/)).toBe("public, max-age=31536000, immutable");
    expect(cache(/og\\\.png/)).toBe("public, max-age=3600");
  });
});

// The /feedback page: built with the shared pieces, linked from the footer and the docs, a plain form that works without JS.
describe("site /feedback", () => {
  let dist = "", html = "";
  beforeAll(() => { dist = build("2026-09-29"); html = fs.readFileSync(path.join(dist, "feedback.html"), "utf8"); });

  it("is built with the shared pieces, its own SEO tags and hashed assets", () => {
    for (const p of ["<!--THEME-->", "<!--HEADER", "<!--FOOTER-->", "<!--SEO"]) expect(html).not.toContain(p);
    expect(html).toContain('class="site-header"');
    expect(html).toContain('class="site-footer"');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/feedback">`);
    expect(html).toMatch(/\/assets\/site\.[0-9a-f]{10}\.css/);
    expect(html).toMatch(/\/assets\/feedback\.[0-9a-f]{10}\.js/);
    expect(PAGES.feedback.path).toBe("/feedback");
    expect(sitemap("2026-09-29")).toContain(`<loc>${SITE_URL}/feedback</loc>`);
  });

  it("is a plain POST form to /api/feedback with type, message and a hidden honeypot, and no email field", () => {
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/feedback"/);
    for (const t of ["bug", "idea", "confusing", "love"]) expect(html).toContain(`name="type" value="${t}"`);
    expect(html).toMatch(/<textarea name="message"[^>]*maxlength="5000"[^>]*required/);
    expect(html).not.toContain('name="email"');
    expect(html).toMatch(/<script type="module" src="\/assets\/feedback\.[0-9a-f]{10}\.js"/);
    expect(fs.readFileSync(built(dist, "feedback.js"), "utf8")).toMatch(/from "\.\/feedback-content\.[0-9a-f]{10}\.js"/);
    expect(fs.existsSync(built(dist, "feedback-content.js"))).toBe(true);
    expect(html).toMatch(/<div class="fb-hp" aria-hidden="true">[\s\S]*name="website" tabindex="-1" autocomplete="off"/);
    // Without JS the thank-you shows through :target after the redirect to /feedback?sent=1#sent.
    expect(html).toContain('id="sent"');
    expect(fs.readFileSync(built(dist, "site.css"), "utf8")).toContain(".fb-done:target");
  });

  it("is linked from the footer and the docs", () => {
    expect(footer()).toContain('href="/feedback"');
    expect(fs.readFileSync(path.join(dist, "docs.html"), "utf8")).toContain('href="/feedback"');
  });
});

describe("vercel.json", () => {
  it("still serves the built site with clean URLs; /api is served from the repo's api/ folder", () => {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vercel.json"), "utf8"));
    expect(v).toMatchObject({ buildCommand: "node site/build.mjs", outputDirectory: "site/dist", cleanUrls: true });
    expect(fs.existsSync(path.join(__dirname, "../../api/feedback/index.js"))).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/"\/api/);
    expect(v.rewrites).toEqual([{ source: "/feedback/thread", destination: "/feedback-thread" }]); // cleanUrls: a .html destination 308s, so the rewrite 404ed
    expect(fs.existsSync(path.join(__dirname, "../../api/feedback/thread.js"))).toBe(true);
  });
});

describe("site /feedback/thread (private replies)", () => {
  let dist = "", html = "";
  beforeAll(() => { dist = build("2026-09-29"); html = fs.readFileSync(path.join(dist, "feedback-thread.html"), "utf8"); });
  it("is built with the shared pieces, not indexed and not in the sitemap", () => {
    for (const p of ["<!--THEME-->", "<!--HEADER", "<!--FOOTER-->"]) expect(html).not.toContain(p);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(sitemap("2026-09-29")).not.toContain("/feedback/thread");
    expect(html).toMatch(/\/assets\/feedback-thread\.[0-9a-f]{10}\.js/);
  });
  it("says plainly what the link is, and sends the code only as a header", () => {
    expect(html).toContain("Keep this link to see replies. Anyone with it can read this thread.");
    const js = fs.readFileSync(built(dist, "feedback-thread.js"), "utf8");
    expect(js).toContain('"x-feedback-code": code');
    expect(js).not.toMatch(/fetch\([^)]*\$\{code\}/);
    expect(js).toMatch(/textContent = m\.text/);
    expect(js).not.toContain("innerHTML");
    expect(fs.readFileSync(built(dist, "feedback.js"), "utf8")).toContain("/feedback/thread?sent=1#${j.thread}");
    expect(html).toContain("No replies yet");
    expect(js).toContain("const KEY = `synapse-feedback:${code}`;");
    expect(js).toContain("localStorage.getItem(KEY)");
    expect(js).toContain("Couldn't load replies yet. Try again later.");
    expect(js).toMatch(/\[1-9\]\\d\{0,9\}\\\.\[A-Za-z0-9_-\]\{22\}/);
    for (const f of ["feedback.js", "feedback-thread.js"]) expect(fs.readFileSync(built(dist, f), "utf8")).toContain("spamReason(");
  });
  it("has no email field or reply-by-email copy anywhere", () => {
    for (const f of ["feedback.html", "feedback-thread.html"]) expect(fs.readFileSync(path.join(dist, f), "utf8")).not.toMatch(/type="email"|reply by email|email for a reply/i);
  });
});

describe("website analytics", () => {
  it("every page loads Vercel Web Analytics, and the docs say what it is", () => {
    // Bot sharing: /bot and /bots show someone's Bot from a link's fragment, so they load no analytics.
    for (const key of Object.keys(PAGES).filter((k) => !NO_ANALYTICS.has(k))) expect(seoHead(key, "0.1.3")).toContain('<script defer src="/_vercel/insights/script.js"></script>');
    expect(seoHead("bots", "0.1.3")).not.toContain("/_vercel/insights");
    expect(fs.readFileSync(path.join(__dirname, "../../site/docs.html"), "utf8")).toMatch(/Vercel Web Analytics: no cookies/);
  });
});

// Pressure test 2026-09-29 (U3): every page sent the visitor's IP to Google Fonts, and the privacy text didn't say so.
describe("fonts are self-hosted", () => {
  it("no page or stylesheet asks Google for anything; Geist is served from /assets/fonts with its licence", () => {
    const dist = build("2026-09-29");
    const files = [...fs.readdirSync(dist).filter((f) => f.endsWith(".html")).map((f) => path.join(dist, f)), built(dist, "site.css")];
    for (const f of files) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/googleapis|gstatic/);
    const css = fs.readFileSync(path.join(__dirname, "../../site/assets/site.css"), "utf8");
    expect(css).toMatch(/@font-face\{font-family:"Geist";[^}]*font-display:swap;[^}]*\/assets\/fonts\/geist-latin\.woff2/);
    expect(css).toMatch(/@font-face\{font-family:"Geist Mono";/);
    for (const f of ["geist-latin.woff2", "geist-latin-ext.woff2", "geist-mono-latin.woff2", "geist-mono-latin-ext.woff2", "OFL.txt"]) expect(fs.existsSync(path.join(__dirname, "../../site/assets/fonts", f)), f).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, "../../site/assets/fonts/OFL.txt"), "utf8")).toContain("SIL Open Font License");
  });
  it("the privacy section names GitHub's API and keeps the analytics line", () => {
    const docs = fs.readFileSync(path.join(__dirname, "../../site/docs.html"), "utf8");
    expect(docs).toMatch(/release info[^<]*from GitHub's API, so GitHub sees your IP address/);
    expect(docs).toMatch(/Vercel Web Analytics: no cookies/);
    expect(docs).not.toMatch(/Google Fonts/);
  });
});

// Pressure test 2026-09-29 (U5): no security headers, and the feedback form could be framed.
describe("security headers", () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vercel.json"), "utf8"));
  const on = (src: string) => Object.fromEntries(v.headers.filter((h: { source: string }) => h.source === src).flatMap((h: { headers: { key: string; value: string }[] }) => h.headers.map((x) => [x.key, x.value])));
  const all = on("/(.*)");
  it("every route gets a CSP that can't be framed, nosniff, a referrer policy and a minimal permissions policy", () => {
    const csp = all["Content-Security-Policy"];
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "img-src 'self' data:", "font-src 'self'", "object-src 'none'"]) expect(csp).toContain(d);
    expect(csp).toMatch(/connect-src 'self' https:\/\/api\.github\.com/);
    expect(csp).not.toMatch(/googleapis|gstatic|'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
    expect(all).toMatchObject({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" });
    expect(all["Permissions-Policy"]).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/);
    expect(on("/feedback/thread")).toMatchObject({ "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    expect(on("/stats")).toMatchObject({ "X-Robots-Tag": "noindex, nofollow" });
  });
  it("the only inline script that runs is the theme boot, and the CSP carries its hash", () => {
    const hash = crypto.createHash("sha256").update(themeBoot.replace(/^<script>|<\/script>$/g, "")).digest("base64");
    expect(all["Content-Security-Policy"]).toContain(`'sha256-${hash}'`);
    const dist = build("2026-09-29");
    for (const f of fs.readdirSync(dist).filter((x) => x.endsWith(".html"))) {
      const html = fs.readFileSync(path.join(dist, f), "utf8");
      const inlines = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/application\/(?:ld\+)?json/.test(m[1]!)).map((m) => m[0]); // data blocks never run (/bots embeds its list as JSON)
      expect(inlines.every((x) => x === themeBoot), f).toBe(true);
      expect(html, f).not.toMatch(/\son[a-z]+="/);
    }
  });
});

// Pressure test 2026-09-29 (B1–B3).
describe("hidden things stay hidden, wrong links say so, and a real 404", () => {
  const dist = build("2026-09-29");
  const css = fs.readFileSync(path.join(__dirname, "../../site/assets/site.css"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../../site/assets/feedback-thread.js"), "utf8");
  it("[hidden] beats any component's display", () => {
    expect(css).toContain("[hidden]{display:none !important}");
  });
  it("the link box, Copy and the reply box stay hidden until the code is well-formed", () => {
    expect(fs.readFileSync(path.join(__dirname, "../../site/feedback-thread.html"), "utf8")).toMatch(/<div class="fb-keep" data-keep hidden>/);
    expect(js).toContain("keep.hidden = !valid;");
    expect(js).toContain("if (valid && navigator.clipboard)");
    expect(js).toContain('if (!valid) return fail("This link isn\'t complete. Check you copied all of it.");');
  });
  it("with no record in this browser, a 404 says the conversation wasn't found", () => {
    expect(js).toContain(`fail(local ? "Couldn't load replies yet. Try again later." : "This conversation wasn't found. Check you copied the whole link.")`);
  });
  it("the sent message leaves this browser after the first successful load or 7 days", () => {
    expect(js).toMatch(/err\.hidden = true;\s*forget\(\);/);
    expect(js).toMatch(/Date\.now\(\) - l\.sentAt < GRACE_MS\)\) \{ forget\(\); return null; \}/);
  });
  it("404.html has the shared header and footer, one line, and links Home and Docs", () => {
    const html = fs.readFileSync(path.join(dist, "404.html"), "utf8");
    for (const t of ['class="site-header"', 'class="site-footer"', "<h1>This page doesn't exist.</h1>", '<a class="btn primary" href="/">Home</a>', '<a class="btn ghost" href="/docs">Docs</a>', 'content="noindex"']) expect(html).toContain(t);
    expect(html).not.toMatch(/<!--(HEADER|FOOTER|THEME)/);
  });
});

// Pressure test 2026-09-29 (G1–G6).
describe("layout, contrast, landmarks and the odd pages out", () => {
  const dist = build("2026-09-29");
  const page = (f: string) => fs.readFileSync(path.join(dist, f), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../../site/assets/site.css"), "utf8");
  it("the thread page reserves the space its script fills", () => {
    expect(page("feedback-thread.html")).toMatch(/<div class="fb-thread">[\s\S]*data-error[\s\S]*data-msgs[\s\S]*data-reply[\s\S]*<\/form>\s*<\/div>/);
    expect(css).toMatch(/\.fb-thread\{min-height:\d+px\}/);
  });
  it("muted text and the diff green pass WCAG AA; small UI text uses the muted token", () => {
    expect(css).toContain("--muted:#646469;");
    expect(css).toContain("--green:#2F7A47;");
    for (const sel of [".search kbd{", ".term .tl{", ".starter>span{"]) expect(css.split(sel)[1]!.split("}")[0]).toContain("color:var(--muted)");
  });
  it("every page has one <main>, and the footer headings are h2", () => {
    for (const f of fs.readdirSync(dist).filter((x) => x.endsWith(".html"))) expect(page(f).match(/<main[\s>]/g)?.length, f).toBe(1);
    expect(footer()).not.toContain("<h4>");
    expect(footer()).toContain("<h2>Product</h2>");
  });
  it("/stats gets the theme boot and the site's fonts, and stays noindex", () => {
    const s = page("stats.html");
    expect(s).toContain('localStorage.getItem("synapse-theme")');
    expect(s).toContain('href="/assets/fonts/geist-latin');
    expect(s).toContain('<meta name="robots" content="noindex, nofollow">');
  });
  it("'Built in the open' shows a GitHub link card until a count is shown", () => {
    expect(page("index.html")).toMatch(/<a class="gh-card" href="https:\/\/github\.com\/nyfeblade\/synapse" data-gh-card>/);
    expect(fs.readFileSync(path.join(__dirname, "../../site/assets/latest.js"), "utf8")).toContain('document.querySelectorAll("[data-gh-card]").forEach((el) => { el.hidden = true; });');
  });
  it("the theme button says the theme it switches to", () => {
    expect(header("home")).toContain('aria-label="Switch to dark theme"');
    expect(fs.readFileSync(path.join(__dirname, "../../site/assets/site.js"), "utf8")).toContain('`Switch to ${dark() ? "light" : "dark"} theme`');
  });
});

// Pressure test 2026-09-29 (nits).
describe("small things", () => {
  const dist = build("2026-09-29");
  const css = fs.readFileSync(path.join(__dirname, "../../site/assets/site.css"), "utf8");
  it("a skip link leads every page with the shared header to its <main id=\"main\">", () => {
    expect(header("docs").startsWith('<a class="skip" href="#main">Skip to content</a>')).toBe(true);
    for (const f of ["index.html", "docs.html", "changelog.html", "feedback.html", "feedback-thread.html", "404.html"]) expect(fs.readFileSync(path.join(dist, f), "utf8"), f).toContain('<main id="main"');
    expect(css).toContain(".skip:focus{top:12px}");
  });
  it("the textarea gets the same 2 px focus ring as every other control", () => {
    expect(css).toContain(".fb-field textarea:focus-visible,.fb-field input:focus-visible{outline:2px solid var(--ink)");
  });
  it("a message of only spaces is refused in the browser, like the server does", () => {
    for (const f of ["feedback.js", "feedback-thread.js"]) expect(fs.readFileSync(path.join(__dirname, "../../site/assets", f), "utf8"), f).toContain('box.setCustomValidity(box.value && !box.value.trim() ? "Write a message." : "")');
  });
  it("the JSON-LD version comes from CHANGELOG.md at build time, not the page source", () => {
    const latest = parseChangelog(fs.readFileSync(path.join(__dirname, "../../CHANGELOG.md"), "utf8")).find((r: { unreleased: boolean }) => !r.unreleased)!.version;
    const ld = JSON.parse(fs.readFileSync(path.join(dist, "index.html"), "utf8").match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    expect(ld.softwareVersion).toBe(latest);
    expect(fs.readFileSync(path.join(__dirname, "../../site/index.html"), "utf8")).not.toContain("softwareVersion");
  });
});

// Privacy Policy and Terms of Use (legal, 2026-09-29).
describe("site /privacy and /terms", () => {
  const dist = build("2026-09-29");
  const page = (f: string) => fs.readFileSync(path.join(dist, f), "utf8");
  it("are built with the shared pieces and their own SEO tags, indexed and in the sitemap", () => {
    for (const [key, f] of [["privacy", "privacy.html"], ["terms", "terms.html"]] as const) {
      const html = page(f);
      expect(html).not.toMatch(/<!--(SEO|HEADER|FOOTER|THEME)/);
      for (const t of ['class="site-header"', 'class="site-footer"', `<link rel="canonical" href="${SITE_URL}/${key}">`, '<main id="main"', 'class="summary"', "Effective <time"]) expect(html, f).toContain(t);
      expect(html, f).not.toContain("noindex");
      expect(sitemap("2026-09-29")).toContain(`<loc>${SITE_URL}/${key}</loc>`);
    }
  });
  it("every page's footer links Privacy, Terms, the Apache-2.0 licence and the trademark policy", () => {
    for (const t of ['href="/privacy">Privacy</a>', 'href="/terms">Terms</a>', ">Apache-2.0 licence</a>", "TRADEMARKS.md"]) expect(footer()).toContain(t);
    expect(footer()).not.toMatch(/\bMIT\b/);
    for (const f of fs.readdirSync(dist).filter((x) => x.endsWith(".html") && x !== "stats.html")) expect(page(f), f).toContain('href="/terms"');
  });
  it("the feedback page links both next to Send, and the docs link the policy", () => {
    expect(page("feedback.html")).toMatch(/type="submit">Send<\/button>\s*<p class="fb-legal">[^<]*<a href="\/privacy#feedback">Privacy<\/a> · <a href="\/terms">Terms<\/a>/);
    expect(page("docs.html")).toContain('<a href="/privacy">Privacy Policy</a>');
  });
  it("the home page says Apache-2.0 and its JSON-LD points at the licence", () => {
    const home = page("index.html");
    expect(home).not.toMatch(/\bMIT\b/);
    expect(home).toContain("<b>Apache-2.0</b>");
    const ld = JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    expect(ld.license).toBe("https://www.apache.org/licenses/LICENSE-2.0");
  });
  it("say what the code does: no email, the thread code in the fragment, Vercel, GitHub, no selling", () => {
    const privacy = page("privacy.html"), terms = page("terms.html");
    for (const t of ["no telemetry", "Vercel Web Analytics", "GitHub Releases", "private GitHub repository", "one-way hash", "We don't sell or share personal information", "Legitimate interests", "Standard Contractual Clauses", "under 13", "Do Not Track"]) expect(privacy).toContain(t);
    for (const t of ['"AS IS"', "Apache License 2.0", "To the maximum extent permitted by law", "Indemnity", "Severability", "without regard to conflict-of-law rules"]) expect(terms).toContain(t);
    for (const html of [privacy, terms]) {
      expect(html).not.toMatch(/mailto:|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(html).not.toMatch(/lawyer|draft/i);
    }
  });
});
