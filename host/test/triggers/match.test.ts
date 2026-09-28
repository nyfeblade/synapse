import { describe, expect, it } from "vitest";
import type { Trigger } from "@synapse/shared";
import { describeTrigger, isAlwaysIgnored, matchesTrigger, triggerKindOf, triggerSources, validateTrigger } from "../../triggers/match";
import type { TriggerEvent } from "../../triggers/types";

const ev = (p: Partial<TriggerEvent>): TriggerEvent => ({ source: "slack", eventId: "e1", occurredAt: 2000, text: "", raw: {}, ...p });
const ctx = { savedAt: 1000, workspace: "/workspace" };
const M = (t: Trigger, e: Partial<TriggerEvent>) => matchesTrigger(t, ev(e), ctx);

describe("matchesTrigger (RTN-10)", () => {
  it("ignores events from before the routine was saved or activated", () => {
    expect(M({ webhook: {} }, { source: "webhook", occurredAt: 999 })).toBe(false);
    expect(M({ webhook: {} }, { source: "webhook", occurredAt: 1000 })).toBe(true);
  });

  it("slack: channel, mention, top-level message, keyword, reaction", () => {
    expect(M({ slack: { channel: "#ops", match: "mention" } }, { kind: "mention", channel: "#ops" })).toBe(true);
    expect(M({ slack: { channel: "#ops", match: "mention" } }, { kind: "mention", channel: "#eng" })).toBe(false);
    expect(M({ slack: { channel: "*", match: "mention" } }, { kind: "mention", channel: "#eng" })).toBe(true);
    expect(M({ slack: { channel: "@dm", match: "message" } }, { kind: "message", channel: "@dm", raw: { ts: "1.1" } })).toBe(true);
    expect(M({ slack: { channel: "#ops", match: "message" } }, { kind: "message", channel: "#ops", raw: { ts: "1.2", thread_ts: "1.1" } })).toBe(false);
    expect(M({ slack: { channel: "#ops", match: "message" } }, { kind: "message", channel: "#ops", raw: { ts: "1.1", thread_ts: "1.1" } })).toBe(true);
    expect(M({ slack: { channel: "#ops", match: { keyword: "Deploy" } } }, { kind: "message", channel: "#ops", text: "can we deploy now", raw: { ts: "2", thread_ts: "1" } })).toBe(true);
    expect(M({ slack: { channel: "#ops", match: { keyword: "deploy" } } }, { kind: "message", channel: "#ops", text: "ship it" })).toBe(false);
    const react: Trigger = { slack: { channel: "*", match: { reaction: { emoji: ["eyes"], bySelf: true } } } };
    expect(M(react, { kind: "reaction", channel: "#ops", raw: { reaction: "eyes" }, selfAuthored: true })).toBe(true);
    expect(M(react, { kind: "reaction", channel: "#ops", raw: { reaction: "eyes" }, selfAuthored: false })).toBe(false);
    expect(M(react, { kind: "reaction", channel: "#ops", raw: { reaction: "tada" }, selfAuthored: true })).toBe(false);
    expect(M({ slack: { channel: "*", match: { reaction: {} } } }, { kind: "reaction", channel: "#x", raw: { reaction: "tada" } })).toBe(true);
  });

  it("github: repo, kind, allowlist, ciBranch", () => {
    const t: Trigger = { github: { repo: "Acme/App", events: ["prOpened", "ciCompleted"], userAllowlist: ["octo"], ciBranch: "main" } };
    const g = (p: Partial<TriggerEvent>) => M(t, { source: "github", repo: "acme/app", actor: "Octo", ...p });
    expect(g({ kind: "prOpened" })).toBe(true);
    expect(g({ kind: "prMerged" })).toBe(false);
    expect(g({ kind: "prOpened", actor: "mallory" })).toBe(false);
    expect(g({ kind: "prOpened", repo: "acme/other" })).toBe(false);
    expect(g({ kind: "ciCompleted", branch: "main" })).toBe(true);
    expect(g({ kind: "ciCompleted", branch: "dev" })).toBe(false);
  });

  it("linear, sentry and pagerduty filters", () => {
    expect(M({ linear: { event: "issueCreated", teamIds: ["T1"] } }, { source: "linear", kind: "issueCreated", raw: { teamId: "T1" } })).toBe(true);
    expect(M({ linear: { event: "issueCreated", teamIds: ["T1"] } }, { source: "linear", kind: "issueCreated", raw: { teamId: "T2" } })).toBe(false);
    expect(M({ sentry: { event: "issue.created", projectIds: ["42"] } }, { source: "sentry", kind: "issue.created", raw: { projectId: "42" } })).toBe(true);
    expect(M({ pagerduty: { event: "incident.triggered", serviceIds: ["S1"] } }, { source: "pagerduty", kind: "incident.triggered", raw: { serviceId: "S9" } })).toBe(false);
  });

  it("file: globs, folders, ignore and always-ignored paths", () => {
    const t: Trigger = { file: { paths: ["inbox", "/workspace/drop/*.pdf"], events: ["created"], ignore: ["inbox/private/**"] } };
    const f = (path: string, kind = "created") => M(t, { source: "file", kind, path });
    expect(f("/workspace/inbox/a.txt")).toBe(true);
    expect(f("/workspace/inbox/sub/b.txt")).toBe(true);
    expect(f("/workspace/drop/r.pdf")).toBe(true);
    expect(f("/workspace/drop/r.png")).toBe(false);
    expect(f("/workspace/inbox/a.txt", "deleted")).toBe(false);
    expect(f("/workspace/inbox/private/x.txt")).toBe(false);
    expect(f("/workspace/inbox/.git/HEAD")).toBe(false);
    expect(f("/workspace/inbox/draft.swp")).toBe(false);
    expect(isAlwaysIgnored("/workspace/teach-sessions/t1/demo.mp4", "/workspace")).toBe(true);
  });

  it("email: account, folder and the query the adapter matched", () => {
    const t: Trigger = { email: { account: "work", query: "from:boss" } };
    expect(M(t, { source: "email", account: "work", channel: "INBOX", raw: { query: "from:boss" } })).toBe(true);
    expect(M(t, { source: "email", account: "work", channel: "INBOX", raw: { query: "from:old" } })).toBe(false);
    expect(M(t, { source: "email", account: "home", channel: "INBOX", raw: { query: "from:boss" } })).toBe(false);
  });

  it("group listeners: 2–8, any listener matches", () => {
    const g: Trigger = { group: { listeners: [{ webhook: {} }, { github: { repo: "a/b", events: ["prOpened"] } }] } };
    expect(M(g, { source: "webhook" })).toBe(true);
    expect(M(g, { source: "github", repo: "a/b", kind: "prOpened" })).toBe(true);
    expect(M({ group: { listeners: [{ webhook: {} }] } }, { source: "webhook" })).toBe(false);
    expect(triggerSources(g).sort()).toEqual(["github", "webhook"]);
    expect(validateTrigger({ group: { listeners: [{ webhook: {} }] } })).toBe("A trigger group needs 2 to 8 listeners.");
  });

  it("github description: singular/plural verb agreement", () => {
    expect(describeTrigger({ github: { repo: "a/b", events: ["prOpened"] } })).toBe("When a GitHub event happens in a/b");
    expect(describeTrigger({ github: { repo: "a/b", events: ["prOpened", "ciCompleted"] } })).toBe("When GitHub events happen in a/b");
  });

  it("cron never matches events; kinds and descriptions", () => {
    expect(M({ cron: { schedule: "0 8 * * *" } }, { source: "webhook" })).toBe(false);
    expect(triggerKindOf({ name: "a", prompt: "p", schedule: "0 8 * * *", enabled: true, createdAt: 0 })).toBe("schedule");
    expect(triggerKindOf({ name: "a", prompt: "p", trigger: { file: { paths: ["inbox"], events: ["created"] } }, enabled: true, createdAt: 0 })).toBe("file");
    expect(describeTrigger({ file: { paths: ["/workspace/inbox"], events: ["created"] } })).toBe("When a file is added to /workspace/inbox");
    expect(describeTrigger({ webhook: {} })).toBe("When a webhook is received");
    expect(validateTrigger({ microsoftTeams: {} })).toBe("Microsoft Teams triggers aren't available yet.");
    expect(validateTrigger({ file: { paths: ["/etc"], events: ["created"] } })).toBe("File triggers can only watch folders inside /workspace.");
  });
});
