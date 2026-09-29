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

export function build() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  for (const f of ["index.html", "docs.html"]) fs.copyFileSync(path.join(here, f), path.join(dist, f));
  for (const f of fs.readdirSync(path.join(here, "assets"))) fs.copyFileSync(path.join(here, "assets", f), path.join(dist, "assets", f));
  const md = fs.readFileSync(path.join(here, "..", "CHANGELOG.md"), "utf8");
  const { toc, body } = renderReleases(parseChangelog(md));
  const page = fs.readFileSync(path.join(here, "changelog.template.html"), "utf8").replace("<!--TOC-->", toc).replace("<!--RELEASES-->", body);
  fs.writeFileSync(path.join(dist, "changelog.html"), page);
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`site: built ${build()}`);
