// /feedback: shows what will be hidden before sending (the same checks the server applies again), then
// sends the form with fetch and shows the result in place. Without JS the form is a plain POST to
// /api/feedback, which redirects back to /feedback?sent=1#sent (or ?error=…#failed).
import { cleanMessage, describeHidden, spamReason } from "./feedback-content.js";

const form = document.querySelector("[data-feedback]");
if (form) {
  const done = document.getElementById("sent"), failed = document.getElementById("failed");
  const err = form.querySelector("[data-error]"), hide = form.querySelector("[data-hide]"), box = form.querySelector("textarea[name=message]");
  const show = (el) => { el.classList.add("on"); el.focus(); };
  const q = new URLSearchParams(location.search);
  if (q.get("sent") === "1") { form.hidden = true; show(done); }
  else if (q.get("error")) show(failed);

  const preview = () => {
    const c = cleanMessage(box.value);
    const what = describeHidden(c.found);
    // The same checks the server makes: say what will be hidden, and why a message would be refused.
    hide.textContent = [what ? `We'll hide: ${what}` : "", spamReason(c.text)].filter(Boolean).join(" ");
    hide.hidden = !hide.textContent;
  };
  box.addEventListener("input", preview);
  preview();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.message = cleanMessage(data.message).text;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; err.hidden = true; failed.classList.remove("on");
    try {
      const r = await fetch(form.action, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(data) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "It didn't send. Try again in a moment.");
      // The private conversation link: the code only ever sits in the fragment.
      if (typeof j.thread === "string") {
        // So the thread page can show the message at once, before GitHub has it ready.
        try { localStorage.setItem(`synapse-feedback:${j.thread}`, JSON.stringify({ text: data.message, sentAt: Date.now() })); } catch { /* private window */ }
        location.assign(`/feedback/thread?sent=1#${j.thread}`);
        return;
      }
      form.hidden = true; history.replaceState(null, "", "/feedback?sent=1"); show(done);
    } catch (x) {
      err.textContent = x instanceof Error && x.message !== "Failed to fetch" ? x.message : "It didn't send. Check your connection and try again.";
      err.hidden = false;
    } finally { btn.disabled = false; }
  });
}
