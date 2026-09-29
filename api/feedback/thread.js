// /api/feedback/thread: the sender's private view of their feedback, and follow-ups.
//
//   GET  with header X-Feedback-Code → { ok, status: "open"|"closed", messages: [{ from: "you"|"synapse", text, at }] }
//   POST with header X-Feedback-Code and { message } → adds a follow-up comment
//
// The code is "<issue number>.<128-bit secret>". The issue is read directly by number (no search) and
// its footer holds only the secret's sha256, compared in constant time. The code travels as a header,
// never in a URL, so it stays out of request logs. Replies are FEEDBACK_OWNER's comments that start
// with "/reply "; every other comment stays private. Nothing about who replied is ever returned: no
// login, name, avatar, email, profile link or exact time.
//
// Env: FEEDBACK_REPO, FEEDBACK_GITHUB_TOKEN, and FEEDBACK_OWNER (the login allowed to /reply). FEEDBACK_OWNER
// is REQUIRED when the repo belongs to an organisation; otherwise it defaults to the repo's owner.
// Unknown or wrong code → 404 with no detail.
import { cleanReply, stripHidden } from "../../shared/src/feedback-content.js";
import {
  CAPS, GENERIC_REFUSAL, LIMITS, UNTRUSTED_HEADER, checkText, clientIp, followUpBody, footerHash, github, hashMatches, makeLimiter, makeRecent,
  originAllowed, parseCode, readBody, sendJson, tally, tooBig,
} from "../_lib/feedback-core.js";

const FOLLOW_UP_MARK = "**Follow-up from the sender**";
/** To the minute: enough to read a conversation, not enough to identify anyone. */
const minute = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(Math.floor(t / 60_000) * 60_000).toISOString() : null; };
/** The text inside the first fenced block (the sender's own words). */
function fencedText(body) {
  const m = String(body || "").match(/\n(`{3,})text\n([\s\S]*?)\n\1(?:\n|$)/);
  return m ? stripHidden(m[2]).text : "";
}
const isFollowUp = (c) => String(c.body || "").startsWith(UNTRUSTED_HEADER) && String(c.body).includes(FOLLOW_UP_MARK);

export function createThreadHandler(deps = {}) {
  const now = deps.now || Date.now;
  const readLimiter = deps.readLimiter || makeLimiter(now, { perSource: 60, perInstance: 600 });
  const writeLimiter = deps.writeLimiter || makeLimiter(now);
  const recent = deps.recent || makeRecent(now);
  const log = deps.log || ((m) => console.error(m));
  // Per issue number: its footer hash and whether it can be a thread (5 minutes), or "not found" (60 s),
  // so guessed codes are turned away without a GitHub call each.
  const known = new Map();
  const remember = (n, v) => { if (known.size > 5000) known.clear(); known.set(n, { ...v, at: now() }); };
  const recall = (n) => { const k = known.get(n); return k && now() - k.at < (k.missing ? 60_000 : 5 * 60_000) ? k : null; };
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const repo = env.FEEDBACK_REPO, token = env.FEEDBACK_GITHUB_TOKEN;
    const owner = String(env.FEEDBACK_OWNER || String(repo || "").split("/")[0] || "").toLowerCase();
    const notFound = () => sendJson(res, 404, { ok: false });
    const later = () => sendJson(res, 503, { ok: false, error: "Try again later." });
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("allow", "GET, POST"); return sendJson(res, 405, { ok: false }); }
    if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(res, 503, { ok: false, error: "Feedback isn't set up on this server." });
    if (!originAllowed(req, env)) return sendJson(res, 403, { ok: false });
    const limiter = req.method === "GET" ? readLimiter : writeLimiter;
    if (!limiter(clientIp(req))) return sendJson(res, 429, { ok: false, error: "Too many at once. Try again in a few minutes." });
    const code = parseCode(req.headers["x-feedback-code"]);
    if (!code) return notFound();
    // A follow-up is only a message: anything bigger is refused before GitHub is asked or any text is cleaned.
    if (req.method === "POST" && tooBig(req, LIMITS.webBody)) return sendJson(res, 413, { ok: false, error: "That's too big." });
    const gh = github(token, deps.fetch || globalThis.fetch);

    try {
      const k = recall(code.number);
      if (k && (k.missing || !k.thread || !hashMatches(k.hash, code.secret))) return notFound();
      const ir = await gh("GET", `/repos/${repo}/issues/${code.number}`);
      if (ir.status === 404 || ir.status === 410) { remember(code.number, { missing: true }); return notFound(); }
      if (!ir.ok) { log(`feedback thread: GitHub answered ${ir.status}`); return later(); }
      const issue = await ir.json();
      const isFeedback = (issue.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === "feedback");
      const hash = footerHash(issue.body);
      remember(code.number, { thread: !issue.pull_request && isFeedback && !!hash, hash });
      if (issue.pull_request || !isFeedback || !hashMatches(hash, code.secret)) return notFound();

      const cr = await gh("GET", `/repos/${repo}/issues/${code.number}/comments?per_page=100`);
      if (!cr.ok) { log(`feedback thread: GitHub answered ${cr.status}`); return later(); }
      const comments = await cr.json();
      const followUps = comments.filter(isFollowUp);

      if (req.method === "GET") {
        const messages = [{ from: "you", text: fencedText(issue.body), at: minute(issue.created_at) }];
        for (const c of comments) {
          const body = String(c.body || "");
          const login = String(c.user?.login || "").toLowerCase();
          if (isFollowUp(c)) messages.push({ from: "you", text: fencedText(body), at: minute(c.created_at) });
          else if (login && login === owner && /^\/reply[ \n]/.test(body)) {
            const text = cleanReply(body.replace(/^\/reply[ \n]/, "")).trim();
            if (text) messages.push({ from: "synapse", text, at: minute(c.created_at) });
          }
        }
        return sendJson(res, 200, { ok: true, status: issue.state === "closed" ? "closed" : "open", messages });
      }

      // POST: a follow-up, through the same checks as a new message.
      if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return sendJson(res, 415, { ok: false, error: "Send JSON." });
      let body;
      try { body = await readBody(req, "json", LIMITS.webBody); } catch (e) { return sendJson(res, e.status === 413 ? 413 : 400, { ok: false, error: e.status === 413 ? "That's too big." : "That couldn't be read." }); }
      const t = checkText(body?.message);
      if (!t.ok) return sendJson(res, t.status, { ok: false, error: t.error });
      if (followUps.length >= CAPS.followUpsPerThread) return sendJson(res, 429, { ok: false, error: "This conversation is full. Send new feedback instead." });
      let day;
      try {
        const [issues, recentComments] = await Promise.all([recent.issues(gh, repo), recent.comments(gh, repo)]);
        day = tally(issues, recentComments, now);
      } catch { log("feedback thread: recent lists unavailable"); return later(); }
      if (day.created + day.followUps >= CAPS.perDay) return sendJson(res, 429, { ok: false, error: "Synapse has had a lot of feedback today. Try again tomorrow." });
      const commentBody = followUpBody(t.value);
      const post = await gh("POST", `/repos/${repo}/issues/${code.number}/comments`, { body: commentBody });
      if (!post.ok) { log(`feedback thread: GitHub answered ${post.status}`); return sendJson(res, 502, { ok: false, error: "Couldn't send it. Try again later." }); }
      recent.addComment(repo, { created_at: new Date(now()).toISOString(), body: commentBody });
      const labels = [...(t.value.abusive ? ["needs-review"] : []), ...(t.value.injection ? ["possible-injection"] : []), ...(t.value.hiddenRemoved ? ["hidden-text-removed"] : []), ...(t.value.spam ? ["possible-spam"] : [])];
      if (labels.length) await gh("POST", `/repos/${repo}/issues/${code.number}/labels`, { labels }).catch(() => null);
      return sendJson(res, 200, { ok: true });
    } catch {
      log("feedback thread: GitHub unreachable");
      return sendJson(res, 502, { ok: false, error: GENERIC_REFUSAL });
    }
  };
}

export default createThreadHandler();
