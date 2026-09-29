// /feedback/thread#<code>: the sender's private conversation. The code lives in the URL fragment, which
// browsers never send to a server; it goes to /api/feedback/thread only as a request header.
import { cleanMessage, describeHidden, spamReason } from "./feedback-content.js";

const code = decodeURIComponent(location.hash.slice(1));
const $ = (s) => document.querySelector(s);
const msgs = $("[data-msgs]"), err = $("[data-error]"), form = $("[data-reply]"), link = $("[data-link]"), copy = $("[data-copy]");
const sent = new URLSearchParams(location.search).get("sent") === "1";
$("[data-sent]").classList.toggle("on", sent);

const url = `${location.origin}/feedback/thread#${code}`;
link.textContent = url;
if (navigator.clipboard) { copy.hidden = false; copy.addEventListener("click", () => navigator.clipboard.writeText(url).then(() => { copy.textContent = "Copied"; }, () => {})); }

const fail = (m) => { err.textContent = m; err.hidden = false; };
const when = (at) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

const GRACE_MS = 7 * 24 * 3600 * 1000;
const local = (() => { try { return JSON.parse(localStorage.getItem(`synapse-feedback:${code}`) || "null"); } catch { return null; } })();
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

async function load() {
  if (!/^[1-9]\d{0,9}\.[A-Za-z0-9_-]{22}$/.test(code)) return fail("This link isn't complete. Check you copied all of it.");
  try {
    const r = await fetch("/api/feedback/thread", { headers: { accept: "application/json", "x-feedback-code": code }, referrerPolicy: "no-referrer" });
    const j = await r.json().catch(() => ({}));
    // Just after sending, GitHub may not have it yet: that's "later", not "gone".
    if (r.status === 404) return fail(!local || Date.now() - local.sentAt < GRACE_MS ? "Couldn't load replies yet. Try again later." : "This conversation wasn't found.");
    if (!r.ok || !j.ok) return fail(j.error || "Couldn't load it. Try again later.");
    err.hidden = true;
    draw(j);
  } catch { fail("Couldn't load it. Check your connection and try again."); }
}

const box = form.querySelector("textarea"), hide = $("[data-hide]");
box.addEventListener("input", () => {
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
    if (!r.ok || !j.ok) throw new Error(j.error || "It didn't send. Try again in a moment.");
    box.value = ""; hide.hidden = true;
    await load();
  } catch (x) { fail(x instanceof Error ? x.message : "It didn't send."); } finally { btn.disabled = false; }
});

// Right after sending: the message is shown at once from this browser, with no replies yet.
if (local && typeof local.text === "string") draw({ messages: [{ from: "you", text: local.text, at: new Date(local.sentAt).toISOString() }] });
load();
