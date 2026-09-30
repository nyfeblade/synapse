// Builds the website into site/dist: the static pages as they are, plus the Changelog page rendered
// from the repo's CHANGELOG.md, so writing a changelog entry is all it takes to update the site.
// Node built-ins only (the Vercel build installs nothing): `node site/build.mjs`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { canonicalJson, scanShare, shareLinks, validateShare, SHARE_LIMITS } from "../shared/src/bot-share.js";
import { looksLikeInjection, stripHidden } from "../shared/src/feedback-content.js";
import { FORM_SPECS, FORM_OF, EYE_INK, formPath, botSvg, botDefs } from "../shared/src/bot-face.js";
import { versionKey } from "../security/report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDist = path.join(here, "dist");

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
  feedback: { file: "feedback.html", path: "/feedback", title: "Send feedback about Synapse", description: "Report a bug, suggest an idea or tell us what you think of Synapse, the open-source Mac app for a team of AI agents." },
  bots: { file: "bots.html", path: "/bots", title: "Synapse Bots: ready-made AI agents for your Mac", description: "Ready-made Bots for Synapse, the open-source Mac app for a team of AI agents. Add one in a click." },
  privacy: { file: "privacy.html", path: "/privacy", title: "Synapse Privacy Policy", description: "What Synapse, the open-source Mac app for a team of AI agents, and its website collect: no telemetry, no account, and feedback only when you send it." },
  terms: { file: "terms.html", path: "/terms", title: "Synapse Terms of Use", description: "The terms for using Synapse, the open-source Mac app for a team of AI agents, its website and its feedback system." },
};

/** Pages with their own tags that stay out of the sitemap: /bot only shows a Bot from its link's fragment. */
export const LINK_PAGES = {
  bot: { file: "bot.html", path: "/bot", title: "A Bot for Synapse", description: "A Bot someone shared with you. Add it to Synapse, the open-source Mac app for a team of AI agents.", noindex: true },
};
/**
 * Draft pages: built so they can be previewed, but noindex, out of the sitemap and linked from nowhere. To publish one,
 * move it into PAGES and link it from the footer.
 */
export const DRAFT_PAGES = {
  security: { file: "security-tests.html", path: "/security-tests", title: "Synapse security tests: the attacks it stops, per release", description: "Attacks a Bot could face, what Synapse does about each one, and the latest results. Anyone can run the tests: no API key needed.", noindex: true },
};
Object.assign(LINK_PAGES, DRAFT_PAGES);
/** Pages that show someone's Bot load no analytics script (it could record the link's fragment). */
export const NO_ANALYTICS = new Set(["bot", "bots"]);

const attr = (s) => esc(s).replace(/"/g, "&quot;");
/** The <head> tags a search engine or a link preview reads, for one page. */
export function seoHead(key, version) {
  const p = PAGES[key] ?? LINK_PAGES[key], url = `${SITE_URL}${p.path}`, image = `${SITE_URL}/assets/og.png`;
  const tags = [
    ...(p.noindex ? [`<meta name="robots" content="noindex">`] : []),
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
      downloadUrl: `${REPO}/releases`, license: "https://www.apache.org/licenses/LICENSE-2.0", codeRepository: REPO,
      author: { "@type": "Person", name: "nyfeblade", url: "https://github.com/nyfeblade" },
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(app).replace(/</g, "\\u003c")}</script>`);
  }
  // Vercel Web Analytics for the website only: cookie-free, no personal data; the app itself sends nothing.
  if (!NO_ANALYTICS.has(key)) tags.push(`<script defer src="/_vercel/insights/script.js"></script>`);
  return tags.join("\n");
}

export function sitemap(today) {
  const urls = Object.values(PAGES).map((p) => `  <url><loc>${SITE_URL}${p.path}</loc><lastmod>${today}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;

/* ---- Bots: drawn by shared/src/bot-face.js (the same file the /bot page loads in the browser) ---- */
export { FORM_SPECS, FORM_OF, EYE_INK, formPath, botSvg, botDefs };
/** <!--BOT:shape:#hex--> or <!--BOT:shape:#hex:classes--> → the inline avatar. */
export const expandBots = (html) => html.replace(/<!--BOT:(\w+):(#[0-9a-fA-F]{6})(?::([\w -]+))?-->/g, (_, s, c, k) => botSvg(s, c, k ?? ""));

/* ---- The shared header, footer and theme: one copy for every page ---- */
const GH = "https://github.com/nyfeblade/synapse";
/** Runs before paint so a saved theme never flashes the other one. */
export const themeBoot = `<script>try{var t=localStorage.getItem("synapse-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>`;
export function header(key) {
  const cur = (k) => (k === key ? ' aria-current="page"' : "");
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap"><nav>
    <a class="brand" href="/"><img src="/assets/icon.png" alt="" width="26" height="26">Synapse</a>
    <div class="nav-right"><div class="navlinks"><a href="/#features"${key === "home" ? ' aria-current="page"' : ""}>Features</a><a href="/docs"${cur("docs")}>Docs</a><a href="/changelog"${cur("changelog")}>Changelog</a><a href="${GH}" class="gh"><svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub<span data-stars hidden></span></a></div>
    <button class="theme" type="button" aria-label="Switch to dark theme"><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg></button>
    <a class="btn primary sm" href="${GH}/releases" data-dl>Download</a></div>
  </nav></div></header>`;
}
export function footer() {
  return `<footer class="site-footer"><div class="wrap">
  <div class="foot">
    <div class="foot-brand"><a class="brand" href="/"><img src="/assets/icon.png" alt="" width="26" height="26">Synapse</a></div>
    <div><h2>Product</h2><a href="${GH}/releases" data-dl>Download</a><a href="/#features">Features</a><a href="/bots">Bots</a><a href="/changelog">Changelog</a></div>
    <div><h2>Help</h2><a href="/docs">Docs</a><a href="/docs#install">Install</a><a href="/docs#troubleshooting">Troubleshooting</a><a href="/feedback">Send feedback</a></div>
    <div><h2>Project</h2><a href="${GH}">GitHub</a><a href="${GH}/issues">Report an issue</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${GH}/blob/main/LICENSE">Apache-2.0 licence</a><a href="${GH}/blob/main/TRADEMARKS.md">Trademarks</a></div>
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

/* ---- asset names: a content hash in every asset's file name, so browsers keep them for a year ---- */
/** Served under a fixed name: the share image, the favicon and the font licence. Everything else gets a hash. */
const FIXED = new Set(["og.png", "favicon.png", "fonts/OFL.txt"]);
const HASHABLE = /\.(?:css|js|woff2|png|webp|svg)$/;
export const hashOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
const walk = (dir, base = "") => fs.readdirSync(path.join(dir, base), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(dir, path.posix.join(base, e.name)) : [path.posix.join(base, e.name)]));

/**
 * Renames every asset in `dir` to name.<hash>.ext (site.css → site.3f2a0c9e1b.css), leaf first: a stylesheet's
 * url()s and a module's imports are rewritten to their hashed names before its own hash is taken, so a change in
 * anything a file loads changes that file's name too. Returns { "/assets/site.css": "/assets/site.3f2a0c9e1b.css", … }.
 */
export function hashAssets(dir) {
  const all = new Set(walk(dir));
  const done = new Map();
  const visit = (rel, stack) => {
    if (done.has(rel)) return done.get(rel);
    if (FIXED.has(rel) || !HASHABLE.test(rel)) { done.set(rel, rel); return rel; }
    if (stack.includes(rel)) throw new Error(`asset import cycle: ${[...stack, rel].join(" → ")}`);
    const file = path.join(dir, rel);
    let buf = fs.readFileSync(file);
    if (/\.(?:css|js)$/.test(rel)) {
      const next = [...stack, rel];
      buf = Buffer.from(buf.toString("utf8")
        .replace(/\/assets\/([\w./-]+\.[a-z0-9]+)(?=["'`)\s?#])/g, (m, ref) => (all.has(ref) ? `/assets/${visit(ref, next)}` : m))
        .replace(/(\bfrom\s*["']|\bimport\s*\(?\s*["'])\.\/([\w.-]+\.js)(?=["'])/g, (m, pre, ref) => {
          const r = path.posix.join(path.posix.dirname(rel), ref);
          return all.has(r) ? `${pre}./${path.posix.basename(visit(r, next))}` : m;
        }));
    }
    const out = rel.replace(/(\.[a-z0-9]+)$/, `.${hashOf(buf)}$1`);
    fs.writeFileSync(path.join(dir, out), buf);
    fs.rmSync(file);
    done.set(rel, out);
    return out;
  };
  for (const rel of all) visit(rel, []);
  return Object.fromEntries([...done].map(([rel, out]) => [`/assets/${rel}`, `/assets/${out}`]));
}
/** Every /assets/… reference in a page → its hashed name. */
export const renameAssets = (html, names) => html.replace(/\/assets\/[\w./-]+\.[a-z0-9]+(?=["')\s?#])/g, (m) => names[m] ?? m);

/* ---- The curated catalogue: site/bots/<slug>.json → /bots ---- */
const ENTRY_KEYS = ["slug", "blurb", "order", "addedAt", "payload"];
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
const realDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** A payload's link fragment, synchronously (Node's zlib is the same raw deflate the browser's CompressionStream is). */
export const fragmentSync = (payload) => `b1.${zlib.deflateRawSync(Buffer.from(canonicalJson(payload))).toString("base64url")}`;

/**
 * Every catalogue entry, checked with the app's own codec; a bad one fails the build (Vercel keeps the last good
 * deployment). Text that reads like a prompt injection is a warning. Sorted by order, then addedAt.
 */
export function loadCatalogue(dir = path.join(here, "bots")) {
  const entries = [], warnings = [], seen = new Set();
  if (!fs.existsSync(dir)) return { entries, warnings };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const bad = (why) => { throw new Error(`site/bots/${f}: ${why}`); };
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { bad("not valid JSON"); }
    if (!e || typeof e !== "object" || Array.isArray(e)) bad("not an entry");
    const extra = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k));
    if (extra.length) bad(`unknown field ${extra.join(", ")} (an entry has slug, blurb, order, addedAt and payload; never an author)`);
    if (typeof e.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(e.slug) || `${e.slug}.json` !== f) bad("the slug must be the file name (a-z, 0-9 and -)");
    if (seen.has(e.slug)) bad(`duplicate slug ${e.slug}`);
    seen.add(e.slug);
    if (typeof e.blurb !== "string" || !e.blurb.trim() || e.blurb.length > SHARE_LIMITS.blurb) bad(`the blurb must be 1 to ${SHARE_LIMITS.blurb} characters`);
    if (stripHidden(e.blurb).text !== e.blurb) bad("hidden characters in the blurb");
    if (typeof e.order !== "number" || !Number.isFinite(e.order)) bad("order must be a number");
    if (!realDate(e.addedAt)) bad("addedAt must be a real date, YYYY-MM-DD");
    const v = validateShare(e.payload);
    if (!v.ok) bad("invalid payload");
    if (v.hiddenRemoved) bad("hidden characters in the payload");
    if (JSON.stringify(stable(v.payload)) !== JSON.stringify(stable(e.payload))) bad("the payload isn't the canonical v1 share object (an unknown field, or a shape, model or colour the app would change)");
    const scan = scanShare(v.payload);
    if (scan.hiddenRemoved) bad("hidden characters in the payload");
    for (const x of scan.flags) warnings.push(`site/bots/${f}: ${x.field} reads like a prompt injection`);
    if (looksLikeInjection(e.blurb)) warnings.push(`site/bots/${f}: blurb reads like a prompt injection`);
    const fragment = fragmentSync(v.payload);
    if (fragment.length > SHARE_LIMITS.linkMaxChars) bad(`too big for a link (${fragment.length} characters, the limit is ${SHARE_LIMITS.linkMaxChars})`);
    entries.push({ slug: e.slug, blurb: e.blurb, order: e.order, addedAt: e.addedAt, payload: v.payload, fragment, links: shareLinks(fragment, SITE_URL) });
  }
  entries.sort((a, b) => a.order - b.order || a.addedAt.localeCompare(b.addedAt) || a.slug.localeCompare(b.slug));
  return { entries, warnings };
}

/** /bots: the cards (static, every field escaped), the tool chips, and the list as inert JSON for bots.js. */
export function renderCatalogue(tpl, entries) {
  const toolsOf = (e) => e.payload.tools.map((t) => t.name);
  const tools = [...new Set(entries.flatMap(toolsOf))].sort((a, b) => a.localeCompare(b));
  const chips = tools.map((t) => `<button type="button" class="bchip" data-tool="${attr(t)}" aria-pressed="false">${esc(t)}</button>`).join("");
  const cards = entries.map((e) => {
    const p = e.payload, q = [p.name, p.title, e.blurb, ...toolsOf(e)].join(" ").toLowerCase();
    return `<article class="bcard" data-slug="${attr(e.slug)}" data-tools="${attr(toolsOf(e).join("\n"))}" data-q="${attr(q)}"><a class="bcard-a" href="/bot#${attr(e.fragment)}">${botSvg(p.shape, p.color, "md")}<h3>${esc(p.name)}</h3><p>${esc(e.blurb)}</p><span class="bcard-by">Synapse</span></a></article>`;
  }).join("\n");
  const data = entries.map((e) => ({ slug: e.slug, name: e.payload.name, title: e.payload.title, blurb: e.blurb, tools: toolsOf(e), fragment: e.fragment, web: e.links.web, app: e.links.app }));
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return tpl.replace("<!--BOTS:CHIPS-->", () => chips).replace("<!--BOTS:CARDS-->", () => cards).replace("<!--BOTS:DATA-->", () => json);
}

/* ---- /security-tests: the security suite's latest results (security/results/<version>.json, written by
   `npm run security-suite`) ---- */
/** The newest results file, or null when there is none yet. */
export function loadSecurityResults(dir = path.join(here, "..", "security", "results")) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.json$/.test(f)).sort((a, b) => versionKey(b.slice(0, -5)).localeCompare(versionKey(a.slice(0, -5))));
  return files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) : null;
}

const RESULT_WORD = { ask: "Asks you first", deny: "Blocked", refused: "Refused", safe: "Neutralised", allow: "Went through", error: "Error" };
const catId = (c) => `sec-${String(c).replace(/[^a-z0-9-]/gi, "")}`;

export function renderSecurity(tpl, report) {
  if (!report) {
    return tpl.replace("<!--SECURITY:TOC-->", "").replace("<!--SECURITY:SUMMARY-->", "<p>No results yet. Run <code>npm run security-suite</code> to make the first report.</p>").replace("<!--SECURITY:BODY-->", "");
  }
  const s = report.summary;
  const cats = s.byCategory;
  const toc = cats.map((c) => `      <a href="#${catId(c.category)}">${esc(c.name)}</a>`).join("\n");
  const when = /^\d{4}-\d{2}-\d{2}$/.test(report.date) ? `<time datetime="${report.date}">${nice(report.date)}</time>` : "";
  const model = report.model?.status === "passed" ? "The optional model tier passed." : report.model?.status === "failed" ? "The optional model tier failed." : "The optional model tier wasn't run for this report.";
  const summary = `      <p class="note">Version ${esc(report.version)}${when ? `, ${when}` : ""}: <b>${s.passed} of ${s.total}</b> attacks stopped${s.failed.length ? `; not stopped: ${esc(s.failed.join(", "))}` : ""}. ${model}</p>
      <div class="scroll-x"><table>
        <thead><tr><th>Category</th><th>Stopped</th></tr></thead>
        <tbody>
${cats.map((c) => `          <tr><td><a href="#${catId(c.category)}">${esc(c.name)}</a></td><td>${c.passed} of ${c.total}</td></tr>`).join("\n")}
        </tbody>
      </table></div>`;
  const body = cats.map((c) => {
    const rows = report.scenarios.filter((r) => r.category === c.category).map((r) => `          <tr><td><span class="id">${esc(r.id)}</span>${esc(r.attack)}</td><td>${esc(r.expected)}</td><td>${r.pass ? esc(RESULT_WORD[r.outcome] ?? r.outcome) : `<b>Failed: ${esc(RESULT_WORD[r.outcome] ?? r.outcome)}</b>`}</td></tr>`).join("\n");
    return `      <h3 id="${catId(c.category)}">${esc(c.name)}</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Attack</th><th>Expected</th><th>Result</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table></div>`;
  }).join("\n");
  return tpl.replace("<!--SECURITY:TOC-->", () => toc).replace("<!--SECURITY:SUMMARY-->", () => summary).replace("<!--SECURITY:BODY-->", () => body);
}

/** Shared plain-JS files the pages import: copied into dist/assets, then hashed with the rest (leaf first). */
const SHARED_MODULES = ["feedback-content.js", "bot-face.js", "bot-share.js"];

/** `out`: site/dist, or another folder (tests build side by side without racing on one folder). */
export function build(today = new Date().toISOString().slice(0, 10), out = defaultDist) {
  const dist = out;
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.cpSync(path.join(here, "assets"), path.join(dist, "assets"), { recursive: true });
  // The feedback page's preview uses the same text checks as the app and /api/feedback: one file, copied in and
  // imported by feedback.js (hashed with the rest, so a new version is never paired with an old one).
  // /bot and /bots use the app's own share codec and Bot drawing the same way (bot-share.js imports its two
  // neighbours; hashAssets rewrites those imports leaf first).
  for (const f of SHARED_MODULES) fs.copyFileSync(path.join(here, "..", "shared", "src", f), path.join(dist, "assets", f));
  const names = hashAssets(path.join(dist, "assets"));
  const bustAssets = (html) => renameAssets(html, names);
  const releases = parseChangelog(fs.readFileSync(path.join(here, "..", "CHANGELOG.md"), "utf8"));
  const version = releases.find((r) => !r.unreleased)?.version ?? null;
  const withSeo = (html, key) => bustAssets(partials(html, key).replace(`<!--SEO:${key}-->`, seoHead(key, version)));
  fs.writeFileSync(path.join(dist, "index.html"), withSeo(fs.readFileSync(path.join(here, "index.html"), "utf8"), "home"));
  fs.writeFileSync(path.join(dist, "docs.html"), withSeo(fs.readFileSync(path.join(here, "docs.html"), "utf8"), "docs"));
  // A private-ish stats page: unlinked, noindex, not in the sitemap; public GitHub download counts only.
  fs.writeFileSync(path.join(dist, "stats.html"), bustAssets(partials(fs.readFileSync(path.join(here, "stats.html"), "utf8"), "stats")));
  for (const key of ["privacy", "terms"]) fs.writeFileSync(path.join(dist, PAGES[key].file), withSeo(fs.readFileSync(path.join(here, PAGES[key].file), "utf8"), key));
  fs.writeFileSync(path.join(dist, "feedback.html"), withSeo(fs.readFileSync(path.join(here, "feedback.html"), "utf8"), "feedback"));
  // The private conversation page (/feedback/thread, a rewrite in vercel.json, so /feedback stays a
  // plain page and not a folder): not in the sitemap, not indexed.
  fs.writeFileSync(path.join(dist, "feedback-thread.html"), bustAssets(partials(fs.readFileSync(path.join(here, "feedback-thread.html"), "utf8"), "feedback")));
  // Vercel serves 404.html for any path that isn't a page.
  fs.writeFileSync(path.join(dist, "404.html"), bustAssets(partials(fs.readFileSync(path.join(here, "404.html"), "utf8"), "404")));
  // /bot: a shared Bot, decoded in the browser from the link's fragment.
  fs.writeFileSync(path.join(dist, "bot.html"), withSeo(fs.readFileSync(path.join(here, "bot.html"), "utf8"), "bot"));
  // /bots: the curated catalogue (site/bots/*.json). A bad entry throws here and fails the build.
  const catalogue = loadCatalogue();
  for (const w of catalogue.warnings) console.warn(`site: warning: ${w}`);
  fs.writeFileSync(path.join(dist, "bots.html"), withSeo(renderCatalogue(fs.readFileSync(path.join(here, "bots.template.html"), "utf8"), catalogue.entries), "bots"));
  // /security-tests (a draft, see DRAFT_PAGES): the security suite's newest results.
  fs.writeFileSync(path.join(dist, "security-tests.html"), withSeo(renderSecurity(fs.readFileSync(path.join(here, "security-tests.template.html"), "utf8"), loadSecurityResults()), "security"));
  const { toc, body } = renderReleases(releases);
  const page = fs.readFileSync(path.join(here, "changelog.template.html"), "utf8").replace("<!--TOC-->", toc).replace("<!--RELEASES-->", body);
  fs.writeFileSync(path.join(dist, "changelog.html"), withSeo(page, "changelog"));
  fs.writeFileSync(path.join(dist, "sitemap.xml"), sitemap(today));
  fs.writeFileSync(path.join(dist, "robots.txt"), robots());
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`site: built ${build()}`);
