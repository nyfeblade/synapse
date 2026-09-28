import path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryArchive } from "../../history/archive";
import { createHistoryToolExtension } from "../../history/history-tool";
import { MemoryStore } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const OTHER = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";

/**
 * Bug #61: the Bot folder (its own memory files included) is host-private, so the facts the memory section didn't
 * show are found through SearchHistory, scoped by the host's Bot id, never by grepping the files.
 */
describe("SearchHistory also searches what the Bot remembers", () => {
  function setup() {
    const cfg = tmpConfig();
    initLayout(cfg);
    const memory = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
    const archive = new HistoryArchive(path.join(cfg.hostPrivate, "history.db"), { redact: (t) => t, secrets: () => [] });
    const tool = (botId: string) => createHistoryToolExtension({ archive, memory }).extraTools!(botId, () => null)[0]!;
    const search = async (botId: string, query: string) => (await tool(botId).handler({ query })).text;
    return { memory, search };
  }

  it("finds the Bot's own facts and the shared user facts, never another Bot's own memory", async () => {
    const { memory, search } = setup();
    for (let i = 0; i < 40; i++) memory.add({ kind: "agent", botId: ME }, { content: `Garden bed ${i} gets tomatoes`, tier: "log", kind: "fact" });
    memory.add({ kind: "agent", botId: ME }, { content: "The landlord is Mark Ellis", tier: "log", kind: "fact" });
    memory.add({ kind: "agent", botId: OTHER }, { content: "The landlord owes a refund", tier: "log", kind: "fact" });
    memory.add({ kind: "user", botId: OTHER }, { content: "Landlord calls are on Mondays", tier: "profile", kind: "fact" });
    const text = await search(ME, "landlord");
    expect(text).toContain("The landlord is Mark Ellis");
    expect(text).toContain("Landlord calls are on Mondays");
    expect(text).not.toContain("refund");
    expect(await search(ME, "garden bed 7")).toContain("Garden bed 7 gets tomatoes");
    expect(await search(ME, "zebra")).toMatch(/No matches in your history/);
  });
});
