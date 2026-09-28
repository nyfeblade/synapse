import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentRef, SkillView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../app";
import { tmpConfig } from "./helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => Promise<boolean> | boolean, ms = 6000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

async function start() {
  const cfg = tmpConfig();
  app = await createHostApp(cfg);
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result as T;
  };
  const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
  const say = async (id: string, text: string, extra: Record<string, unknown> = {}) => {
    const before = (await tail(id)).length;
    await api("sendPrompt", { id, text, clientNonce: crypto.randomUUID(), ...extra });
    await until(async () => (await tail(id)).length > before + 1 && app!.services.runner.isIdle(id));
  };
  return { cfg, api, tail, say };
}

describe("Phase 2 journey on FakeBrain (gateway level)", () => {
  it("memory, skills, attachments in and out, widgets, reactions, search, palette paging and compaction", async () => {
    const { cfg, api, tail, say } = await start();
    const { id } = await api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });

    await say(id, "remember: The user's landlord is Mark Ellis.");
    expect(fs.readFileSync(path.join(cfg.dataRoot, "agents", id, "memory", "profile.md"), "utf8")).toContain("The user's landlord is Mark Ellis.");

    const up = await api<{ attachment: AttachmentRef }>("uploadAttachment", { id, uploadId: "u1", name: "notes.md", mime: "text/markdown", size: 7, offset: 0, chunkBase64: Buffer.from("# Notes").toString("base64"), final: true });
    await say(id, `send back: .host-out/uploads/${id}/notes.md`, { attachmentIds: [up.attachment.attachmentId] });
    const entries = await tail(id);
    expect(entries.some((e) => e.kind === "user-attachment" && e.name === "notes.md")).toBe(true);
    expect(entries.some((e) => e.kind === "send-message" && e.message.type === "attachment" && e.message.name === "notes.md")).toBe(true);
    const read = await api<{ chunkBase64: string }>("readWorkspaceFile", { path: path.join(cfg.workspace, ".host-out", "uploads", id, "notes.md"), offset: 0, length: 100 });
    expect(Buffer.from(read.chunkBase64, "base64").toString()).toBe("# Notes");

    await say(id, "save skill: Weekly report");
    const { workflows } = await api<{ workflows: SkillView[] }>("getWorkflows", {});
    expect(workflows.map((w) => w.id)).toContain("weekly-report");
    expect((await tail(id)).some((e) => e.kind === "event" && e.event.type === "skill-saved")).toBe(true);

    await say(id, "ask: Which flight?|7 AM|6 PM");
    const w = (await tail(id)).filter((e) => e.kind === "send-message" && e.message.type === "widget").at(-1)!;
    expect((await api<{ status: string }>("respondToWidget", { id, entryId: w.id, value: "6 PM" })).status).toBe("answered");
    await until(async () => (await tail(id)).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content.includes("6 PM")));

    const lastBot = (await tail(id)).filter((e) => e.kind === "send-message" && e.message.type === "text").at(-1)!;
    expect((await api<{ reactions: unknown[] }>("reactToMessage", { id, entryId: lastBot.id, emoji: "👍" })).reactions).toHaveLength(1);

    const found = await api<{ results: { kind: string; entryId?: string }[] }>("search", { query: "landlord" });
    expect(found.results.some((r) => r.kind === "message")).toBe(true);
    const page = await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptPage", { id, aroundEntryId: "t1u", before: 5, after: 5 });
    expect(page.entries.some((e) => e.id === "t1u")).toBe(true);

    expect((await api<{ scheduled: boolean }>("compactAgentNow", { id })).scheduled).toBe(true);
    await until(async () => (await api<{ compactions: number }>("getAgentContext", { id })).compactions === 1);

    await api("deleteAgent", { id });
    expect(fs.existsSync(path.join(cfg.dataRoot, "user-memory", "agents", id))).toBe(false);
  });

  // Task 39: cards (CHAT-16) had no FUZZ demo command, so the fuzz pass could not reach them.
  it("the FUZZ demo script sends each card kind on 'card: <kind>'", async () => {
    const { api, tail, say } = await start();
    const { id } = await api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });
    for (const k of ["table", "link", "form", "email"]) await say(id, `card: ${k}`);
    const kinds = (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "card" ? [e.message.card.kind] : []));
    expect(kinds).toEqual(["table", "link", "form", "email-draft"]);
  });
});
