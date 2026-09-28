import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryArchive, archiveTerms, snippet, type ArchiveRow } from "../../history/archive";
import { createHistoryToolExtension, formatHits } from "../../history/history-tool";

const day = (d: string, h = 12) => Date.parse(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
const row = (src: string, at: number, body: string, speaker = "user"): ArchiveRow => ({ src, stream: "chat", at, speaker, ctx: `Nova · ${new Date(at).toISOString().slice(0, 10)} · ${speaker}`, body });

let a: HistoryArchive | undefined;
afterEach(() => { a?.close(); a = undefined; });
function setup() {
  const db = new HistoryArchive(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hist-tool-")), "h.db"), { redact: (_b, t) => t, secrets: () => [] });
  a = db;
  db.put("botA", [
    row("e:1", day("2022-01-05"), "For the record, the Halvor budget is $40k."),
    row("e:2", day("2022-01-05", 13), "Noted, $40k it is.", "you"),
    row("e:3", day("2024-06-01"), "Let's lock it in: the Halvor budget is $55k."),
    ...Array.from({ length: 30 }, (_, i) => row(`e:f${i}`, day("2023-03-01") + i * 60_000, `Halvor filler line ${i} about the budget meeting and nothing else of note at all.`)),
  ]);
  db.put("botB", [row("e:1", day("2022-01-05"), "Bot B private: the Halvor budget is $99k.")]);
  const toolFor = (id: string) => createHistoryToolExtension({ archive: db }).extraTools!(id, () => null)[0]!;
  return { tool: toolFor("botA"), toolFor };
}

describe("SearchHistory tool", () => {
  it("is one read-only tool whose schema carries no Bot id, with a short description", () => {
    const { tool } = setup();
    expect(tool.name).toBe("SearchHistory");
    expect(tool.readOnly).toBe(true);
    expect(Object.keys(tool.schema).sort()).toEqual(["around", "from", "limit", "query", "to"]);
    expect(tool.description.length, "the description is paid on every model call").toBeLessThanOrEqual(240);
  });

  it("answers with dated, speaker-tagged original wording, oldest first, for the calling Bot only", async () => {
    const { tool } = setup();
    const r = await tool.handler({ query: "Halvor budget", limit: 3, bot_id: "botB", agent_id: "botB" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("2022-01-05 · user: For the record, the Halvor budget is $40k.");
    expect(r.text).toContain("2024-06-01 · user: Let's lock it in: the Halvor budget is $55k.");
    expect(r.text.indexOf("$40k")).toBeLessThan(r.text.indexOf("$55k"));
    expect(r.text).not.toContain("$99k");
    expect(r.text).toMatch(/\[#\d+\]/);
  });

  it("stays tight by default: at most 8 hits and about 1.5k tokens", async () => {
    const { tool } = setup();
    const r = await tool.handler({ query: "halvor budget filler" });
    expect((r.text.match(/\[#\d+\]/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(r.text.length).toBeLessThanOrEqual(6400);
  });

  it("from/to limit by date, and around shows the neighbours of a hit", async () => {
    const { tool } = setup();
    const r = await tool.handler({ query: "halvor budget", from: "2024-01-01" });
    expect(r.text).toContain("$55k");
    expect(r.text).not.toContain("$40k");
    const ref = /\[#(\d+)\][^\n]*\$40k\./.exec((await tool.handler({ query: "halvor 40k", to: "2022-12-31" })).text)![1];
    const ctx = await tool.handler({ around: `#${ref}` });
    expect(ctx.text).toContain("Noted, $40k it is.");
    expect(ctx.text).toContain("you: Noted");
  });

  it("a ref from another Bot opens nothing", async () => {
    const { toolFor } = setup();
    const bRef = /\[#(\d+)\]/.exec((await toolFor("botB").handler({ query: "private" })).text)![1];
    const r = await toolFor("botA").handler({ around: `#${bRef}` });
    expect(r.text).not.toContain("$99k");
  });

  it("says so plainly when nothing matches, and errors on a call with nothing to do", async () => {
    const { tool } = setup();
    expect((await tool.handler({ query: "zanzibar" })).text).toMatch(/No matches/);
    expect((await tool.handler({})).isError).toBe(true);
    expect((await tool.handler({ query: "x", from: "last tuesday" })).isError).toBe(true);
  });

  it("a long chunk's snippet lands on the clause asked about, not on the title the label already shows, and never glues a value to the ellipsis", () => {
    const body = `Notosor partnership contract, page 312. Notices go to Rafael Ortiz at the registered address. ${"Minutes: nothing to note here. ".repeat(20)}Clause 9: the Notosor termination notice period is 30 days. ${"The client keeps records. ".repeat(20)}`;
    const s = snippet(body, archiveTerms("According to the Notosor partnership contract, what is the Notosor termination notice period?"), 300, 'Nova · 2026-09-21 · document "Notosor partnership contract" · page 312');
    expect(s.truncated).toBe(true);
    expect(s.text).toContain("the Notosor termination notice period is 30 days.");
    expect(s.text.length).toBeLessThanOrEqual(304);
    expect(snippet("a ".repeat(200) + "the cap is $1,000,000. More text follows here.", ["cap"], 60).text).not.toMatch(/\d\.…/);
  });

  it("formatHits drops the Bot name the model already knows", () => {
    expect(formatHits([{ ref: 7, src: "e:1", at: 0, stream: "chat", speaker: "user", ctx: "Nova · 2022-01-05 Wed 12:00 · user", text: "hi", truncated: false }])).toBe("[#7] 2022-01-05 Wed 12:00 · user: hi");
  });
});
