// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateManifest } from "@synapse/shared";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { DetailsSheet } from "../../src/renderer/templates/DetailsSheet";
import { ExportSheet } from "../../src/renderer/templates/ExportSheet";
import { ImportSheet } from "../../src/renderer/templates/ImportSheet";
import { TemplateMenu } from "../../src/renderer/templates/TemplateMenu";
import { useTemplates } from "../../src/renderer/templates/store";

const draft: TemplateManifest = {
  profile: { name: "Courier", title: "Inbox", description: "Handles my inbox.", avatarShape: "orb", avatarColor: "#3472d9" },
  skills: [{ id: "weekly-report", name: "weekly-report", description: "Writes the weekly report" }], memories: ["Prefer short replies.", "Standups at 10 AM."],
  routines: [{ name: "Morning sweep", prompt: "Sweep", schedule: "0 8 * * *" }], plugins: [{ catalogId: "curated:linear", name: "Linear" }],
};
const calls: [string, unknown][] = [];
let template: unknown = null;
beforeEach(() => {
  calls.length = 0;
  template = null;
  const results = (c: string): unknown => ({
    getTemplate: { template }, draftTemplate: { draft }, exportTemplate: { template: { id: "t1", name: "Courier" }, fileName: "courier.botpack", bytesBase64: "UEs=" },
    previewTemplateImport: { token: "tok", name: "Trip Desk", description: "Plans trips.", author: { name: "Ana" }, facts: ["Aisle seats."], playbooks: ["book-flights"], jobs: ["Fare watch"], apps: [{ name: "Notion", needsConnecting: true }], thirdParty: true },
    importTemplate: { id: "new-bot" },
  } as Record<string, unknown>)[c] ?? {};
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => { calls.push([c, a]); return { ok: true, result: results(c) }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: n === "saveFile" ? { path: "/Users/u/Desktop/courier.botpack" } : {} }; }), on: () => () => {} },
  };
  useUi.setState({ ...initialState(), openBot: vi.fn() } as never);
  useTemplates.setState({ sheet: null });
});
afterEach(cleanup);

describe("Template actions menu (S11, TPL-01)", () => {
  it("offers Export Bot… before a template exists, then details/update/delete", async () => {
    render(<TemplateMenu botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "Template actions" }));
    expect(await screen.findByRole("menuitem", { name: "Export Bot…" })).toBeTruthy();
    cleanup();
    template = { id: "t1", name: "Courier", manifest: draft };
    render(<TemplateMenu botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "Template actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["View template details", "Update template", "Delete Template"]);
    expect(within(menu).getByRole("menuitem", { name: "Delete Template" }).className).toContain("danger");
  });
});

describe("template details (fix round 1, finding 1)", () => {
  it("View template details opens a details sheet showing what the template includes", async () => {
    template = { id: "t1", name: "Courier", author: { name: "Ana" }, sourceBotId: "b1", visibility: "local", createdAt: 0, updatedAt: 0, manifest: draft };
    await useTemplates.getState().openDetails("b1");
    render(<DetailsSheet />);
    const sheet = screen.getByRole("dialog", { name: "Courier" });
    expect(within(sheet).getByText("Ana's")).toBeTruthy();
    expect(within(sheet).getByText("Handles my inbox.")).toBeTruthy();
    for (const h of ["Facts it already knows", "Playbooks it can run", "Jobs that run on their own", "Apps it can use"]) expect(within(sheet).getByText(h)).toBeTruthy();
    expect(within(sheet).getByText("Standups at 10 AM.")).toBeTruthy();
    expect(within(sheet).getByText("weekly-report")).toBeTruthy();
    expect(within(sheet).getByText("Morning sweep")).toBeTruthy();
    expect(within(sheet).getByText("Linear")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(useTemplates.getState().sheet).toBeNull();
  });

  it("renders nothing when the sheet isn't a details sheet", () => {
    useTemplates.setState({ sheet: null });
    const { container } = render(<DetailsSheet />);
    expect(container.firstChild).toBeNull();
  });
});

describe("export review (TPL-01)", () => {
  it("closing before draftTemplate resolves doesn't let the stale response reopen the sheet (e2e flake: Escape right after opening, then the fetch lands)", async () => {
    let resolveDraft!: () => void;
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      if (c === "draftTemplate") return new Promise((res) => { resolveDraft = () => res({ ok: true, result: { draft } }); });
      return { ok: true, result: {} };
    });
    const p = useTemplates.getState().openExport("b1");
    expect(useTemplates.getState().sheet).not.toBeNull();
    useTemplates.getState().close(); // e.g. Escape, right after opening — before the draft fetch lands
    expect(useTemplates.getState().sheet).toBeNull();
    resolveDraft();
    await p;
    expect(useTemplates.getState().sheet).toBeNull(); // the stale response must not reopen it
  });

  it("lets the user drop items, then saves a .botpack through the save dialog", async () => {
    await useTemplates.getState().openExport("b1");
    render(<ExportSheet />);
    const sheet = screen.getByRole("dialog", { name: "Review template" });
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Standups at 10 AM." }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save template" }));
    await vi.waitFor(() => expect(calls.find((c) => c[0] === "exportTemplate")?.[1]).toEqual({ id: "b1", manifest: { ...draft, memories: ["Prefer short replies."] } }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:saveFile", { defaultName: "courier.botpack", bytesBase64: "UEs=", filters: [{ name: "Bot template", extensions: ["botpack"] }] }]));
    expect(await screen.findByText("Saved to /Users/u/Desktop/courier.botpack")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy as file path" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(calls).toContainEqual(["native:revealPath", { path: "/Users/u/Desktop/courier.botpack" }]);
  });

  it("imports a .botpack the OS opened (double-click / AirDrop) through the same preview", async () => {
    (window as unknown as { synapse: { native: { invoke: ReturnType<typeof vi.fn> } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => {
      calls.push([`native:${n}`, a]);
      if (n === "readDroppedFile") return { ok: true, result: { bytesBase64: "UEs=" } };
      return { ok: true, result: {} };
    });
    await useTemplates.getState().importFromOpenedPath("/Users/u/Downloads/courier.botpack");
    expect(calls).toContainEqual(["native:readDroppedFile", { path: "/Users/u/Downloads/courier.botpack", maxBytes: expect.any(Number) }]);
    expect(calls.find((c) => c[0] === "previewTemplateImport")?.[1]).toEqual({ bytesBase64: "UEs=" });
    expect(useTemplates.getState().sheet?.kind).toBe("import");
  });

  it("Escape closes Review template and returns focus to the trigger (controller ruling 3)", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    await useTemplates.getState().openExport("b1");
    render(<ExportSheet />);
    expect(screen.getByRole("dialog", { name: "Review template" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTemplates.getState().sheet).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("import preview (TPL-02)", () => {
  it("shows the four sections, Needs connecting and the third-party warning; Add Bot imports and opens it", async () => {
    await useTemplates.getState().importBytes("UEs=");
    render(<ImportSheet />);
    const sheet = screen.getByRole("dialog", { name: "Trip Desk" });
    for (const h of ["Facts it already knows", "Playbooks it can run", "Jobs that run on their own", "Apps it can use"]) expect(within(sheet).getByText(h)).toBeTruthy();
    expect(within(sheet).getByText("Needs connecting")).toBeTruthy();
    // Bot sharing (security review): a third-party add is a shared Bot that asks first.
    expect(within(sheet).getByText("Added as a shared Bot: asks before acting.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Bot" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["importTemplate", { token: "tok" }]));
    await vi.waitFor(() => expect(useUi.getState().openBot).toHaveBeenCalledWith("new-bot"));
  });

  it("Add Bot from the Marketplace closes the Marketplace so the new Bot is in view", async () => {
    useMarketplace.setState({ open: true });
    await useTemplates.getState().importBytes("UEs=");
    render(<ImportSheet />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Trip Desk" })).getByRole("button", { name: "Add Bot" }));
    await vi.waitFor(() => expect(useUi.getState().openBot).toHaveBeenCalledWith("new-bot"));
    expect(useMarketplace.getState().open).toBe(false);
  });

  it("Marketplace template Add goes through the preview (starter ids)", async () => {
    await import("../../src/renderer/templates/store");
    await useMarketplace.getState().add({ id: "starter:chief-of-staff", kind: "bot-template", source: "starter", name: "Chief of Staff", description: "", category: null, logo: null, action: "add", state: "available" });
    await vi.waitFor(() => expect(calls).toContainEqual(["previewTemplateImport", { starterId: "starter:chief-of-staff" }]));
  });
});
