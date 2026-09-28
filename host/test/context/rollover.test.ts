import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, STR } from "@synapse/shared";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { patchCtx, readCtx } from "../../context/context-meter";
import { Rollover, rewriteSession, tailFromLastBoundary } from "../../context/rollover";
import { makeRunnerHarness } from "../runner/harness";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const SESSION = jsonl([
  { type: "user", uuid: "u1", parentUuid: null, sessionId: OLD, message: { role: "user", content: "old stuff" } },
  { type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: null, sessionId: OLD },
  { type: "user", uuid: "s1", parentUuid: "c1", sessionId: OLD, isCompactSummary: true, message: { role: "user", content: [{ type: "text", text: "SUMMARY: booking Denver; Dana owes the deck." }] } },
  { type: "assistant", uuid: "a1", parentUuid: "s1", sessionId: OLD, message: { role: "assistant", content: [{ type: "text", text: "next" }] } },
]);

describe("tail copy", () => {
  it("keeps the records from the last compact boundary and rewrites the session id", () => {
    const t = tailFromLastBoundary(SESSION)!;
    expect(t.records.map((r) => r.uuid)).toEqual(["c1", "s1", "a1"]);
    expect(t.summary).toBe("SUMMARY: booking Denver; Dana owes the deck.");
    expect(rewriteSession(t.records, NEW).toString().split("\n").filter(Boolean).every((l) => JSON.parse(l).sessionId === NEW)).toBe(true);
    expect(tailFromLastBoundary(jsonl([{ type: "user", uuid: "u1" }]))).toBeNull();
  });
});

describe("Rollover (ORIG-07 §07.5)", () => {
  async function setup(opts: { writeFails?: boolean; session?: string | null; size?: number } = {}) {
    const writes: { p: string; data: string }[] = [];
    const h = await makeRunnerHarness({ script: () => [] });
    const r = new Rollover({
      cfg: h.cfg, bots: h.bots, runner: h.runner, trays: h.trays, flags: () => DEFAULT_FLAGS, now: Date.now,
      readSession: () => { if (opts.session === null) throw new Error("ENOENT"); return Buffer.from(opts.session ?? SESSION); },
      writeSession: (p, data) => { if (opts.writeFails) throw new Error("EACCES"); writes.push({ p, data: data.toString() }); },
      sizeOf: () => opts.size ?? 70 * 1024 * 1024, newId: () => NEW,
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.bots.setSessionId(id, OLD);
    return { h, r, id, writes };
  }

  it("decides when to roll", async () => {
    const big = await setup();
    expect(big.r.reasonToRoll(big.id)).toBe("session file over 64 MB");
    const { h, r, id } = await setup({ size: 1 });
    expect(r.reasonToRoll(id)).toBeNull();
    patchCtx(h.bots, id, { compactions: 25 });
    expect(r.reasonToRoll(id)).toBe("25 compactions");
    patchCtx(h.bots, id, { compactions: 0 });
    h.bots.setBrainKv(id, "resumeLatencies", [9000, 9500, 1000, 8800, 12000]);
    expect(r.reasonToRoll(id)).toBe("slow resume");
  });

  it("tail-copies into a new session through the write helper", async () => {
    const { h, r, id, writes } = await setup();
    const e0 = h.bots.compactionEpoch(id);
    expect(r.rollNow(id, "user")).toBe(true);
    await h.untilIdle(id);
    expect(writes).toHaveLength(1);
    expect(path.basename(writes[0]!.p)).toBe(`${NEW}.jsonl`);
    expect(h.bots.sessionId(id)).toBe(NEW);
    expect(h.bots.brainKv<{ id: string }[]>(id, "previousSessionIds", []).map((x) => x.id)).toEqual([OLD]);
    expect(h.bots.compactionEpoch(id)).toBe(e0 + 1);
    expect(readCtx(h.bots, id).compactions).toBe(0);
    expect(h.brain(id)?.inputs ?? []).toHaveLength(0); // no model turn on the tail-copy path
  });

  it("falls back to a fresh session and a silent handoff turn when the helper fails", async () => {
    const { h, r, id } = await setup({ writeFails: true });
    r.rollNow(id, "user");
    await h.untilIdle(id);
    const last = h.brain(id).inputs.at(-1)!;
    expect(last.source).toBe("session-handoff");
    expect(last.silenceAllowed).toBe(true);
    const text = JSON.stringify(last.prompt);
    expect(text).toContain("[session handoff] Your working memory was moved to a fresh session. Here is where things stand: SUMMARY: booking Denver");
    expect(text).toContain("<context_restore>");
    expect(text).toContain("Continue from here. Do not greet the user or announce this.");
  });

  it("builds the summary from the host transcript when the old file is unreadable", async () => {
    const { h, r, id } = await setup({ session: null });
    h.runner.sendPrompt(id, "remember the Denver trip", "n1");
    await h.untilIdle(id);
    r.rollNow(id, "resume-failed");
    await h.untilIdle(id);
    expect(JSON.stringify(h.brain(id).inputs.at(-1)!.prompt)).toContain("remember the Denver trip");
  });

  // Bug 44, the same class as (a) and (b): the read failed, log.warn recorded it, and the handoff
  // then read exactly like an ordinary one — the Bot carried on as if it had the whole thread and
  // would have answered "what did we decide?" out of a recap it did not know was partial.
  it("tells the Bot the recap is partial when the old session could not be read", async () => {
    const { h, r, id } = await setup({ session: null });
    h.runner.sendPrompt(id, "remember the Denver trip", "n1");
    await h.untilIdle(id);
    r.rollNow(id, "resume-failed");
    await h.untilIdle(id);
    expect(JSON.stringify(h.brain(id).inputs.at(-1)!.prompt)).toContain(STR.rolloverTailLost);
  });

  it("does not say that when the old session read fine (must not fire)", async () => {
    const { h, r, id } = await setup({ writeFails: true }); // same handoff turn, nothing unreadable
    r.rollNow(id, "user");
    await h.untilIdle(id);
    expect(JSON.stringify(h.brain(id).inputs.at(-1)!.prompt)).not.toContain(STR.rolloverTailLost);
  });

  it("still deletes a rolled-over session file after 30 days once it has aged out of the capped previousSessionIds window", async () => {
    let clock = Date.now();
    const rollIds = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    let rollIdx = 0;
    const h = await makeRunnerHarness({ script: () => [] });
    const r = new Rollover({
      cfg: h.cfg, bots: h.bots, runner: h.runner, trays: h.trays, flags: () => DEFAULT_FLAGS, now: () => clock,
      readSession: () => Buffer.from(SESSION),
      writeSession: () => {},
      sizeOf: () => 1, newId: () => rollIds[rollIdx++]!,
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.bots.setSessionId(id, OLD);
    const oldestFile = h.bots.sessionFilePath(id)!; // the very first rolled-over file: OLD.jsonl

    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    // Roll over 4 times (> LIMITS.previousSessionsKept === 3) so the oldest file falls out of the display cap.
    for (let i = 0; i < 4; i++) {
      expect(r.rollNow(id, "user")).toBe(true);
      await h.untilIdle(id);
    }

    // The 3-slot display cap no longer tracks the oldest (first) rolled-over session id.
    expect(h.bots.brainKv<{ id: string }[]>(id, "previousSessionIds", []).map((x) => x.id)).toEqual([rollIds[2], rollIds[1], rollIds[0]]);

    clock += LIMITS.oldSessionTtlMs + 1; // well past the 30-day TTL
    r.sweepOldSessions();

    const deletedPaths = rmSpy.mock.calls.map((c) => c[0]);
    expect(deletedPaths).toContain(oldestFile);
    rmSpy.mockRestore();
  });

  // Merge seam: on the box, rolled session files are root-owned; the 30-day sweep must go through
  // the injected root delete helper (bothost's fs.rmSync gets EACCES there).
  it("sweeps expired session files through the injected delete helper", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    let clock = 1_000;
    const deleted: string[] = [];
    const r = new Rollover({
      cfg: h.cfg, bots: h.bots, runner: h.runner, trays: h.trays, flags: () => DEFAULT_FLAGS, now: () => clock,
      readSession: () => Buffer.from(SESSION), writeSession: () => {}, sizeOf: () => 1, newId: () => NEW,
      deleteSession: (f) => { deleted.push(f); },
    });
    const rmSpy = vi.spyOn(fs, "rmSync");
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.bots.setBrainKv(id, "rolledSessionFiles", [{ id: OLD, file: "/root-owned/old.jsonl", rolledAt: 0 }]);
    clock += LIMITS.oldSessionTtlMs + 1;
    r.sweepOldSessions();
    expect(deleted).toEqual(["/root-owned/old.jsonl"]);
    expect(rmSpy.mock.calls.map((c) => c[0])).not.toContain("/root-owned/old.jsonl");
    expect(h.bots.brainKv(id, "rolledSessionFiles", [])).toEqual([]);
    rmSpy.mockRestore();
  });
});
