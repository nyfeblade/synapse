// Adds a Bot to the website's catalogue from its share link, without the app:
//   node site/bots/add.mjs "<share link>" --blurb "What it does." [--order 100] [--dir site/bots]
// It decodes the link with the app's own codec and writes site/bots/<slug>.json. Publishing is committing that
// file and pushing; the build checks it again (node site/build.mjs). Entries never carry an author.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeShare, SHARE_LIMITS } from "../../shared/src/bot-share.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bot";

/** Writes the entry and returns its path. Refuses a damaged link, an empty or long blurb, and an existing file. */
export async function addEntry(link, { blurb, order = 100, dir = here, today = new Date().toISOString().slice(0, 10), slug } = {}) {
  const d = await decodeShare(link);
  if (!d.ok) throw new Error(d.message);
  const b = String(blurb ?? "").trim();
  if (!b || b.length > SHARE_LIMITS.blurb) throw new Error(`The blurb must be 1 to ${SHARE_LIMITS.blurb} characters.`);
  const s = slug ?? slugify(d.payload.name);
  const file = path.join(dir, `${s}.json`);
  if (fs.existsSync(file)) throw new Error(`${path.relative(process.cwd(), file)} already exists.`);
  fs.writeFileSync(file, `${JSON.stringify({ slug: s, blurb: b, order: Number(order), addedAt: today, payload: d.payload }, null, 2)}\n`);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const blurb = opt("blurb"), order = opt("order"), dir = opt("dir"), slug = opt("slug");
  const link = args[0];
  if (!link) { console.error('Usage: node site/bots/add.mjs "<share link>" --blurb "What it does."'); process.exit(2); }
  try {
    const file = await addEntry(link, { blurb, ...(order ? { order } : {}), ...(dir ? { dir: path.resolve(dir) } : {}), ...(slug ? { slug } : {}) });
    console.log(`Wrote ${file}`);
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
