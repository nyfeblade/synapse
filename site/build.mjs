// Builds the website into site/dist: the static pages as they are, plus the Changelog page rendered
// from the repo's CHANGELOG.md, so writing a changelog entry is all it takes to update the site.
// Node built-ins only (the Vercel build installs nothing): `node site/build.mjs`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Inline Markdown: **bold**, `code` and [links](https://…). Everything else is text. */
export function inline(md) {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** "## 0.1.1 — Unreleased" or "## 0.1.0 — 2026-09-28 — beta" → one release. */
export function parseChangelog(md) {
  const releases = [];
  for (const part of md.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split("\n");
    const bits = head.split(/\s+—\s+/).map((s) => s.trim());
    const version = bits[0];
    const unreleased = bits.some((b) => /^unreleased$/i.test(b));
    const date = bits.find((b) => /^\d{4}-\d{2}-\d{2}$/.test(b)) ?? null;
    const label = bits.slice(1).find((b) => b !== date && !/^unreleased$/i.test(b)) ?? null;
    releases.push({ version, unreleased, date, label, body: rest.join("\n").trim() });
  }
  return releases;
}

/** The body: ### headings, "- " lists, paragraphs. */
export function renderBody(md) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    if (line.startsWith("### ")) { close(); out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith("- ")) { (list ??= []).push(`<li>${inline(line.slice(2))}</li>`); continue; }
    close(); out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join("\n");
}

/** Where the site is served. Change it here (or set SITE_URL) when the site moves to its own domain. */
export const SITE_URL = (process.env.SITE_URL || "https://synapse-site-virid.vercel.app").replace(/\/$/, "");
const REPO = "https://github.com/nyfeblade/synapse";

/** Each page's search title and description: written for what people search, not only the brand name. */
export const PAGES = {
  home: { file: "index.html", path: "/", title: "Synapse: a team of AI agents for your Mac", description: "Synapse is a free, open-source Mac app with a team of AI agents that chat, write code, take voice calls and use your Mac, powered by your own Anthropic API key." },
  docs: { file: "docs.html", path: "/docs", title: "Synapse Docs: install, API key and using your AI agents", description: "How to install Synapse on your Mac, add your Anthropic API key, work with your AI agents, and fix common problems." },
  changelog: { file: "changelog.html", path: "/changelog", title: "Synapse Changelog: what's new in each version", description: "Every version of Synapse, the open-source Mac app for a team of AI agents: new features, fixes and known issues." },
};

const attr = (s) => esc(s).replace(/"/g, "&quot;");
/** The <head> tags a search engine or a link preview reads, for one page. */
export function seoHead(key, version) {
  const p = PAGES[key], url = `${SITE_URL}${p.path}`, image = `${SITE_URL}/assets/og.png`;
  const tags = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${attr(p.description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Synapse">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${attr(p.title)}">`,
    `<meta property="og:description" content="${attr(p.description)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(p.title)}">`,
    `<meta name="twitter:description" content="${attr(p.description)}">`,
    `<meta name="twitter:image" content="${image}">`,
  ];
  if (key === "home") {
    const app = {
      "@context": "https://schema.org", "@type": "SoftwareApplication",
      name: "Synapse", description: p.description, url: SITE_URL, image,
      applicationCategory: "ProductivityApplication", operatingSystem: "macOS 14 or later (Apple silicon)",
      ...(version ? { softwareVersion: version } : {}),
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: `${REPO}/releases`, license: `${REPO}/blob/main/LICENSE`, codeRepository: REPO,
      author: { "@type": "Person", name: "nyfeblade", url: "https://github.com/nyfeblade" },
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(app).replace(/</g, "\\u003c")}</script>`);
  }
  return tags.join("\n");
}

export function sitemap(today) {
  const urls = Object.values(PAGES).map((p) => `  <url><loc>${SITE_URL}${p.path}</loc><lastmod>${today}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;

/* ---- Bots: the app's avatar (app/src/renderer/avatar/face-forms.ts, face-sim.ts) as plain SVG ----
   One formula for every body (a superellipse), the same face frame on every form: solid black eyes and
   mouth, a flat body colour, no highlight or rim. Motion (breathing, blinks) is CSS in site.css. */
const FORM_SPECS = {
  pebble: { a: 32, b: 30, n: 2.4, cy: 56 },
  orb: { a: 30, b: 30, n: 2, cy: 56 },
  tile: { a: 30, b: 29, n: 4.2, cy: 57 },
  capsule: { a: 26, b: 31.7, n: 2.6, cy: 54.3 },
  dome: { a: 31, b: 32, n: 2, cy: 58, nLow: 3.6, bLow: 28 },
  gem: { a: 34, b: 32, n: 1.55, cy: 54 },
};
/** The starter templates' shape ids → the form each draws (face-forms.ts FORM_OF). */
const FORM_OF = { pebble: "pebble", orb: "orb", tile: "tile", pill: "capsule", capsule: "capsule", dome: "dome", gem: "gem", puff: "pebble", bead: "dome", hex: "gem", diamond: "gem", shield: "tile", crescent: "orb", petal: "dome", stadium: "capsule", notch: "tile", wave: "pebble" };
export const EYE_INK = "#111110";
export function formPath(form, N = 72) {
  const f = FORM_SPECS[form];
  const r = (v) => Math.round(v * 10) / 10;
  let d = "";
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), s = Math.sin(t);
    const low = f.nLow && s > 0, n = low ? f.nLow : f.n, b = low ? f.bLow : f.b;
    d += (i ? "L" : "M") + r(50 + f.a * Math.sign(c) * Math.abs(c) ** (2 / n)) + " " + r(f.cy + b * Math.sign(s) * Math.abs(s) ** (2 / n));
  }
  return d + "Z";
}
/** One Bot: the body from the shared sprite, then the face. `cls` adds classes (motion, size). */
export function botSvg(shape, color, cls = "") {
  const form = FORM_OF[shape] ?? "pebble";
  return `<svg class="bot${cls ? " " + cls : ""}" viewBox="14 20 72 72" aria-hidden="true"><g class="bb"><use href="#f-${form}" fill="${color}"/><g class="face" fill="${EYE_INK}"><rect class="eye" x="36.3" y="45.5" width="6.4" height="13" rx="3.2"/><rect class="eye" x="57.3" y="45.5" width="6.4" height="13" rx="3.2"/><path class="mouth" d="M45.5 66.9Q50 70.9 54.5 66.9" fill="none" stroke="${EYE_INK}" stroke-width="2.6" stroke-linecap="round"/></g></g></svg>`;
}
/** The body forms, once per page, as symbols the avatars <use>. */
export const botDefs = () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.keys(FORM_SPECS).map((f) => `<path id="f-${f}" d="${formPath(f)}"/>`).join("")}</defs></svg>`;
/** <!--BOT:shape:#hex--> or <!--BOT:shape:#hex:classes--> → the inline avatar. */
export const expandBots = (html) => html.replace(/<!--BOT:(\w+):(#[0-9a-fA-F]{6})(?::([\w -]+))?-->/g, (_, s, c, k) => botSvg(s, c, k ?? ""));

/* ---- The shared header, footer and theme: one copy for every page ---- */
const GH = "https://github.com/nyfeblade/synapse";
/** Runs before paint so a saved theme never flashes the other one. */
export const themeBoot = `<script>try{var t=localStorage.getItem("synapse-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>`;
export function header(key) {
  const cur = (k) => (k === key ? ' aria-current="page"' : "");
  return `<header class="site-header"><div class="wrap"><nav>
    <a class="brand" href="/"><img src="/assets/icon.png" alt="" width="26" height="26">Synapse</a>
    <div class="nav-right"><div class="navlinks"><a href="/#features"${key === "home" ? ' aria-current="page"' : ""}>Features</a><a href="/docs"${cur("docs")}>Docs</a><a href="/changelog"${cur("changelog")}>Changelog</a><a href="${GH}" class="gh"><svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub<span data-stars hidden></span></a></div>
    <button class="theme" type="button" aria-label="Switch theme"><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg></button>
    <a class="btn primary sm" href="${GH}/releases" data-dl>Download</a></div>
  </nav></div></header>`;
}
export function footer() {
  return `<footer class="site-footer"><div class="wrap">
  <div class="foot">
    <div class="foot-brand"><a class="brand" href="/"><img src="/assets/icon.png" alt="" width="26" height="26">Synapse</a></div>
    <div><h4>Product</h4><a href="${GH}/releases" data-dl>Download</a><a href="/#features">Features</a><a href="/#starters">Starter Bots</a><a href="/changelog">Changelog</a></div>
    <div><h4>Help</h4><a href="/docs">Docs</a><a href="/docs#install">Install</a><a href="/docs#troubleshooting">Troubleshooting</a><a href="/docs#privacy">Privacy</a></div>
    <div><h4>Project</h4><a href="${GH}">GitHub</a><a href="${GH}/issues">Report an issue</a><a href="${GH}/blob/main/LICENSE">MIT licence</a></div>
  </div>
  <p class="legal">Synapse is open source and not affiliated with Anthropic. Claude is a trademark of Anthropic.</p>
  <div class="wordmark" aria-hidden="true">Synapse</div>
</div></footer>`;
}
/** Every shared piece a page's source leaves a placeholder for. */
export const partials = (html, key) => expandBots(html
  .replace("<!--THEME-->", themeBoot)
  .replace(`<!--HEADER:${key}-->`, header(key))
  .replace("<!--FOOTER-->", footer())
  .replace("<!--BOTDEFS-->", botDefs()));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nice = (d) => { const [y, m, day] = d.split("-").map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };
const anchor = (r) => (r.unreleased ? "next" : `v${r.version}`);

export function renderReleases(releases) {
  const toc = releases.map((r) => `      <a href="#${anchor(r)}">${r.unreleased ? `Next: ${esc(r.version)}` : `${esc(r.version)}${r.label ? ` ${esc(r.label)}` : ""}`}</a>`).join("\n");
  const body = releases.map((r) => {
    const when = r.unreleased
      ? '<span class="tag next">in progress</span>'
      : `${r.date ? `<time datetime="${r.date}">${nice(r.date)}</time>` : ""}${r.label ? `<span class="tag">${esc(r.label)}</span>` : ""}`;
    return `      <section class="release" id="${anchor(r)}">
        <div class="when">${when}</div>
        <div class="body"><h2>${esc(r.version)}</h2>
${renderBody(r.body)}
        </div>
      </section>`;
  }).join("\n\n");
  return { toc, body };
}

export function build(today = new Date().toISOString().slice(0, 10)) {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  for (const f of fs.readdirSync(path.join(here, "assets"))) fs.copyFileSync(path.join(here, "assets", f), path.join(dist, "assets", f));
  const releases = parseChangelog(fs.readFileSync(path.join(here, "..", "CHANGELOG.md"), "utf8"));
  const version = releases.find((r) => !r.unreleased)?.version ?? null;
  const withSeo = (html, key) => partials(html, key).replace(`<!--SEO:${key}-->`, seoHead(key, version));
  fs.writeFileSync(path.join(dist, "index.html"), withSeo(fs.readFileSync(path.join(here, "index.html"), "utf8"), "home"));
  fs.writeFileSync(path.join(dist, "docs.html"), withSeo(fs.readFileSync(path.join(here, "docs.html"), "utf8"), "docs"));
  const { toc, body } = renderReleases(releases);
  const page = fs.readFileSync(path.join(here, "changelog.template.html"), "utf8").replace("<!--TOC-->", toc).replace("<!--RELEASES-->", body);
  fs.writeFileSync(path.join(dist, "changelog.html"), withSeo(page, "changelog"));
  fs.writeFileSync(path.join(dist, "sitemap.xml"), sitemap(today));
  fs.writeFileSync(path.join(dist, "robots.txt"), robots());
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`site: built ${build()}`);
