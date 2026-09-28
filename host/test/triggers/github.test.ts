import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_EVENT_KINDS } from "@synapse/shared";
import { GithubPoller, mapGithubEvent } from "../../triggers/github";
import type { TriggerEvent } from "../../triggers/types";

const pr = { number: 7, title: "Fix login", html_url: "https://github.com/a/b/pull/7", head: { ref: "fix" }, merged: false };
const sender = { login: "octo" };
const CASES: [string, Record<string, unknown>, string][] = [
  ["pull_request", { action: "opened", pull_request: pr, sender }, "prOpened"],
  ["pull_request", { action: "synchronize", pull_request: pr, sender }, "prPushed"],
  ["pull_request", { action: "closed", pull_request: { ...pr, merged: true }, sender }, "prMerged"],
  ["pull_request", { action: "closed", pull_request: pr, sender }, "prClosed"],
  ["issue_comment", { action: "created", issue: { number: 7, title: "Fix login", pull_request: {} }, comment: { html_url: "u" }, sender }, "prCommented"],
  ["pull_request", { action: "review_requested", pull_request: pr, sender }, "reviewRequested"],
  ["pull_request_review", { action: "submitted", review: { state: "approved", html_url: "u" }, pull_request: pr, sender }, "reviewApproved"],
  ["pull_request_review", { action: "submitted", review: { state: "changes_requested" }, pull_request: pr, sender }, "reviewChangesRequested"],
  ["pull_request_review", { action: "submitted", review: { state: "commented" }, pull_request: pr, sender }, "reviewCommented"],
  ["pull_request_review_comment", { action: "created", comment: { html_url: "u" }, pull_request: pr, sender }, "reviewComment"],
  ["pull_request_review_thread", { action: "resolved", pull_request: pr, sender }, "threadResolved"],
  ["pull_request_review_thread", { action: "unresolved", pull_request: pr, sender }, "threadUnresolved"],
  ["issues", { action: "assigned", issue: { number: 3, title: "Bug" }, sender }, "issueAssigned"],
  ["check_suite", { action: "completed", check_suite: { head_branch: "main", conclusion: "success" }, sender }, "ciCompleted"],
];

afterEach(() => vi.useRealTimers());

describe("mapGithubEvent (RTN-10: 14 kinds)", () => {
  it.each(CASES)("%s → %s", (type, payload, kind) => {
    expect(mapGithubEvent(type, payload)?.kind).toBe(kind);
  });
  it("covers every kind in the shared list, REST type names, workflow_run and ignored events", () => {
    expect(new Set(CASES.map((c) => c[2]))).toEqual(new Set(GITHUB_EVENT_KINDS));
    expect(mapGithubEvent("PullRequestReviewEvent", { action: "created", review: { state: "approved" }, pull_request: pr, sender })?.kind).toBe("reviewApproved");
    expect(mapGithubEvent("workflow_run", { action: "completed", workflow_run: { head_branch: "dev", conclusion: "failure", html_url: "u" }, sender })).toMatchObject({ kind: "ciCompleted", branch: "dev" });
    expect(mapGithubEvent("issue_comment", { action: "created", issue: { number: 1, title: "x" }, sender })).toBeNull();
    expect(mapGithubEvent("PushEvent", { ref: "refs/heads/main" })).toBeNull();
  });
});

describe("GithubPoller (ETag, baseline, 60 s)", () => {
  it("records a baseline first, sends If-None-Match, fires only newer events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: RequestInit[] = [];
    const pages: Response[] = [
      new Response(JSON.stringify([{ id: "100", type: "PullRequestEvent", actor: { login: "octo" }, payload: { action: "opened", pull_request: pr }, created_at: "2026-09-19T10:00:00Z" }]), { status: 200, headers: { etag: '"e1"' } }),
      new Response(null, { status: 304 }),
      new Response(JSON.stringify([
        { id: "102", type: "IssuesEvent", actor: { login: "octo" }, payload: { action: "assigned", issue: { number: 3, title: "Bug" } }, created_at: "2026-09-19T10:02:00Z" },
        { id: "101", type: "PullRequestEvent", actor: { login: "octo" }, payload: { action: "closed", pull_request: { ...pr, merged: true } }, created_at: "2026-09-19T10:01:00Z" },
        { id: "100", type: "PullRequestEvent", actor: { login: "octo" }, payload: { action: "opened", pull_request: pr }, created_at: "2026-09-19T10:00:00Z" },
      ]), { status: 200, headers: { etag: '"e2"' } }),
    ];
    const fetchFn = (async (_u: string, init: RequestInit) => { calls.push(init); return pages.shift()!; }) as unknown as typeof fetch;
    const got: TriggerEvent[] = [];
    const p = new GithubPoller({ repo: "a/b", token: () => "ghp_x", fetch: fetchFn, onEvent: (e) => got.push(e), now: () => 0, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout) });
    expect(await p.poll()).toBe(0);
    expect(await p.poll()).toBe(0);
    expect((calls[1]!.headers as Record<string, string>)["if-none-match"]).toBe('"e1"');
    expect(await p.poll()).toBe(2);
    expect(got.map((e) => `${e.eventId}:${e.kind}`)).toEqual(["101:prMerged", "102:issueAssigned"]);
    expect(got[0]).toMatchObject({ source: "github", repo: "a/b", actor: "octo", occurredAt: Date.parse("2026-09-19T10:01:00Z") });
  });
  it("does nothing without a token", async () => {
    const p = new GithubPoller({ repo: "a/b", token: () => null, fetch: (() => { throw new Error("no"); }) as unknown as typeof fetch, onEvent: () => {}, now: () => 0, setTimer: () => 0, clearTimer: () => {} });
    expect(await p.poll()).toBe(0);
  });

  it("stop() during an in-flight poll prevents the pending .finally() from re-arming the timer (no orphaned polling)", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchFn = (() => new Promise<Response>((res) => { resolveFetch = res; })) as unknown as typeof fetch;
    const setTimerCalls: number[] = [];
    const p = new GithubPoller({
      repo: "a/b", token: () => "ghp_x", fetch: fetchFn, onEvent: () => {}, now: () => 0,
      setTimer: (_fn, ms) => { setTimerCalls.push(ms); return 1; }, clearTimer: () => {},
    });
    p.start(); // poll() starts and suspends awaiting the pending fetch; this.timer is still null here
    p.stop(); // clearTimer is a no-op (timer is null); with the fix this also marks the poller stopped
    resolveFetch(new Response(null, { status: 304 }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(setTimerCalls).toEqual([]); // the in-flight poll's .finally() must not re-arm a timer after stop()
  });
});
