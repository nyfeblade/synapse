// /feedback/thread#<code>: the sender's private conversation. The code lives in the URL fragment, which
// browsers never send to a server; it goes to /api/feedback/thread only as a request header.
import { cleanMessage, describeHidden, spamReason } from "./feedback-content.js";

const code = decodeURIComponent(location.hash.slice(1));
const $ = (s) => document.querySelector(s);
const msgs = $("[data-msgs]"), err = $("[data-error]"), form = $("[data-reply]"), link = $("[data-link]"), copy = $("[data-copy]"), keep = $("[data-keep]");
// Only a well-formed code gets the link box, Copy and the reply box; anything else only says the link is incomplete.
const valid = /^[1-9]\d{0,9}\.[A-Za-z0-9_-]{22}$/.test(code);
const sent = new URLSearchParams(location.search).get("sent") === "1";
$("[data-sent]").classList.toggle("on", sent);

const url = `${location.origin}/feedback/thread#${code}`;
link.textContent = url;
keep.hidden = !valid;
if (valid && navigator.clipboard) { copy.hidden = false; copy.addEventListener("click", () => navigator.clipboard.writeText(url).then(() => { copy.textContent = "Copied"; }, () => {})); }

const fail = (m) => { err.textContent = m; err.hidden = false; };
const when = (at) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

// The sent message, kept in this browser only until the server has it (first successful load) or for 7 days.
const GRACE_MS = 7 * 24 * 3600 * 1000;
const KEY = `synapse-feedback:${code}`;
const forget = () => { try { localStorage.removeItem(KEY); } catch { /* private window */ } };
const local = (() => {
  if (!valid) return null;
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || "null");
    if (l && !(Date.now() - l.sentAt < GRACE_MS)) { forget(); return null; }
    return l;
  } catch { return null; }
})();
const empty = $("[data-empty]");

function draw(j) {
  empty.hidden = j.messages.some((m) => m.from === "synapse");
  msgs.replaceChildren(...j.messages.map((m) => {
    const li = document.createElement("li");
    li.className = `fb-msg ${m.from === "synapse" ? "synapse" : "you"}`;
    const who = document.createElement("span");
    who.className = "fb-msg-from";
    who.textContent = `${m.from === "synapse" ? "Synapse" : "You"}${m.at ? ` · ${when(m.at)}` : ""}`;
    const text = document.createElement("span");
    text.className = "fb-msg-text";
    text.textContent = m.text; // plain text only
    li.append(who, text);
    return li;
  }));
  form.hidden = false;
}

// The owner deleted it: no messages, no reply box, nothing kept in this browser.
function gone() {
  forget();
  msgs.replaceChildren();
  empty.hidden = true;
  form.hidden = true;
  err.hidden = true;
  $("[data-deleted]").hidden = false;
}

async function load() {
  if (!valid) return fail("This link isn't complete. Check you copied all of it.");
  try {
    const r = await fetch("/api/feedback/thread", { headers: { accept: "application/json", "x-feedback-code": code }, referrerPolicy: "no-referrer" });
    const j = await r.json().catch(() => ({}));
    // Just after sending from this browser, GitHub may not have it yet: that's "later", not "gone".
    // With no record here, a 404 is a wrong or mistyped link.
    if (r.status === 404) return fail(local ? "Couldn't load replies yet. Try again later." : "This conversation wasn't found. Check you copied the whole link.");
    if (!r.ok || !j.ok) return fail(j.error || "Couldn't load it. Try again later.");
    if (j.status === "deleted") return gone();
    err.hidden = true;
    forget();
    draw(j);
  } catch { fail("Couldn't load it. Check your connection and try again."); }
}

const box = form.querySelector("textarea"), hide = $("[data-hide]");
box.addEventListener("input", () => {
  box.setCustomValidity(box.value && !box.value.trim() ? "Write a message." : ""); // only spaces counts as empty
  const c = cleanMessage(box.value), w = describeHidden(c.found);
  hide.textContent = [w ? `We'll hide: ${w}` : "", spamReason(c.text)].filter(Boolean).join(" ");
  hide.hidden = !hide.textContent;
});
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const r = await fetch("/api/feedback/thread", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-feedback-code": code }, body: JSON.stringify({ message: cleanMessage(box.value).text }), referrerPolicy: "no-referrer" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 410 && j.status === "deleted") return gone();
    if (!r.ok || !j.ok) throw new Error(j.error || "It didn't send. Try again in a moment.");
    box.value = ""; hide.hidden = true;
    await load();
  } catch (x) { fail(x instanceof Error ? x.message : "It didn't send."); } finally { btn.disabled = false; }
});

// Right after sending: the message is shown at once from this browser, with no replies yet.
if (local && typeof local.text === "string") draw({ messages: [{ from: "you", text: local.text, at: new Date(local.sentAt).toISOString() }] });
load();
