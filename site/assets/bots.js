// /bots: the curated catalogue. Search and tool chips filter the cards on the page; a card opens its Bot in a
// dialog (the same preview as /bot, no page load) and sets #<slug> so the view can be shared. Every field is set
// with textContent; the list is inert JSON the build wrote.
import { readFragment, renderBot, wireActions, offerPending } from "./bot.js";

const page = document.querySelector("[data-bots]");
const dialog = document.querySelector("[data-dialog]");
const data = JSON.parse(document.getElementById("bots-data").textContent || "[]");
const bySlug = new Map(data.map((b) => [b.slug, b]));
const cards = [...document.querySelectorAll(".bcard")];
const chips = [...document.querySelectorAll(".bchip")];
const search = page.querySelector("[data-search]");
const none = page.querySelector("[data-none]");

function filter() {
  const q = search.value.trim().toLowerCase();
  const tools = chips.filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.dataset.tool);
  let shown = 0;
  for (const card of cards) {
    const has = (card.dataset.tools || "").split("\n");
    const ok = (!q || card.dataset.q.includes(q)) && tools.every((t) => has.includes(t));
    card.hidden = !ok;
    if (ok) shown++;
  }
  none.hidden = shown > 0;
}
search.addEventListener("input", filter);
for (const c of chips) c.addEventListener("click", () => { c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"); filter(); });

const clearHash = () => history.replaceState(null, "", location.pathname + location.search);
async function open(slug) {
  const b = bySlug.get(slug);
  if (!b) return;
  const r = await readFragment(b.fragment);
  const err = dialog.querySelector("[data-error]");
  if (!r.ok) { err.textContent = r.message; err.hidden = false; return; }
  err.hidden = true;
  // A fresh start for this Bot: Add is back, the no-app fallback and its lines are hidden.
  for (const [sel, hide] of [["[data-add]", false], ["[data-download]", true], ["[data-copied]", true], ["[data-update]", true]]) dialog.querySelector(sel).hidden = hide;
  renderBot(dialog, r);
  wireActions(dialog, b.fragment, r.payload);
  if (location.hash !== `#${slug}`) history.replaceState(null, "", `#${slug}`);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("[data-add]").focus();
}
for (const card of cards) {
  card.querySelector("a").addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab still gets /bot
    e.preventDefault();
    void open(card.dataset.slug);
  });
}
dialog.addEventListener("close", clearHash);
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
addEventListener("hashchange", () => { const s = decodeURIComponent(location.hash.slice(1)); if (bySlug.has(s)) void open(s); });

offerPending(page, null);
const first = decodeURIComponent(location.hash.slice(1));
if (bySlug.has(first)) void open(first);
