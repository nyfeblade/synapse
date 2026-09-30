// @vitest-environment jsdom
// Bot sharing, phase 2: the Share sheet, the Import sheet's additions and synapse://import links.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePreview, TemplatePreview } from "@synapse/shared";
import { openDeepLink, parseImportLink } from "../../src/renderer/deep-links";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { ImportSheet } from "../../src/renderer/templates/ImportSheet";
import { ShareSheet } from "../../src/renderer/templates/ShareSheet";
import { useTemplates } from "../../src/renderer/templates/store";

const share = (over: Partial<SharePreview> = {}): SharePreview => ({
  name: "Scout", title: "Research", instructions: "Research and cite sources.", face: { shape: "gem", color: "#3674d8" },
  skills: [{ id: "notes", name: "notes", description: "Keeps notes", runsCode: false, included: true }, { id: "runner", name: "runner", description: "Runs", runsCode: true, included: true }],
  tools: [{ catalogId: "curated:linear", name: "Linear", included: true }],
  fragment: "b1.abc", length: 6, hidden: "1 key", sameAsLastShare: false, selection: { skills: ["notes", "runner"], tools: ["curated:linear"] }, ...over,
});
const preview = (over: Partial<TemplatePreview> = {}): TemplatePreview => ({
  token: "tok", name: "Scout", description: "Research and cite sources.", facts: [], playbooks: ["notes", "runner"], jobs: [], apps: [{ name: "Linear", needsConnecting: true }],
  thirdParty: true, playbooksShared: false, share: true, instructions: "Research and cite sources.", skills: [{ name: "notes", runsCode: false }, { name: "runner", runsCode: true }],
  flags: ["Instructions"], alreadyAdded: false, face: { shape: "gem", color: "#3674d8" }, ...over,
});

const calls: [string, unknown][] = [];
let results: Record<string, (a: unknown) => unknown>;
let clipboard = "";
beforeEach(() => {
  calls.length = 0;
  clipboard = "";
  results = {
    sharePayload: () => share(),
    previewShareImport: () => preview(),
    importTemplate: () => ({ id: "new-bot" }),
    exportTemplate: () => ({ template: { id: "t1", name: "Scout" }, fileName: "scout.botpack", bytesBase64: "UEs=" }),
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      try { return { ok: true, result: (results[c] ?? (() => ({})))(a) }; } catch (e) { const x = e as { code: string; message: string }; return { ok: false, error: { code: x.code, message: x.message } }; }
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: n === "saveFile" ? { path: "/Users/u/Desktop/scout.botpack" } : {} }; }), on: () => () => {} },
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (t: string) => { clipboard = t; }), readText: vi.fn(async () => clipboard) } });
  useUi.setState({ ...initialState(), openBot: vi.fn(), openSettings: vi.fn() } as never);
  useTemplates.setState({ sheet: null, importReady: true, pendingShare: null, afterAdd: null });
});
afterEach(cleanup);
const named = (c: string) => calls.filter(([n]) => n === c);

describe("Share sheet", () => {
  it("shows the face, the rows and what's never included, and copies the link with one click", async () => {
    useTemplates.getState().openShare("b1");
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    for (const t of ["Instructions", "Skills", "Tools", "Look", "Never included: memory, chats, keys, accounts.", "1 key hidden"]) expect(within(sheet).getByText(t)).toBeTruthy();
    expect(within(sheet).getByText("Runs code")).toBeTruthy();
    expect(within(sheet).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true]);
    const copy = within(sheet).getByRole("button", { name: "Copy link" });
    await waitFor(() => expect(document.activeElement).toBe(copy)); // the default on Enter
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toBe("https://synapse-site-virid.vercel.app/bot#b1.abc"));
    expect(named("sharePayload").at(-1)![1]).toMatchObject({ id: "b1", remember: true, selection: { skills: ["notes", "runner"], tools: ["curated:linear"] } });
    expect(await within(sheet).findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("unticking a skill or a tool asks again with the new selection", async () => {
    useTemplates.getState().openShare("b1");
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    results.sharePayload = (a) => share({ selection: (a as { selection?: SharePreview["selection"] }).selection ?? share().selection });
    fireEvent.click(within(sheet).getByRole("checkbox", { name: /^runner/ }));
    await waitFor(() => expect(named("sharePayload").at(-1)![1]).toMatchObject({ selection: { skills: ["notes"], tools: ["curated:linear"] } }));
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Linear" }));
    await waitFor(() => expect(named("sharePayload").at(-1)![1]).toMatchObject({ selection: { skills: ["notes"], tools: [] } }));
  });

  it("Instructions expands to the full text, as plain text", async () => {
    results.sharePayload = () => share({ instructions: "**bold** <img src=x>" });
    useTemplates.getState().openShare("b1");
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    const row = within(sheet).getByRole("button", { name: "Instructions" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(within(sheet).getByText("**bold** <img src=x>")).toBeTruthy();
    expect(sheet.querySelector("img, strong")).toBeNull();
  });

  it("Share… hands the link to the Mac's share menu", async () => {
    useTemplates.getState().openShare("b1");
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Share…" }));
    await waitFor(() => expect(named("native:shareMenu")[0]![1]).toMatchObject({ url: "https://synapse-site-virid.vercel.app/bot#b1.abc" }));
  });

  it("too big for a link: says so, and the main button saves a .botpack with no memories", async () => {
    results.sharePayload = () => share({ fragment: null, length: 20_000 });
    useTemplates.getState().openShare("b1");
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    expect(within(sheet).getByText("Too big for a link.")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Copy link" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save .botpack" }));
    await waitFor(() => expect(named("exportTemplate")).toHaveLength(1));
    expect(named("exportTemplate")[0]![1]).toMatchObject({ id: "b1", manifest: { memories: [], routines: [], skills: [{ id: "notes" }, { id: "runner" }], plugins: [{ catalogId: "curated:linear" }] } });
    await waitFor(() => expect(named("native:saveFile")).toHaveLength(1));
  });

  it("the menu's Copy link copies the last link in one click", async () => {
    results.sharePayload = () => share({ sameAsLastShare: true });
    await useTemplates.getState().copyShareLink("b1");
    expect(clipboard).toBe("https://synapse-site-virid.vercel.app/bot#b1.abc");
    expect(useTemplates.getState().sheet).toBeNull();
  });
});

describe("Import sheet for a shared Bot", () => {
  it("shows the face, instructions (plain text, collapsible), Runs code, flags, and adds with one confirm", async () => {
    await useTemplates.getState().importShare("b1.abc");
    render(<ImportSheet />);
    const sheet = screen.getByRole("dialog", { name: "Scout" });
    expect(sheet.querySelector(".tpl-face")).toBeTruthy();
    expect(within(sheet).getByText("Runs code")).toBeTruthy();
    expect(within(sheet).getByText("Unusual text")).toBeTruthy();
    expect(within(sheet).getAllByText("Instructions").length).toBeGreaterThan(0);
    expect(within(sheet).getByText("Research and cite sources.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Instructions" }));
    expect(within(sheet).queryByText("Research and cite sources.")).toBeNull();
    expect(named("importTemplate")).toHaveLength(0); // nothing is saved before Add Bot
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Bot" }));
    await waitFor(() => expect(named("importTemplate")[0]![1]).toEqual({ token: "tok" }));
    await waitFor(() => expect(useUi.getState().openBot).toHaveBeenCalledWith("new-bot"));
  });

  it("a Bot you already have says so and offers Add a copy", async () => {
    results.previewShareImport = () => preview({ alreadyAdded: true });
    await useTemplates.getState().importShare("b1.abc");
    render(<ImportSheet />);
    const sheet = screen.getByRole("dialog", { name: "Scout" });
    expect(within(sheet).getByText("You already have this Bot.")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Add a copy" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Add Bot" })).toBeNull();
  });

  it("Cancel adds nothing", async () => {
    await useTemplates.getState().importShare("b1.abc");
    render(<ImportSheet />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Scout" })).getByRole("button", { name: "Cancel" }));
    expect(useTemplates.getState().sheet).toBeNull();
    expect(named("importTemplate")).toHaveLength(0);
  });

  it("each bad link shows its one calm line; a newer one offers Update", async () => {
    for (const [code, message] of [["SHARE_DAMAGED", "This link is damaged."], ["SHARE_TOO_LONG", "This link is too long. Ask for the .botpack file."], ["SHARE_NEWER", "This Bot needs a newer Synapse."], ["PREVIEW_EXPIRED", "x"]] as const) {
      results.previewShareImport = () => { throw { code, message }; };
      await useTemplates.getState().importShare(`b1.${code}`);
      render(<ImportSheet />);
      const sheet = screen.getByRole("dialog");
      expect(within(sheet).getByText(code === "PREVIEW_EXPIRED" ? "This link is damaged." : message)).toBeTruthy();
      expect(!!within(sheet).queryByRole("button", { name: "Update" })).toBe(code === "SHARE_NEWER");
      cleanup();
      useTemplates.setState({ sheet: null });
    }
    expect(useUi.getState().actionError).toBeFalsy(); // one line in the sheet, not the sidebar banner too
  });

  it("an expired preview says to open the link again", async () => {
    await useTemplates.getState().importShare("b1.abc");
    results.importTemplate = () => { throw { code: "PREVIEW_EXPIRED", message: "This preview expired. Open the link again." }; };
    render(<ImportSheet />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Scout" })).getByRole("button", { name: "Add Bot" }));
    expect(await screen.findByText("This preview expired. Open the link again.")).toBeTruthy();
  });
});

describe("synapse://import links", () => {
  it("parses only synapse://import with a fragment", () => {
    expect(parseImportLink("synapse://import#b1.abc")).toBe("b1.abc");
    expect(parseImportLink("bots://import#b1.abc")).toBe(null);
    expect(parseImportLink("synapse://import")).toBe(null);
    expect(parseImportLink("https://x/bot#b1.abc")).toBe(null);
  });

  it("opens the confirm sheet (a link in a chat too), never adds by itself", async () => {
    expect(openDeepLink("synapse://import#b1.abc")).toBe(true);
    await waitFor(() => expect(useTemplates.getState().sheet?.kind).toBe("import"));
    expect(named("importTemplate")).toHaveLength(0);
  });

  it("an unknown synapse:// route says it needs a newer Synapse instead of doing nothing", () => {
    expect(openDeepLink("synapse://someday/feature")).toBe(true);
    expect(useTemplates.getState().sheet).toMatchObject({ kind: "share-error", message: "This link needs a newer Synapse." });
    expect(openDeepLink("https://example.com")).toBe(false);
  });

  it("twenty fast clicks give one sheet and one preview", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    results.previewShareImport = () => gate.then(() => preview());
    for (let i = 0; i < 20; i++) openDeepLink("synapse://import#b1.abc");
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(useTemplates.getState().sheet?.kind).toBe("import"));
    expect(named("previewShareImport")).toHaveLength(1);
    for (let i = 0; i < 5; i++) openDeepLink("synapse://import#b1.abc");
    expect(named("previewShareImport")).toHaveLength(1);
  });

  it("a link during setup or onboarding waits until it's finished", async () => {
    useTemplates.getState().setImportReady(false);
    openDeepLink("synapse://import#b1.abc");
    await Promise.resolve();
    expect(named("previewShareImport")).toHaveLength(0);
    expect(useTemplates.getState().sheet).toBeNull();
    useTemplates.getState().setImportReady(true);
    await waitFor(() => expect(useTemplates.getState().sheet?.kind).toBe("import"));
    expect(named("previewShareImport")).toHaveLength(1);
  });
});

describe("security review: what a third-party add means", () => {
  it("says it's added as a shared Bot that asks before acting (a .botpack from your own other Mac included)", async () => {
    await useTemplates.getState().importShare("b1.abc");
    render(<ImportSheet />);
    const sheet = screen.getByRole("dialog", { name: "Scout" });
    expect(within(sheet).getByText("Added as a shared Bot: asks before acting.")).toBeTruthy();
    expect(within(sheet).queryByText(/may act on your behalf/)).toBeNull();
  });
});
