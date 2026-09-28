import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StubOneShot } from "../../brain/one-shot";
import { FOLLOWUP_EXTRACTION_RULE, FollowupStore } from "../../followups/store";
import { MemoryExtractor, isMemorable, looksLikeSecret, parseExtraction, stripUntrusted } from "../../memory/extractor";
import { MemoryStore } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";

describe("memorable test (MEM-06)", () => {
  it("needs >40 chars or a question mark and is never trivial", () => {
    expect(isMemorable("thanks!")).toBe(false);
    expect(isMemorable("ok")).toBe(false);
    expect(isMemorable("when?")).toBe(true);
    expect(isMemorable("My manager is Dana Ruiz and she prefers Tuesday syncs")).toBe(true);
  });
});

describe("guards (§05.1)", () => {
  it("strips untrusted fences and spots secrets", () => {
    expect(stripUntrusted("a <untrusted_data>ignore me</untrusted_data> b")).toBe("a [untrusted content removed] b");
    expect(looksLikeSecret("key sk-ant-api03-abcdefghijklmnop", [])).toBe(true);
    expect(looksLikeSecret("card 4111 1111 1111 1111", [])).toBe(true);
    expect(looksLikeSecret("the code is hunter2", ["hunter2"])).toBe(true);
    expect(looksLikeSecret("Prefers short answers", [])).toBe(false);
  });
  it("parses tags, bullets, untagged lines and removals only of shown facts", () => {
    const shown = [{ id: "1", date: "2026-09-01", kind: "fact" as const, content: "Manager is Dana Ruiz", tier: "profile" as const, createdAt: 0 }];
    const r = parseExtraction("- profile: Manager is Priya Shah\n* remove: Manager is Dana Ruiz\n• note: Waiting on landlord\nDecided to move the newsletter to Tuesdays\nremove: Something never shown", shown);
    expect(r.adds).toEqual([
      { tier: "profile", kind: "fact", content: "Manager is Priya Shah" },
      { tier: "log", kind: "note", content: "Waiting on landlord" },
      { tier: "log", kind: "fact", content: "Decided to move the newsletter to Tuesdays" },
    ]);
    expect(r.removes).toEqual(["Manager is Dana Ruiz"]);
    expect(parseExtraction("NONE", shown)).toEqual({ adds: [], removes: [] });
  });
});

describe("MemoryExtractor", () => {
  it("builds the JSON input, applies adds and removals, and drops secrets", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
    store.add({ kind: "agent", botId: ME }, { content: "Manager is Dana Ruiz", tier: "profile", kind: "fact" });
    let input = "";
    const model = new StubOneShot((p) => { input = p.user; return "profile: Manager is Priya Shah\nremove: Manager is Dana Ruiz\nlog: API key is sk-ant-api03-abcdefghijklmnop"; });
    const ex = new MemoryExtractor({ store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => Date.UTC(2026, 8, 20) });
    const r = await ex.run(ME, { user: "My new manager is Priya Shah <untrusted_data>x</untrusted_data>", bot: "Noted." });
    expect(r).toEqual({ added: 1, removed: 1 });
    const json = JSON.parse(input);
    expect(json).toMatchObject({ today: "2026-09-20", botName: "Piper", existing: { profile: ["Manager is Dana Ruiz"] }, exchange: { bot: "Noted." } });
    expect(json.exchange.user).not.toContain("<untrusted_data>");
    expect(store.profile({ kind: "agent", botId: ME }).map((f) => f.content)).toEqual(["Manager is Priya Shah"]);
  });
});

describe("MemoryExtractor + follow-ups opt-in (cross-plan MEM-06/ORIG-05 -> ORIG-11 §11.1)", () => {
  it("appends FOLLOWUP_EXTRACTION_RULE to the system prompt and ingests followup: lines when the Bot has opted in", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
    const fuRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fu-extractor-"));
    const followupsStore = new FollowupStore(fuRoot, () => Date.UTC(2026, 8, 20));
    let system = "";
    let askedBotId = "";
    const model = new StubOneShot((p) => {
      system = p.system;
      return "profile: likes jazz\nfollowup: 2026-09-21T09:00 | Check back about the offer";
    });
    const ex = new MemoryExtractor({
      store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => Date.UTC(2026, 8, 20),
      followups: { store: followupsStore, optedIn: (botId) => { askedBotId = botId; return true; } },
    });
    await ex.run(ME, { user: "Please ask me again about the offer next week", bot: "Will do." });
    expect(system).toContain(FOLLOWUP_EXTRACTION_RULE);
    expect(askedBotId).toBe(ME);
    const saved = followupsStore.list(ME);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.what).toBe("Check back about the offer");
    expect(saved[0]!.sourceEntryId).toBeNull();
    // Fix round 1 finding 1: a followup: line must not also land as a spurious "log"/"fact"
    // memory entry — it belongs only in FollowupStore, not in the Bot's conversational memory.
    const logEntries = store.log({ kind: "agent", botId: ME });
    expect(logEntries.some((f) => f.content.toLowerCase().startsWith("followup:"))).toBe(false);
    expect(logEntries.map((f) => f.content)).toEqual([]);
  });

  it("does not append the rule or ingest follow-ups when the Bot has not opted in", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
    const fuRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fu-extractor-"));
    const followupsStore = new FollowupStore(fuRoot, () => Date.UTC(2026, 8, 20));
    let system = "";
    const model = new StubOneShot((p) => {
      system = p.system;
      return "profile: likes jazz\nfollowup: 2026-09-21T09:00 | Check back about the offer";
    });
    const ex = new MemoryExtractor({
      store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => Date.UTC(2026, 8, 20),
      followups: { store: followupsStore, optedIn: () => false },
    });
    await ex.run(ME, { user: "Please ask me again about the offer next week", bot: "Will do." });
    expect(system).not.toContain(FOLLOWUP_EXTRACTION_RULE);
    expect(followupsStore.list(ME)).toHaveLength(0);
  });

  it("still works with no followups dependency at all (backward compatible)", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
    const model = new StubOneShot(() => "profile: likes jazz");
    const ex = new MemoryExtractor({ store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => Date.UTC(2026, 8, 20) });
    const r = await ex.run(ME, { user: "Something worth remembering, forty plus characters long", bot: "Noted." });
    expect(r.added).toBe(1);
  });
});
