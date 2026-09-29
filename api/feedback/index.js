// POST /api/feedback: private feedback from the Synapse app ("Send privately") and the website's
// /feedback form. Each one becomes an issue in a PRIVATE GitHub repo.
//
// A Vercel serverless function. Node built-ins and global fetch only (the Vercel install step installs
// nothing). Configuration, in the Vercel project's environment variables:
//   FEEDBACK_REPO             owner/name of the private repo that receives the issues
//   FEEDBACK_GITHUB_TOKEN     a fine-grained token for that repo only: Issues read/write, Contents read/write
//   FEEDBACK_OWNER            the GitHub login whose "/reply " comments go back to the sender (see thread.js).
//                             Required when the repo belongs to an organisation; defaults to the repo's owner.
//   FEEDBACK_ALLOWED_ORIGINS  optional, comma-separated site origins allowed to post from a browser
// Without the first two it answers 503. It never logs a message, logs, a thread code or an IP address.
//
// Abuse limits: browser posts only from our site (Origin, or Sec-Fetch-Site: same-origin); a request with
// neither is accepted only as the app's (source "app"); a first-line in-memory limit per coarse IP on every
// POST, and a stricter one for app posts; and a durable global limit read from GitHub's issue and comment
// lists (never search), failing closed.
import crypto from "node:crypto";
import { isSpam } from "../../shared/src/feedback-content.js";
import {
  CAPS, GENERIC_REFUSAL, attachScreenshot, clientIp, contentKind, github, isBot, issueBody, issueTitle, labelsFor,
  LIMITS, RATE_APP, makeLimiter, makeRecent, newThreadSecret, postSource, readBody, redirect, sendJson, tally, threadFooter, today, tooBig, validate,
} from "../_lib/feedback-core.js";

export { validate, isBot } from "../_lib/feedback-core.js";

export function createHandler(deps = {}) {
  const now = deps.now || Date.now;
  const limiter = deps.limiter || makeLimiter(now);
  const appLimiter = deps.appLimiter || makeLimiter(now, RATE_APP);
  const recent = deps.recent || makeRecent(now);
  const log = deps.log || ((m) => console.error(m));
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetchImpl = deps.fetch || globalThis.fetch;
    const kind = contentKind(req);
    const form = kind === "form";
    const fail = (status, error) => (form
      ? redirect(res, `/feedback?error=${status === 429 ? "busy" : status === 503 ? "offline" : "invalid"}#failed`)
      : sendJson(res, status, { ok: false, error }));

    if (req.method !== "POST") { res.setHeader("allow", "POST"); return sendJson(res, 405, { ok: false, error: "Use POST." }); }
    const repo = env.FEEDBACK_REPO, token = env.FEEDBACK_GITHUB_TOKEN;
    if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(503, "Feedback isn't set up on this server: FEEDBACK_REPO and FEEDBACK_GITHUB_TOKEN are missing.");
    if (!kind) return sendJson(res, 415, { ok: false, error: "Send JSON or a form." });
    const from = postSource(req, env);
    if (!from) return sendJson(res, 403, { ok: false, error: "Not allowed." });
    // Every POST counts, valid or not; the app path (no Origin, which any script can copy) has a smaller budget too.
    const ip = clientIp(req);
    if (!limiter(ip) || (from === "app" && !appLimiter(ip))) return fail(429, "Too many at once. Try again in a few minutes.");

    // Size first, before anything is read or cleaned: a browser sends only a type and a message; the app
    // may add logs and a screenshot.
    const max = from === "web" ? LIMITS.webBody : LIMITS.body;
    if (tooBig(req, max)) return fail(413, "That's too big.");
    let body;
    try { body = await readBody(req, kind, max); } catch (e) { return fail(e.status || 400, e.status === 413 ? "That's too big." : "That couldn't be read."); }
    if (from === "app" && body?.source !== "app") return sendJson(res, 403, { ok: false, error: "Not allowed." });
    if (isBot(body)) return form ? redirect(res, "/feedback?sent=1#sent") : sendJson(res, 200, { ok: true });
    const v = validate(body);
    if (!v.ok) return fail(v.status, v.error);

    const gh = github(token, fetchImpl);
    // The durable limits. If they can't be read, nothing is filed: fail closed.
    let t;
    try {
      const [issues, comments] = await Promise.all([recent.issues(gh, repo), recent.comments(gh, repo)]);
      t = tally(issues, comments, now);
    } catch { log("feedback: recent lists unavailable"); return fail(503, "Feedback is busy right now. Try again later."); }
    if (t.created + t.followUps >= CAPS.perDay) return fail(429, "Synapse has had a lot of feedback today. Try again tomorrow.");
    // The same message within 24 hours is one spam signal; with another it's refused.
    if (t.hashes.has(v.value.hash)) {
      if (isSpam(v.value.message, ["duplicate"])) return fail(400, GENERIC_REFUSAL);
      v.value.flags.spam = true;
    }

    let shot = null;
    if (v.value.screenshot) {
      shot = t.shots < CAPS.screenshotsPerDay
        ? await attachScreenshot(gh, repo, v.value.screenshot, `${today(now)}-${crypto.randomBytes(6).toString("hex")}`)
        : false;
    }

    // The reply thread: the sender gets "<issue>.<secret>"; the issue stores only the secret's hash.
    const secret = newThreadSecret();
    const issue = { title: issueTitle(v.value), body: issueBody(v.value, shot, [threadFooter(secret)]), labels: labelsFor(v.value, !!shot) };
    let number = null;
    try {
      const r = await gh("POST", `/repos/${repo}/issues`, issue);
      if (!r.ok) { log(`feedback: GitHub answered ${r.status}`); return fail(502, "Couldn't send it. Try again later."); }
      number = (await r.json().catch(() => ({}))).number ?? null;
    } catch { log("feedback: GitHub unreachable"); return fail(502, "Couldn't send it. Try again later."); }
    recent.addIssue(repo, { number, created_at: new Date(now()).toISOString(), labels: issue.labels.map((name) => ({ name })), body: issue.body });
    const code = Number.isInteger(number) && number > 0 ? `${number}.${secret}` : null;
    // The code only ever travels in a response body or a URL fragment, never in a URL the server sees.
    if (form) return redirect(res, code ? `/feedback/thread?sent=1#${code}` : "/feedback?sent=1#sent");
    return sendJson(res, 200, { ok: true, ...(code ? { thread: code } : {}) });
  };
}

export default createHandler();
