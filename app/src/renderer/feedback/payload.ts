import { FEEDBACK_ISSUE_PREFIX, FEEDBACK_MAX_ISSUE_URL, STRF, cleanMessage, stripHidden, type FeedbackPayload, type FeedbackType } from "@synapse/shared";

/** What main gathers for the sheet: versions, the Mac's model, and the scrubbed logs. */
export interface FeedbackContext { appVersion: string; macos: string; model: string; logs: string }
export interface FeedbackDraft { type: FeedbackType | null; message: string; includeLogs: boolean; includeScreenshot: boolean }

/**
 * The one object "Send privately" posts. The preview is drawn from this same object, so what the
 * user reads is exactly what goes. Null while something required is missing.
 */
export function buildPayload(d: FeedbackDraft, ctx: FeedbackContext | null, screenshot: string | null): FeedbackPayload | null {
  // The same cleaning the server applies: hidden characters removed, personal details hidden.
  const message = cleanMessage(d.message).text;
  if (!d.type || !ctx || !message) return null;
  const meta = (v: string) => stripHidden(v).text;
  return {
    source: "app", type: d.type, message,
    appVersion: meta(ctx.appVersion), macos: meta(ctx.macos), model: meta(ctx.model),
    ...(d.includeLogs && ctx.logs ? { logs: ctx.logs } : {}),
    ...(d.includeScreenshot && screenshot ? { screenshot } : {}),
  };
}

/** A fence longer than any run of backticks in the text, so nothing inside can close it. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

function issueBody(p: FeedbackPayload, logs: string | null, cut: boolean): string {
  const parts = [p.message, "", `**${STRF.app}** ${p.appVersion} · **${STRF.macos}** ${p.macos.replace(/^macOS\s*/, "")} · **${STRF.mac}** ${p.model}`];
  if (p.screenshot) parts.push("", `_${STRF.githubNoScreenshot}_`);
  if (logs !== null) {
    const f = fence(logs);
    parts.push("", `<details><summary>Logs${cut ? ` (${STRF.githubLogsCutNote.toLowerCase()})` : ""}</summary>`, "", `${f}text`, logs, f, "", "</details>");
  }
  return parts.join("\n");
}

const url = (title: string, body: string) => `${FEEDBACK_ISSUE_PREFIX}${new URLSearchParams({ title, body, labels: "feedback" }).toString()}`;

/**
 * "Post on GitHub": a prefilled new issue on the public repo. The link must stay under GitHub's
 * length limit, so the logs keep their newest lines and lose the oldest, and say so.
 */
export function githubIssueUrl(p: FeedbackPayload): { url: string; logsCut: boolean } {
  const firstLine = p.message.split("\n")[0]!.trim();
  const title = `[${STRF.types[p.type]}] ${firstLine.length > 70 ? `${firstLine.slice(0, 69)}…` : firstLine}`;
  const lines = p.logs ? p.logs.split("\n") : null;
  const full = url(title, issueBody(p, p.logs ?? null, false));
  if (full.length <= FEEDBACK_MAX_ISSUE_URL) return { url: full, logsCut: false };
  if (lines) {
    // Binary search for the most recent lines that fit.
    let lo = 0, hi = lines.length - 1, best: string | null = null;
    while (lo <= hi) {
      const keep = Math.floor((lo + hi) / 2);
      const u = url(title, issueBody(p, lines.slice(lines.length - keep).join("\n"), true));
      if (u.length <= FEEDBACK_MAX_ISSUE_URL) { best = u; lo = keep + 1; } else hi = keep - 1;
    }
    if (best) return { url: best, logsCut: true };
  }
  // Even the message alone is too long: cut it too.
  let msg = p.message;
  let u = url(title, issueBody({ ...p, message: msg }, null, false));
  while (u.length > FEEDBACK_MAX_ISSUE_URL && msg.length > 0) {
    msg = msg.slice(0, Math.floor(msg.length * 0.9));
    u = url(title, issueBody({ ...p, message: `${msg}…` }, null, false));
  }
  return { url: u, logsCut: !!lines };
}
