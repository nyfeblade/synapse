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
  const withSeo = (html, key) => html.replace(`<!--SEO:${key}-->`, seoHead(key, version));
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
