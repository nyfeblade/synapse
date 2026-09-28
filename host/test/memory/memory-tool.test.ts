import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../memory/memory-store";
import { createMemoryToolExtension } from "../../memory/memory-tool";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
  const ext = createMemoryToolExtension({ store });
  const mem = (args: Record<string, unknown>) => ext.updateState!.memory!({ botId: ME, slot: null, args: { target: "memory", ...args }, now: Date.now });
  const proj = (args: Record<string, unknown>) => ext.updateState!.project!({ botId: ME, slot: null, args: { target: "project", ...args }, now: Date.now });
  return { store, mem, proj };
}

describe("update_state memory and project (MEM-03, TOOL-19)", () => {
  it("writes, dedupes and forgets with the spec's result strings", async () => {
    const { store, mem } = setup();
    expect((await mem({ action: "write", fact: "Prefers short answers", tier: "profile" })).text).toBe("Remembered in your memory (profile): Prefers short answers");
    expect((await mem({ action: "write", fact: "prefers short answers", tier: "profile" })).text).toBe("Already remembered in your memory: Prefers short answers");
    expect((await mem({ action: "write", fact: "Waiting on the landlord", tier: "note" })).text).toBe("Remembered in your memory (note): Waiting on the landlord");
    expect(store.log({ kind: "agent", botId: ME })[0]!.kind).toBe("note");
    expect((await mem({ action: "forget", fact: "Prefers short" })).isError).toBe(true);
    expect((await mem({ action: "forget", fact: "Prefers short answers" })).text).toBe("Forgot from your memory: Prefers short answers");
  });

  it("writes team knowledge to the Bot's team shard (memory provenance)", async () => {
    const { store, mem } = setup();
    expect((await mem({ action: "write", fact: "Releases ship on Thursdays", tier: "profile", scope: "team" })).text).toBe("Remembered in team memory (profile): Releases ship on Thursdays");
    expect(store.teamShardOwners()).toEqual([ME]);
    expect(store.all({ kind: "team", botId: ME }).map((f) => f.content)).toEqual(["Releases ship on Thursdays"]);
  });

  it("requires project membership", async () => {
    const { mem, proj } = setup();
    expect((await mem({ action: "write", fact: "Launch is Oct 30", scope: "project", project: "launch" })).text).toBe(`Not saved — project "launch" doesn't exist yet; create it or join it before using it`);
    expect((await proj({ action: "create", name: "launch", description: "Q4 launch" })).text).toBe('Created and joined project "launch".');
    expect((await mem({ action: "write", fact: "Launch is Oct 30", scope: "project", project: "launch" })).text).toBe('Remembered in project "launch" (log): Launch is Oct 30');
  });

  it("normalizes the project slug's case like the project handler does (TASK-10-1)", async () => {
    const { mem, proj } = setup();
    await proj({ action: "create", name: "launch", description: "Q4 launch" });
    expect((await mem({ action: "write", fact: "Launch is Oct 30", scope: "project", project: "Launch" })).text).toBe('Remembered in project "launch" (log): Launch is Oct 30');
  });
});
