import type { GithubEventKind } from "@synapse/shared";
import { LIMITS } from "@synapse/shared";
import { log } from "../util/log";
import type { TriggerEvent } from "./types";
import { obj, str, type O } from "./util";

export interface GithubMapped { kind: GithubEventKind; actor: string; branch?: string; subject: string; url?: string }

/** Webhook names ("pull_request_review") and REST events-API types ("PullRequestReviewEvent") → RTN-10's 14 kinds. */
export function mapGithubEvent(type: string, payload: O): GithubMapped | null {
  const t = type.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const action = str(payload.action);
  const actor = str(obj(payload.sender).login);
  const pr = obj(payload.pull_request);
  const prSubject = `PR #${str(pr.number)} ${str(pr.title)}`.trim();
  const prBase = { actor, subject: prSubject, url: str(pr.html_url) || undefined, branch: str(obj(pr.head).ref) || undefined };
  const mk = (kind: GithubEventKind, extra: Partial<GithubMapped> = {}): GithubMapped => ({ ...prBase, kind, ...extra });
  switch (t) {
    case "pull_request":
      if (action === "opened") return mk("prOpened");
      if (action === "synchronize") return mk("prPushed");
      if (action === "closed") return mk(pr.merged === true ? "prMerged" : "prClosed");
      if (action === "review_requested") return mk("reviewRequested");
      return null;
    case "pull_request_review": {
      if (action !== "submitted" && action !== "created") return null;
      const review = obj(payload.review);
      const state = str(review.state).toLowerCase();
      const kind = state === "approved" ? "reviewApproved" : state === "changes_requested" ? "reviewChangesRequested" : state === "commented" ? "reviewCommented" : null;
      return kind ? mk(kind, { url: str(review.html_url) || prBase.url }) : null;
    }
    case "pull_request_review_comment":
      return action === "created" ? mk("reviewComment", { url: str(obj(payload.comment).html_url) || prBase.url }) : null;
    case "pull_request_review_thread":
      return action === "resolved" ? mk("threadResolved") : action === "unresolved" ? mk("threadUnresolved") : null;
    case "issue_comment": {
      const issue = obj(payload.issue);
      if (action !== "created" || !issue.pull_request) return null;
      return { kind: "prCommented", actor, subject: `Comment on PR #${str(issue.number)} ${str(issue.title)}`.trim(), url: str(obj(payload.comment).html_url) || undefined };
    }
    case "issues": {
      const issue = obj(payload.issue);
      return action === "assigned" ? { kind: "issueAssigned", actor, subject: `Issue #${str(issue.number)} ${str(issue.title)}`.trim(), url: str(issue.html_url) || undefined } : null;
    }
    case "check_suite":
    case "workflow_run": {
      if (action !== "completed") return null;
      const run = obj(payload[t]);
      const branch = str(run.head_branch);
      return { kind: "ciCompleted", actor, branch: branch || undefined, subject: `CI ${str(run.conclusion) || "completed"} on ${branch || "?"}`, url: str(run.html_url) || undefined };
    }
    default:
      return null;
  }
}

export function githubEvent(m: GithubMapped, eventId: string, repo: string, occurredAt: number): TriggerEvent {
  return {
    source: "github", eventId, occurredAt, actor: m.actor, subject: m.subject, url: m.url, repo, branch: m.branch, kind: m.kind,
    text: `${m.kind} in ${repo} by ${m.actor || "someone"}: ${m.subject}${m.url ? `\n${m.url}` : ""}`,
    raw: { kind: m.kind, branch: m.branch ?? null },
  };
}

interface ApiEvent { id: string; type: string; actor?: { login?: string }; payload?: O; created_at?: string }

/** Fallback polling of the REST events API (ORIG-04 §04.3): ETag/If-None-Match, first poll = baseline. */
export class GithubPoller {
  private etag: string | null = null;
  private lastId: bigint | null = null;
  private timer: unknown = null;
  private everyMs: number;
  private stopped = false;
  private fails = 0;

  constructor(private d: { repo: string; token(): string | null; fetch?: typeof fetch; onEvent(ev: TriggerEvent): void; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void; everyMs?: number; onFailures?(n: number): void }) {
    this.everyMs = d.everyMs ?? LIMITS.githubPollMs;
  }

  /** Bug 51's sibling: consecutive failed polls, so a revoked token stops reading as connected. */
  consecutiveFailures(): number { return this.fails; }

  /** New credentials were entered: they get a fresh start rather than inheriting the old ones' failures. */
  resetFailures(): void { this.fails = 0; }

  private noteFails(n: number): void {
    if (this.fails === n) return;
    this.fails = n;
    this.d.onFailures?.(n);
  }

  start(): void {
    this.stopped = false;
    void this.poll().then(() => this.noteFails(0), (e) => {
      this.noteFails(this.fails + 1);
      log.warn("github poll failed", { repo: this.d.repo, error: String(e) });
    }).finally(() => {
      if (this.stopped) return; // stop() ran while the poll was in flight; don't re-arm an orphaned timer
      this.timer = this.d.setTimer(() => this.start(), this.everyMs);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  async poll(): Promise<number> {
    const token = this.d.token();
    if (!token) return 0;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.etag) headers["if-none-match"] = this.etag;
    const res = await (this.d.fetch ?? fetch)(`https://api.github.com/repos/${this.d.repo}/events?per_page=100`, { headers });
    if (res.status === 304) return 0;
    // A refused poll (a revoked token, a repo the token cannot see) is a failure, not "no new events":
    // start() counts it, and after N the routine offers Connect listener again (bug 51's sibling).
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${this.d.repo}`);
    this.etag = res.headers.get("etag");
    const pollS = Number(res.headers.get("x-poll-interval"));
    if (pollS * 1000 > this.everyMs) this.everyMs = pollS * 1000;
    const events = (await res.json()) as ApiEvent[];
    const newest = events.reduce((m, e) => (BigInt(e.id) > m ? BigInt(e.id) : m), this.lastId ?? 0n);
    if (this.lastId === null) {
      this.lastId = newest;
      return 0;
    }
    let n = 0;
    for (const e of [...events].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      if (BigInt(e.id) <= this.lastId) continue;
      const m = mapGithubEvent(e.type, { ...(e.payload ?? {}), sender: { login: e.actor?.login ?? "" } });
      if (!m) continue;
      n++;
      this.d.onEvent(githubEvent(m, e.id, this.d.repo, Date.parse(e.created_at ?? "") || this.d.now()));
    }
    this.lastId = newest;
    return n;
  }
}
