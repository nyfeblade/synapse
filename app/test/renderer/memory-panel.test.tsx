// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { STRM, type BotSummary, type MemoryFactView } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { MemoryPanel } from "../../src/renderer/components/MemoryPanel";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// MEM-09, DESIGNED: a Bot's memory was state the user could neither see nor act on — the repo's
// recurring bug class. These assert what a PERSON sees and can do; the host tests
// (host/test/memory/memory-commands.test.ts, memory-screen-gateway.test.ts) assert the files change.

const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
  lastBotMessageAt: 0,
};
const fact = (id: string, content: string | null, over: Partial<MemoryFactView> = {}): MemoryFactView => ({ id, date: "2026-09-01", tier: "profile", kind: "fact", content, ...over });

type Handler = (args: Record<string, unknown>) => unknown;
let db: Record<string, MemoryFactView[]>;
let handlers: Record<string, Handler>;
const calls: [string, Record<string, unknown>][] = [];
const keyOf = (scope: { kind: string; slug?: string } | undefined) => (scope ? (scope.slug ? `project:${scope.slug}` : scope.kind) : "none");

beforeEach(() => {
  calls.length = 0;
  db = {
    agent: [fact("p1", "Prefers short answers"), fact("l1", "Booked the dentist", { tier: "log", date: "2026-08-14" }), fact("n1", "Waiting on Mark's reply", { tier: "log", kind: "note", date: "2026-09-10" })],
    user: [fact("u1", "Lives in Denver", { owner: "b", ownerName: "Otto" })],
    "project:kitchen-reno": [],
  };
  handlers = {
    getAgentMemories: (a) => ({ facts: a.scope ? db[keyOf(a.scope as never)] ?? [] : [], projects: ["kitchen-reno"] }),
    updateAgentMemory: (a) => { const list = db[keyOf(a.scope as never)]!; const i = list.findIndex((f) => f.id === a.factId); list[i] = { ...list[i]!, content: a.content as string }; return { fact: list[i] }; },
    deleteAgentMemory: (a) => { const k = keyOf(a.scope as never); db[k] = db[k]!.filter((f) => f.id !== a.factId); return { removed: true }; },
    addAgentMemory: (a) => { const f = fact("new", a.content as string, { tier: a.tier === "profile" ? "profile" : "log", kind: a.tier === "note" ? "note" : "fact" }); db[keyOf(a.scope as never)]!.push(f); return { added: true, fact: f }; },
    clearAgentMemories: (a) => { const k = keyOf(a.scope as never); const n = db[k]!.length; db[k] = []; return { removed: n }; },
    compactAgentNow: () => ({ scheduled: true }),
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const h = handlers[cmd];
      if (!h) return { ok: true, result: cmd === "updateAgent" ? { agent: bot } : {} };
      try { return { ok: true, result: await h(args) }; } catch (e) { return { ok: false, error: { code: "X", message: (e as Error).message } }; }
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    secrets: { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn() },
  };
  useUi.setState({ ...initialState(), bots: { a: bot }, panel: "settings" });
});
afterEach(cleanup);

const section = (name: string) => screen.getByRole("region", { name });
const mutations = () => calls.filter(([c]) => c !== "getAgentMemories");

describe("memory screen: reachable per Bot", () => {
  it("Bot settings has a Memory entry that opens this Bot's memory screen", async () => {
    render(<DetailsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: STRM.openMemoryLabel }));
    expect(useUi.getState().panel).toBe("memory");
    expect(await within(section(STRM.scopeAgent)).findByText("Prefers short answers")).toBeTruthy();
    // The Carbon look put the column on tabs (Now / Memory / Files): the gear is the way back to
    // Bot settings from any of them, in place of the memory screen's own Back arrow.
    fireEvent.click(screen.getByRole("button", { name: "Bot settings" }));
    expect(useUi.getState().panel).toBe("settings");
  });

  it("the settings panel itself makes no memory call just by opening", () => {
    render(<BotSettingsPanel botId="a" />);
    expect(calls.filter(([c]) => c === "getAgentMemories")).toEqual([]);
  });
});

describe("memory screen: what the Bot remembers, by scope and tier", () => {
  it("groups this Bot's memory into always known / log / notes, with dates", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Prefers short answers");
    const always = within(s).getByRole("group", { name: STRM.tierProfile });
    const log = within(s).getByRole("group", { name: STRM.tierLog });
    const notes = within(s).getByRole("group", { name: STRM.tierNote });
    expect(within(always).getByText("Prefers short answers")).toBeTruthy();
    expect(within(log).getByText("Booked the dentist")).toBeTruthy();
    expect(within(notes).getByText("Waiting on Mark's reply")).toBeTruthy();
    expect(within(log).getByText("Aug 14, 2026")).toBeTruthy();
    expect(within(notes).queryByText("Booked the dentist")).toBeNull();
  });

  it("'about you' says it is shared by all Bots, and which Bot learned each line", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeUser);
    expect(within(s).getByText(STRM.scopeUserHint)).toBeTruthy();
    expect(await within(s).findByText("Lives in Denver")).toBeTruthy();
    expect(within(s).getByText(STRM.via("Otto"))).toBeTruthy();
  });

  it("each joined project is a list of its own, with its own empty state", async () => {
    render(<MemoryPanel botId="a" />);
    const p = await screen.findByRole("region", { name: STRM.project("kitchen-reno") });
    expect(await within(p).findByText(STRM.empty)).toBeTruthy();
  });

  it("the MEM-05 freeze is said plainly, naming the Bot", async () => {
    render(<MemoryPanel botId="a" />);
    expect(screen.getByText(STRM.freezeNote("Courier"))).toBeTruthy();
  });
});

describe("memory screen: loading, empty and error per list (bug 37's pattern)", () => {
  it("each list names its own loading state, and answers independently", async () => {
    let resolveUser!: () => void;
    const gate = new Promise<void>((r) => { resolveUser = r; });
    const base = handlers.getAgentMemories!;
    handlers.getAgentMemories = async (a) => { if (keyOf(a.scope as never) === "user") await gate; return base(a); };
    render(<MemoryPanel botId="a" />);
    expect(screen.getByRole("status", { name: STRM.scopeAgent }).textContent).toBe("Loading…");
    expect(screen.getByRole("status", { name: STRM.scopeUser }).textContent).toBe("Loading…");
    await within(section(STRM.scopeAgent)).findByText("Prefers short answers");
    expect(screen.getByRole("status", { name: STRM.scopeUser }).textContent).toBe("Loading…");
    resolveUser();
    expect(await within(section(STRM.scopeUser)).findByText("Lives in Denver")).toBeTruthy();
  });

  it("a failed list shows its error with Retry, in place, while the others still work", async () => {
    let fail = true;
    const base = handlers.getAgentMemories!;
    handlers.getAgentMemories = (a) => { if (fail && keyOf(a.scope as never) === "user") throw new Error("The box isn't answering."); return base(a); };
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeUser);
    expect((await within(s).findByRole("alert")).textContent).toBe("The box isn't answering.");
    expect(within(section(STRM.scopeAgent)).getByText("Prefers short answers")).toBeTruthy();
    fail = false;
    fireEvent.click(within(s).getByRole("button", { name: "Retry" }));
    expect(await within(s).findByText("Lives in Denver")).toBeTruthy();
    expect(within(s).queryByRole("alert")).toBeNull();
  });

  it("a failed project list keeps its Retry too — the list of projects never just vanishes", async () => {
    let fail = true;
    const base = handlers.getAgentMemories!;
    handlers.getAgentMemories = (a) => { if (fail && !a.scope) throw new Error("Couldn't read projects."); return base(a); };
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.projects);
    expect((await within(s).findByRole("alert")).textContent).toBe("Couldn't read projects.");
    fail = false;
    fireEvent.click(within(s).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: STRM.project("kitchen-reno") })).toBeTruthy();
  });

  it("an empty scope says so rather than showing nothing", async () => {
    db.agent = [];
    render(<MemoryPanel botId="a" />);
    expect(await within(section(STRM.scopeAgent)).findByText(STRM.empty)).toBeTruthy();
  });
});

describe("memory screen: edit, delete, add, clear — each writes through the host", () => {
  it("edits a line and shows the new text", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Prefers short answers");
    fireEvent.click(within(s).getAllByRole("button", { name: STRM.edit })[0]!);
    const box = within(s).getByRole("textbox", { name: STRM.editLabel });
    fireEvent.change(box, { target: { value: "Prefers very short answers" } });
    fireEvent.click(within(s).getByRole("button", { name: STRM.save }));
    expect(await within(s).findByText("Prefers very short answers")).toBeTruthy();
    expect(within(s).queryByText("Prefers short answers")).toBeNull();
    expect(mutations()).toEqual([["updateAgentMemory", { id: "a", scope: { kind: "agent" }, factId: "p1", content: "Prefers very short answers" }]]);
  });

  it("an edit in 'about you' names the shard that holds the line", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeUser);
    await within(s).findByText("Lives in Denver");
    fireEvent.click(within(s).getByRole("button", { name: STRM.edit }));
    fireEvent.change(within(s).getByRole("textbox", { name: STRM.editLabel }), { target: { value: "Lives in Boulder" } });
    fireEvent.click(within(s).getByRole("button", { name: STRM.save }));
    await within(s).findByText("Lives in Boulder");
    expect(mutations()).toEqual([["updateAgentMemory", { id: "a", scope: { kind: "user" }, factId: "u1", owner: "b", content: "Lives in Boulder" }]]);
  });

  it("deletes one line", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Booked the dentist");
    const row = within(s).getByText("Booked the dentist").closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: STRM.delete }));
    await vi.waitFor(() => expect(within(s).queryByText("Booked the dentist")).toBeNull());
    expect(mutations()).toEqual([["deleteAgentMemory", { id: "a", scope: { kind: "agent" }, factId: "l1" }]]);
  });

  it("adds a line with 'Remember that…', in the chosen tier", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Prefers short answers");
    fireEvent.change(within(s).getByRole("textbox", { name: STRM.addLabel(STRM.scopeAgent) }), { target: { value: "Parcel due Friday" } });
    fireEvent.change(within(s).getByRole("combobox", { name: STRM.tierLabel }), { target: { value: "note" } });
    fireEvent.click(within(s).getByRole("button", { name: STRM.add }));
    const notes = await within(s).findByRole("group", { name: STRM.tierNote });
    expect(await within(notes).findByText("Parcel due Friday")).toBeTruthy();
    expect(mutations()).toEqual([["addAgentMemory", { id: "a", scope: { kind: "agent" }, content: "Parcel due Friday", tier: "note" }]]);
    expect((within(s).getByRole("textbox", { name: STRM.addLabel(STRM.scopeAgent) }) as HTMLInputElement).value).toBe("");
  });

  it("clearing a scope asks first, and only the confirmation clears", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Prefers short answers");
    fireEvent.click(within(s).getByRole("button", { name: STRM.clear }));
    expect(mutations()).toEqual([]);
    expect(within(s).getByText(STRM.clearAsk(STRM.scopeAgent))).toBeTruthy();
    fireEvent.click(within(s).getByRole("button", { name: STRM.cancel }));
    expect(within(s).getByText("Prefers short answers")).toBeTruthy();
    fireEvent.click(within(s).getByRole("button", { name: STRM.clear }));
    fireEvent.click(within(s).getByRole("button", { name: STRM.clearConfirm }));
    expect(await within(s).findByText(STRM.empty)).toBeTruthy();
    expect(mutations()).toEqual([["clearAgentMemories", { id: "a", scope: { kind: "agent" } }]]);
  });

  it("clearing 'about you' warns that every Bot loses it", async () => {
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeUser);
    await within(s).findByText("Lives in Denver");
    fireEvent.click(within(s).getByRole("button", { name: STRM.clear }));
    expect(within(s).getByText(STRM.clearAskUser)).toBeTruthy();
  });

  it("a refused write shows the host's reason in that list and keeps what was typed", async () => {
    handlers.addAgentMemory = () => { throw new Error("Not saved — that looks like a secret. Keep it in this Bot's Secrets instead."); };
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    await within(s).findByText("Prefers short answers");
    const box = within(s).getByRole("textbox", { name: STRM.addLabel(STRM.scopeAgent) });
    fireEvent.change(box, { target: { value: "door code 4411" } });
    fireEvent.click(within(s).getByRole("button", { name: STRM.add }));
    expect((await within(s).findByRole("alert")).textContent).toMatch(/looks like a secret/);
    expect((box as HTMLInputElement).value).toBe("door code 4411");
  });
});

describe("memory screen: secrets and the refresh", () => {
  it("a secret-looking line shows no text and cannot be edited, only deleted", async () => {
    db.agent = [fact("s1", null), fact("p1", "Prefers short answers")];
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    const hidden = (await within(s).findByText(STRM.hiddenSecret)).closest("li") as HTMLElement;
    expect(within(hidden).queryByRole("button", { name: STRM.edit })).toBeNull();
    fireEvent.click(within(hidden).getByRole("button", { name: STRM.delete }));
    await vi.waitFor(() => expect(within(s).queryByText(STRM.hiddenSecret)).toBeNull());
    expect(mutations()).toEqual([["deleteAgentMemory", { id: "a", scope: { kind: "agent" }, factId: "s1" }]]);
  });

  it("Refresh now compacts the conversation and says what happened", async () => {
    render(<MemoryPanel botId="a" />);
    expect(screen.getByText(STRM.refreshHint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STRM.refreshNow }));
    expect(await screen.findByText(STRM.refreshScheduled)).toBeTruthy();
    expect(mutations()).toEqual([["compactAgentNow", { id: "a" }]]);
  });

  it("when the host can't refresh now, it says the change waits for the next refresh", async () => {
    handlers.compactAgentNow = () => ({ scheduled: false });
    render(<MemoryPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: STRM.refreshNow }));
    expect(await screen.findByText(STRM.refreshUnavailable)).toBeTruthy();
  });
});

describe("memory screen: provenance (who learned it, when, from where, and what it used to be)", () => {
  const prov = { botId: "a", botName: "Courier", recordedAt: Date.UTC(2026, 8, 3), source: "user" as const, confidence: 0.8, chatBotId: "a", messageId: "t12u" };

  it("shows 'learned from <Bot> · <date> · <source>' and opens the chat message it came from", async () => {
    db.agent = [fact("d1", "The user's dentist is Ana Ruiz.", { provenance: prov, history: [] })];
    const jumpTo = vi.fn(async () => {});
    const real = useUi.getState().jumpTo;
    onTestFinished(() => useUi.setState({ jumpTo: real }));
    useUi.setState({ jumpTo });
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    expect(await within(s).findByText(STRM.learnedFrom("Courier"))).toBeTruthy();
    expect(within(s).getByText("Sep 3, 2026")).toBeTruthy();
    expect(within(s).getByText(STRM.source.user)).toBeTruthy();
    fireEvent.click(within(s).getByRole("button", { name: STRM.openSourceLabel("Courier") }));
    expect(jumpTo).toHaveBeenCalledWith("a", "t12u");
  });

  it("a changed fact shows its history; a correction says so; the actions read Correct this and Forget", async () => {
    db.agent = [fact("d2", "The user's employer is Verdigris.", {
      provenance: { ...prov, botId: null, botName: null, confidence: 1, chatBotId: null, messageId: null },
      history: [{ content: "The user's employer is Quillon.", validFrom: Date.UTC(2026, 5, 1), validTo: Date.UTC(2026, 8, 3), source: "user", botName: "Courier" }],
    })];
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeAgent);
    expect(await within(s).findByText(STRM.learnedFromYou)).toBeTruthy();
    expect(within(s).getByText(STRM.sourceCorrected)).toBeTruthy();
    expect(within(s).getByText(STRM.history(1))).toBeTruthy();
    expect(within(s).getByText("The user's employer is Quillon.")).toBeTruthy();
    expect(within(s).queryByRole("button", { name: /Open the message/ })).toBeNull();
    expect(within(s).getByRole("button", { name: "Correct this" })).toBeTruthy();
    expect(within(s).getByRole("button", { name: "Forget" })).toBeTruthy();
  });

  it("team knowledge is its own list, shared by all Bots, with its own clear warning", async () => {
    db.team = [fact("t1", "Releases ship on Thursdays.", { owner: "b", ownerName: "Otto" })];
    render(<MemoryPanel botId="a" />);
    const s = section(STRM.scopeTeam);
    expect(within(s).getByText(STRM.scopeTeamHint)).toBeTruthy();
    expect(await within(s).findByText("Releases ship on Thursdays.")).toBeTruthy();
    fireEvent.click(within(s).getByRole("button", { name: STRM.clear }));
    expect(within(s).getByText(STRM.clearAskTeam)).toBeTruthy();
  });
});
