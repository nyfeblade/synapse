import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, SNIPPET_CLOSE, SNIPPET_OPEN, type TranscriptEntry } from "@synapse/shared";
import { SearchIndex, linksIn, searchTerms, startSearchSync, textDoc } from "../../search/search-index";
import { createSearchCommands } from "../../search/search-commands";
import { makeRunnerHarness } from "../runner/harness";

const T = 1_700_000_000_000;
const msg = (id: string, content: string, at = T): TranscriptEntry => ({ kind: "message", id, role: "user", content, createdAt: at });
const sent = (id: string, content: string): TranscriptEntry => ({ kind: "send-message", id, requestId: "r", createdAt: T, message: { type: "text", content } });

describe("search index (PAL-02)", () => {
  it("indexes messages, files, links and Bots with prefix terms and snippets", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const idx = new SearchIndex(path.join(h.cfg.hostPrivate, "search-index.db"));
    idx.upsertEntry("b1", msg("t1u", "Find flights to Denver for the offsite, see https://example.com/offsite"));
    idx.upsertEntry("b1", sent("t1s1", "Booked the Denver flight at 9:10."));
    idx.upsertEntry("b1", { kind: "send-message", id: "t2s1", requestId: "r", createdAt: T, message: { type: "attachment", url: "file:///workspace/denver-itinerary.pdf", name: "denver-itinerary.pdf", size: 1, mime: "application/pdf", pages: 1, caption: null } });
    idx.upsertBot({ ...(h.bots.summary(h.bots.create({ name: "Scout", description: "Researches Denver trips", origin: "user", kickstart: false }))) });
    const r = idx.search("denv");
    expect(r.map((x) => x.kind).sort()).toEqual(["bot", "file", "message", "message"]);
    const m = r.find((x) => x.kind === "message" && x.entryId === "t1s1") as Extract<(typeof r)[number], { kind: "message" }>;
    expect(m.snippet).toContain(`${SNIPPET_OPEN}Denver${SNIPPET_CLOSE}`);
    expect(idx.search("offsite example").some((x) => x.kind === "link")).toBe(true);
    expect(idx.search("café")).toEqual([]);
  });

  it("caps at 5 matches per Bot and 50 overall, and ≤8 terms", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const idx = new SearchIndex(path.join(h.cfg.hostPrivate, "search-index.db"));
    for (let b = 0; b < 12; b++) for (let i = 0; i < 9; i++) idx.upsertEntry(`bot${b}`, msg(`t${i + 1}u`, `quarterly invoice number ${i}`));
    const r = idx.search("quarterly");
    expect(r).toHaveLength(50);
    const perBot = new Map<string, number>();
    for (const x of r) perBot.set(x.botId, (perBot.get(x.botId) ?? 0) + 1);
    expect(Math.max(...perBot.values())).toBe(5);
    expect(searchTerms("a b c d e f g h i j k")).toHaveLength(8);
    expect(linksIn("see https://a.dev/x, and http://b.dev.")).toEqual(["https://a.dev/x", "http://b.dev"]);
  });

  it("stays current from SSE transcript events and pages around an entry", async () => {
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "The lease renews in August." } }] });
    const idx = new SearchIndex(path.join(h.cfg.hostPrivate, "search-index.db"));
    startSearchSync({ hub: h.hub, index: idx });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "when does the lease renew?", "n1");
    await h.untilIdle(id);
    expect(idx.search("lease").map((x) => (x as { entryId?: string }).entryId).sort()).toEqual(["t1s1", "t1u"]);
    const cmd = createSearchCommands({ index: idx, bots: h.bots });
    const page = await cmd.getAgentTranscriptPage!({ id, aroundEntryId: "t1u", before: 0, after: 1 });
    expect(page.entries.map((e) => e.id)).toEqual(["t1u", "t1s1"]);
    expect(page.hasOlder).toBe(true); // the bot-created event row is older
  });

  it("transcript page window uses LIMITS.transcriptPageDefault/Max, not inline magic numbers", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const idx = new SearchIndex(path.join(h.cfg.hostPrivate, "search-index.db"));
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const bot = h.bots.require(id);
    const pageSpy = vi.spyOn(bot.store, "page").mockReturnValue({ entries: [], hasOlder: false, hasNewer: false });
    const cmd = createSearchCommands({ index: idx, bots: h.bots });

    await cmd.getAgentTranscriptPage!({ id, aroundEntryId: "t1u" });
    expect(pageSpy).toHaveBeenLastCalledWith("t1u", LIMITS.transcriptPageDefault, LIMITS.transcriptPageDefault);

    await cmd.getAgentTranscriptPage!({ id, aroundEntryId: "t1u", before: 999_999, after: 999_999 });
    expect(pageSpy).toHaveBeenLastCalledWith("t1u", LIMITS.transcriptPageMax, LIMITS.transcriptPageMax);
  });

  it("textDoc() factors the shared message+link doc extraction used by both docsFor() branches", () => {
    const docs = textDoc("Find flights to Denver, see https://example.com/offsite", T);
    expect(docs).toEqual([
      { kind: "message", title: "", body: "Find flights to Denver, see https://example.com/offsite", createdAt: T },
      { kind: "link", title: "https://example.com/offsite", body: "https://example.com/offsite", createdAt: T },
    ]);
    expect(textDoc("no links here", T)).toEqual([{ kind: "message", title: "", body: "no links here", createdAt: T }]);
  });
});
