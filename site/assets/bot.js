// /bot#b1.… : a shared Bot, decoded here in the browser (nothing is sent anywhere; the fragment never
// leaves the page), drawn with its face, tools, skills and instructions as plain text, and handed to the
// app with "Add to Synapse". /bots opens the same preview in a dialog (renderBot, addToSynapse).
//
// Every field is set with textContent. No analytics on this page (vercel.json and build.mjs).
import { decodeShare, scanShare, runsCode, fragmentOf, shareLinks, botpackFiles, zipStore } from "./bot-share.js";
import { botNode } from "./bot-face.js";

const RELEASES = "https://github.com/nyfeblade/synapse/releases";
const APP_WAIT_MS = 1500, UPDATE_WAIT_MS = 3000, PENDING_DAYS = 7;
const FIELD = { name: "Name", title: "Title", instructions: "Instructions" };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private window */ } },
};

const q = (root, sel) => root.querySelector(sel);
const text = (el, s) => { if (el) el.textContent = s; return el; };
const chip = (s, cls = "") => text(Object.assign(document.createElement("span"), { className: `bp-chip${cls ? " " + cls : ""}` }), s);
const show = (el, on = true) => { if (el) el.hidden = !on; };
const fieldLabel = (f) => FIELD[f] ?? (f.startsWith("skill:") ? `Skill: ${f.slice(6)}` : f.startsWith("tool:") ? `Tool: ${f.slice(5)}` : f);

/** Decodes a fragment and cleans it: { ok, payload, flags, hiddenRemoved } or { ok: false, message }. */
export async function readFragment(fragment) {
  const d = await decodeShare(fragment);
  if (!d.ok) return d;
  const s = scanShare(d.payload);
  return { ok: true, payload: s.payload, flags: s.flags, hiddenRemoved: d.hiddenRemoved || s.hiddenRemoved };
}

/** Fills a preview (the .bp-card markup) with one Bot. */
export function renderBot(root, r) {
  const p = r.payload;
  const face = q(root, "[data-face]");
  face.replaceChildren(botNode(document, p.shape, p.color, "lg"));
  text(q(root, "[data-name]"), p.name);
  const title = q(root, "[data-title]");
  text(title, p.title);
  show(title, !!p.title);
  const tools = q(root, "[data-tools]");
  tools.replaceChildren(...p.tools.map((t) => chip(t.name)));
  show(q(root, '[data-row="tools"]'), p.tools.length > 0);
  const skills = q(root, "[data-skills]");
  skills.replaceChildren(...p.skills.map((s) => {
    const row = document.createElement("div");
    row.className = "bp-skill";
    row.append(text(document.createElement("span"), s.name));
    if (runsCode(s.files)) row.append(chip("Runs code", "warn"));
    return row;
  }));
  show(q(root, '[data-row="skills"]'), p.skills.length > 0);
  const flags = [...r.flags.map((f) => fieldLabel(f.field)), ...(r.hiddenRemoved ? ["Hidden characters removed"] : [])];
  q(root, "[data-flags]").replaceChildren(...flags.map((f) => chip(f, "warn")));
  show(q(root, '[data-row="flags"]'), flags.length > 0);
  text(q(root, "[data-instructions]"), p.instructions);
  show(q(root, "[data-instructions]")?.closest(".bp-section"), !!p.instructions);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
/** A .botpack of this Bot, made here (no memories, no routines, no author). */
export function saveBotpack(payload) {
  const id = crypto.randomUUID ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => ((Math.random() * 16) | 0).toString(16));
  const bytes = zipStore(botpackFiles(payload, id, Date.now()));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${slug(payload.name)}.botpack` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * "Add to Synapse": opens synapse://import#…. If the page loses focus or goes hidden within 1.5 s the app
 * opened (remembered). Otherwise `onNoApp` runs. With the app seen before, "Nothing happened?" shows after
 * 3 s either way (an older app opens but ignores the import route).
 */
export function addToSynapse(fragment, { onNoApp, onMaybeOld }) {
  const hadApp = store.get("hasApp") === "1";
  let left = false;
  const leave = () => { left = true; };
  const vis = () => { if (document.hidden) left = true; };
  addEventListener("blur", leave);
  document.addEventListener("visibilitychange", vis);
  location.href = shareLinks(fragment).app;
  setTimeout(() => {
    if (left) store.set("hasApp", "1");
    else if (!hadApp) { removeEventListener("blur", leave); document.removeEventListener("visibilitychange", vis); onNoApp(); }
  }, APP_WAIT_MS);
  if (hadApp) setTimeout(() => { removeEventListener("blur", leave); document.removeEventListener("visibilitychange", vis); onMaybeOld(); }, UPDATE_WAIT_MS);
}

/** Kept when the app isn't installed yet: /bot or /bots offer it again for 7 days. */
export function savePending(fragment, name) { store.set("pendingBot", JSON.stringify({ fragment, name, at: Date.now() })); }
export function readPending() {
  try {
    const p = JSON.parse(store.get("pendingBot") || "null");
    if (!p || typeof p.fragment !== "string" || typeof p.name !== "string" || Date.now() - p.at > PENDING_DAYS * 864e5) { store.del("pendingBot"); return null; }
    return p;
  } catch { store.del("pendingBot"); return null; }
}
export function clearPending() { store.del("pendingBot"); }

/** Wires one preview's buttons: Add, Save .botpack, and the no-app fallback. */
export function wireActions(root, fragment, payload) {
  const add = q(root, "[data-add]"), dl = q(root, "[data-download]"), save = q(root, "[data-save]");
  const copied = q(root, "[data-copied]"), update = q(root, "[data-update]");
  add.onclick = () => {
    show(update, false);
    addToSynapse(fragment, {
      onNoApp: () => { savePending(fragment, payload.name); show(add, false); show(dl, true); dl.focus(); },
      onMaybeOld: () => show(update, true),
    });
  };
  save.onclick = () => saveBotpack(payload);
  dl.onclick = () => {
    // The click is the user gesture the clipboard needs: the link is ready to paste in the app's last setup step.
    navigator.clipboard?.writeText(shareLinks(fragment, location.origin).web).then(() => show(copied, true), () => {});
  };
}

/** /bot and /bots: "Add <name> to Synapse" for a Bot saved before the app was installed. */
export function offerPending(root, skip) {
  const p = readPending();
  const box = q(root, "[data-pending]");
  if (!p || !box || p.fragment === skip) return;
  const b = q(box, "[data-pending-add]");
  text(b, `Add ${p.name} to Synapse`);
  b.onclick = () => { location.href = shareLinks(p.fragment).app; };
  show(box, true);
}

async function main() {
  const root = document.querySelector("[data-bot]");
  const fragment = fragmentOf(location.hash);
  offerPending(root, fragment);
  if (!fragment) { show(q(root, "[data-empty]"), !readPending()); return; }
  const r = await readFragment(fragment);
  if (!r.ok) { show(text(q(root, "[data-error]"), r.message), true); return; }
  document.title = `${r.payload.name} · Synapse`;
  renderBot(root, r);
  wireActions(root, fragment, r.payload);
  show(q(root, "[data-card]"), true);
  performance.mark?.("bot-rendered");
}

if (document.body.dataset.page === "bot") {
  void main();
  addEventListener("hashchange", () => location.reload());
}
