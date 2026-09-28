import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_TOOL_NAMES, STRG } from "@synapse/shared";
import type { BotToolDef } from "../../brain/types";
import { GoogleApi } from "../../google/api";
import { fakeConsent, startFakeGoogle, type FakeGoogle } from "../../google/fake-google";
import { GoogleAuth } from "../../google/oauth";
import { GoogleStore } from "../../google/store";
import { createGoogleTools, fetchDraftPreview, hashDraftPreview } from "../../google/tools";

let g: FakeGoogle;
let root: string;
let ws: string;
let hp: string;
let auth: GoogleAuth;
let api: GoogleApi;
let tools: BotToolDef[];
let t: number;
let fetchImpl: typeof fetch;

const raw = (b64: string) => Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const run = async (name: string, args: Record<string, unknown> = {}) => tools.find((x) => x.name === name)!.handler(args);

beforeEach(async () => {
  g = await startFakeGoogle();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gtools-"));
  ws = path.join(root, "workspace");
  hp = path.join(root, ".host");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(hp, { recursive: true });
  t = 1_000_000;
  fetchImpl = fetch;
  auth = new GoogleAuth({ store: new GoogleStore(path.join(hp, "google", "account.json"), new Uint8Array(randomBytes(32))), endpoints: () => g.endpoints, now: () => t, fetch: (...a) => fetchImpl(...a) });
  auth.setClient("1-x.apps.googleusercontent.com", "GOCSPX-secret-value");
  const c = fakeConsent(g, auth.start());
  await auth.complete(c);
  api = new GoogleApi({ auth, endpoints: () => g.endpoints, fetch: (...a) => fetchImpl(...a) });
  tools = createGoogleTools({ api, auth, workspace: ws, hostPrivate: hp });
});
afterEach(() => g.close());

describe("google tools", () => {
  it("defines exactly the eleven tools, reads marked read-only", () => {
    expect(tools.map((x) => x.name)).toEqual([...GOOGLE_TOOL_NAMES]);
    expect(tools.filter((x) => x.readOnly).map((x) => x.name)).toEqual(["gmail_search", "gmail_read", "calendar_list", "drive_search", "drive_read"]);
  });

  it("gmail_search lists id, sender, subject and snippet, capped and paginated", async () => {
    const r = await run("gmail_search", { query: "", max: 2 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("m1");
    expect(r.text).toContain("Q3 deck");
    expect(r.text).toContain("dana@example.org");
    expect(r.text).not.toContain("m3");
    expect(r.text).toMatch(/page_token: "2"/);
    const next = await run("gmail_search", { query: "", max: 2, page_token: "2" });
    expect(next.text).toContain("m3");
    const big = await run("gmail_search", { query: "", max: 5000 });
    expect(g.state.requests.some((q) => q.startsWith("GET /gmail/v1/users/me/messages"))).toBe(true);
    expect(big.isError).toBeFalsy();
  });

  it("gmail_read returns headers and the plain-text body", async () => {
    const r = await run("gmail_read", { id: "m1" });
    expect(r.text).toContain("Subject: Q3 deck");
    expect(r.text).toContain("The Q3 deck is ready for review");
    expect((await run("gmail_read", { id: "nope" })).isError).toBe(true);
  });

  it("gmail_draft builds an RFC 2822 message, threading a reply", async () => {
    const r = await run("gmail_draft", { to: "sam@example.net", subject: "Re: Lunch Thursday?", body: "Yes, noon works.", reply_to_id: "m3" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/draft_id: d\d+/);
    const d = g.state.drafts[0]!;
    expect(d.threadId).toBe("t3");
    const m = raw(d.raw);
    expect(m).toContain("To: sam@example.net");
    expect(m).toContain("Subject: Re: Lunch Thursday?");
    expect(m).toContain("In-Reply-To: <m3@example.net>");
    expect(m).toContain("Yes, noon works.");
  });

  it("gmail_draft rejects header injection in recipients and subject", async () => {
    const r = await run("gmail_draft", { to: "a@example.com\r\nBcc: x@evil.example", subject: "hi", body: "b" });
    expect(r.isError).toBe(true);
    expect(g.state.drafts).toHaveLength(0);
  });

  it("gmail_send sends a draft by id or a new message", async () => {
    await run("gmail_draft", { to: "sam@example.net", subject: "s", body: "b" });
    const id = g.state.drafts[0]!.id;
    const h = hashDraftPreview(await fetchDraftPreview(api, id));
    expect((await run("gmail_send", { draft_id: id, draft_hash: h })).text).toMatch(/Sent/);
    expect(g.state.sent).toHaveLength(1);
    expect((await run("gmail_send", { to: "dana@example.org", subject: "Deck", body: "Looks good." })).text).toMatch(/Sent/);
    expect(raw(g.state.sent[1]!.raw)).toContain("To: dana@example.org");
    expect((await run("gmail_send", { subject: "x" })).isError).toBe(true);
  });

  it("gmail_send refuses a draft_hash that no longer matches the draft (changed since it was approved)", async () => {
    await run("gmail_draft", { to: "sam@example.net", subject: "s", body: "original body" });
    const draft = g.state.drafts[0]!;
    const approvedHash = hashDraftPreview(await fetchDraftPreview(api, draft.id));

    // The draft changes after the card was shown (e.g. edited directly in Gmail).
    draft.raw = b64url("To: sam@example.net\r\nSubject: s (edited)\r\n\r\nchanged body");

    const r = await run("gmail_send", { draft_id: draft.id, draft_hash: approvedHash });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(STRG.draftChanged);
    expect(g.state.sent).toHaveLength(0);
    expect(g.state.drafts).toHaveLength(1);

    // The current draft_hash (recomputed after the edit) is still accepted.
    const freshHash = hashDraftPreview(await fetchDraftPreview(api, draft.id));
    expect((await run("gmail_send", { draft_id: draft.id, draft_hash: freshHash })).text).toMatch(/Sent/);
    expect(g.state.sent).toHaveLength(1);
  });

  it("item 1: gmail_send(draft_id) refuses without a draft_hash (the gate always sets one)", async () => {
    await run("gmail_draft", { to: "sam@example.net", subject: "s", body: "b" });
    const r = await run("gmail_send", { draft_id: g.state.drafts[0]!.id });
    expect(r.isError).toBe(true);
    expect(g.state.sent).toHaveLength(0);
  });

  it("item 1: an edit past the 200-char preview still invalidates the approved hash", async () => {
    const long = "x".repeat(300);
    await run("gmail_draft", { to: "sam@example.net", subject: "s", body: long });
    const draft = g.state.drafts[0]!;
    const approvedHash = hashDraftPreview(await fetchDraftPreview(api, draft.id));
    draft.raw = b64url(`To: sam@example.net\r\nSubject: s\r\n\r\n${long}\r\nP.S. wire the money to evil`);
    const r = await run("gmail_send", { draft_id: draft.id, draft_hash: approvedHash });
    expect(r.isError).toBe(true);
    expect(g.state.sent).toHaveLength(0);
  });

  it("final secfix 10: every Google id must match ^[A-Za-z0-9_@.-]+$ and is never . or ..", async () => {
    const bad = ["..", ".", "../../users/me/settings", "m1/../x", "a b", "x?y=1", "%2e%2e", "id#frag", "a\\b"];
    const before = g.state.requests.length;
    for (const v of bad) {
      for (const [tool, args] of [
        ["gmail_read", { id: v }], ["gmail_send", { draft_id: v, draft_hash: "x" }], ["gmail_draft", { to: "sam@example.net", subject: "s", body: "b", reply_to_id: v }],
        ["calendar_delete", { id: v }], ["calendar_update", { id: v, summary: "x" }], ["calendar_list", { calendar: v }],
        ["drive_read", { file_id: v }], ["drive_upload", { path: "a.txt", folder: v }],
      ] as const) {
        const r = await run(tool, args as Record<string, unknown>);
        expect(r.isError, `${tool} ${v}`).toBe(true);
      }
    }
    expect(g.state.requests.length).toBe(before);
    await expect(fetchDraftPreview(api, "..")).rejects.toThrow(/id/i);
    expect((await run("gmail_read", { id: "m1" })).isError).toBeFalsy();
    expect((await run("calendar_list", { calendar: "team@group.calendar.google.com", from: "2026-09-20T00:00:00Z" })).isError).toBeFalsy();
  });

  it("calendar list, create, update and delete", async () => {
    const list = await run("calendar_list", { from: "2026-09-20T00:00:00Z", to: "2026-09-30T00:00:00Z" });
    expect(list.text).toContain("Team sync");
    expect(list.text).toContain("e1");
    const created = await run("calendar_create", { summary: "Dentist", start: "2026-09-24T15:00:00-07:00", end: "2026-09-24T16:00:00-07:00", attendees: ["a@example.com"] });
    const id = /id: (e\d+)/.exec(created.text)![1]!;
    expect(g.state.events.find((e) => e.id === id)).toMatchObject({ summary: "Dentist", start: { dateTime: "2026-09-24T15:00:00-07:00" }, attendees: [{ email: "a@example.com" }] });
    const allDay = await run("calendar_create", { summary: "Trip", start: "2026-10-14", end: "2026-10-16" });
    expect(g.state.events.find((e) => e.id === /id: (e\d+)/.exec(allDay.text)![1])).toMatchObject({ start: { date: "2026-10-14" } });
    await run("calendar_update", { id, summary: "Dentist (moved)" });
    expect(g.state.events.find((e) => e.id === id)!.summary).toBe("Dentist (moved)");
    await run("calendar_delete", { id });
    expect(g.state.events.find((e) => e.id === id)).toBeUndefined();
    expect((await run("calendar_create", { summary: "x", start: "tomorrow", end: "later" })).isError).toBe(true);
  });

  it("drive search and read (Docs as text, Sheets as CSV, text files as-is), with a size cap", async () => {
    const s = await run("drive_search", { query: "trip" });
    expect(s.text).toContain("f1");
    expect(s.text).toContain("Trip plan");
    const doc = await run("drive_read", { file_id: "f1" });
    expect(doc.text).toContain("1. Book hotel");
    expect(g.state.requests).toContain("GET /drive/v3/files/f1/export");
    const sheet = await run("drive_read", { file_id: "f2" });
    expect(sheet.text).toContain("hotel,420");
    expect((await run("drive_read", { file_id: "f3" })).text).toContain("plain notes");
    g.state.files.push({ id: "big", name: "big.txt", mimeType: "text/plain", content: "x".repeat(200_000) });
    const big = await run("drive_read", { file_id: "big", max_chars: 1000 });
    expect(big.text.length).toBeLessThan(1500);
    expect(big.text).toMatch(/truncated/i);
  });

  it("drive_upload uploads a workspace file and refuses anything outside /workspace", async () => {
    fs.writeFileSync(path.join(ws, "report.md"), "# Report\nAll good.");
    const r = await run("drive_upload", { path: path.join(ws, "report.md"), name: "Report.md", folder: "folder1" });
    expect(r.isError).toBeFalsy();
    expect(g.state.files.at(-1)).toMatchObject({ name: "Report.md", content: "# Report\nAll good.", parents: ["folder1"] });
    fs.writeFileSync(path.join(hp, "vault.key"), "k");
    expect((await run("drive_upload", { path: path.join(hp, "vault.key") })).isError).toBe(true);
    expect((await run("drive_upload", { path: "/etc/passwd" })).isError).toBe(true);
    fs.symlinkSync(path.join(hp, "vault.key"), path.join(ws, "sneaky"));
    expect((await run("drive_upload", { path: path.join(ws, "sneaky") })).isError).toBe(true);
    expect((await run("drive_upload", { path: "report.md" })).isError).toBeFalsy(); // relative to /workspace
  });

  it("a 401 forces one token refresh and retries", async () => {
    g.state.accessTokens.clear();
    const r = await run("gmail_read", { id: "m1" });
    expect(r.isError).toBeFalsy();
    expect(g.state.requests.filter((q) => q === "POST /token")).toHaveLength(2);
  });

  it("an expired sign-in returns a clear reconnect error", async () => {
    g.state.refreshInvalid = true;
    t += 3600_000;
    const r = await run("gmail_search", { query: "deck" });
    expect(r).toEqual({ text: STRG.toolNeedsReconnect, isError: true });
    expect(auth.status().state).toBe("needs-reconnect");
  });

  it("never lets a token or the client secret reach tool output", async () => {
    const token = await auth.accessToken();
    fetchImpl = async (u, init) => {
      if (String(u).includes("/gmail/")) return new Response(JSON.stringify({ error: { code: 400, message: `bad token ${token} GOCSPX-secret-value` } }), { status: 400 });
      return fetch(u, init);
    };
    const r = await run("gmail_read", { id: "m1" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(token);
    expect(r.text).not.toContain("GOCSPX-secret-value");
    expect(r.text).toContain("[redacted]");
  });
});
