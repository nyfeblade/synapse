import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../memory/memory-store";
import { renderMemorySection } from "../../memory/render";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const SCOUT = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
const names: Record<string, string> = { [ME]: "Piper", [SCOUT]: "Scout" };

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
  return { cfg, store, render: () => renderMemorySection({ store, botId: ME, nameOf: (id) => names[id] ?? id, dataRoot: cfg.dataRoot }) };
}

describe("renderMemorySection (MEM-04)", () => {
  it("renders user → project → Bot with via names and learned dates", () => {
    const { store, render } = setup();
    store.add({ kind: "user", botId: SCOUT }, { content: "Works in Pacific time", tier: "profile", kind: "fact", date: "2026-09-01" });
    store.createProject("launch", ME, "Q4 launch");
    store.add({ kind: "project", botId: ME, slug: "launch" }, { content: "Launch date is Oct 30", tier: "profile", kind: "fact", date: "2026-09-02" });
    store.add({ kind: "agent", botId: ME }, { content: "Prefers short answers", tier: "profile", kind: "fact", date: "2026-09-03" });
    store.add({ kind: "agent", botId: ME }, { content: "Waiting on the landlord", tier: "log", kind: "note", date: "2026-09-10" });
    const { text, ids } = render();
    const u = text.indexOf("Works in Pacific time"), p = text.indexOf("Launch date is Oct 30"), a = text.indexOf("Prefers short answers");
    expect(u).toBeGreaterThan(0);
    expect(u < p && p < a).toBe(true);
    expect(text).toContain("- (learned 2026-09-01) [via Scout] Works in Pacific time");
    expect(text).toContain("- (learned 2026-09-10) [note] Waiting on the landlord");
    expect(ids).toHaveLength(4);
  });

  it("applies precedence own > user and the overflow line", () => {
    const { store, render } = setup();
    store.add({ kind: "user", botId: SCOUT }, { content: "Prefers short answers", tier: "profile", kind: "fact", date: "2026-09-01" });
    store.add({ kind: "agent", botId: ME }, { content: "Prefers short answers", tier: "profile", kind: "fact", date: "2026-09-03" });
    for (let i = 0; i < 40; i++) store.add({ kind: "agent", botId: ME }, { content: `Log fact number ${i} about the garden project`, tier: "log", kind: "fact", date: "2026-09-05" });
    const { text } = render();
    expect(text.match(/Prefers short answers/g)).toHaveLength(1);
    // Bug #61: the Bot folder is host-private, so the overflow points at the host-side search, never a path.
    expect(text).toContain("(10 more facts — SearchHistory finds them)");
    expect(text).not.toContain("/agents/");
  });

  it("says so when nothing is remembered", () => {
    expect(setup().render().text).toBe("# Memory\n(nothing remembered yet)");
  });

  it("renders team knowledge from every Bot's team shard, naming the writer (memory provenance)", () => {
    const { store, render } = setup();
    store.add({ kind: "team", botId: SCOUT }, { content: "Releases ship on Thursdays", tier: "profile", kind: "fact", date: "2026-09-05" });
    store.add({ kind: "team", botId: ME }, { content: "Staging runs on box 3", tier: "log", kind: "fact", date: "2026-09-06" });
    const r = render();
    expect(r.text).toContain("## Team knowledge (shared by all your teammates)\n- (learned 2026-09-05) [via Scout] Releases ship on Thursdays\n- (learned 2026-09-06) Staging runs on box 3");
    expect(r.ids).toHaveLength(2);
  });
});
