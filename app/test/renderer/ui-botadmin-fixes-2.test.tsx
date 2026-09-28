// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, type CatalogEntry, type MarketplaceView, type SkillView, type TemplatePreview } from "@synapse/shared";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { NewChat } from "../../src/renderer/components/NewChat";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { PrivateSkills } from "../../src/renderer/components/PrivateSkills";
import { ImportSheet } from "../../src/renderer/templates/ImportSheet";
import { TemplateMenu } from "../../src/renderer/templates/TemplateMenu";
import { useTemplates } from "../../src/renderer/templates/store";
import { initialState } from "../../src/renderer/reducer";
import { useOverlays } from "../../src/renderer/overlays";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

const skill = (over: Partial<SkillView> = {}): SkillView => ({ id: "weekly-report", name: "Weekly report", description: "Use this when the user asks for the weekly report.", source: null, managed: false, bodyChars: 20, disabledFor: [], updatedAt: 1, ...over });
const preview: TemplatePreview = { token: "tk", name: "Trip Desk", description: "Plans trips.", facts: [], playbooks: [], jobs: [], apps: [], thirdParty: false };

afterEach(() => { cleanup(); useTemplates.setState({ sheet: null }); useOverlays.setState({ open: null }); });

describe("Onboarding (fix-ui-botadmin)", () => {
  const calls: [string, unknown][] = [];
  beforeEach(() => {
    calls.length = 0;
    const results: Record<string, unknown> = {
      getOnboarding: { hasSeenOnboarding: false, tokenConfigured: false },
      listStarterTemplates: { starters: [{ id: "starter:chief-of-staff", name: "Chief of Staff", title: "Your week", blurb: "Runs your week.", avatarShape: "gem", avatarColor: "#3472d9", tools: ["Gmail"] }] },
      createAgent: { id: "new-bot" }, previewTemplateImport: { token: "tk" }, importTemplate: { id: "starter-bot" },
    };
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (c: string, a: unknown) => { calls.push([c, a]); return { ok: true, result: results[c] ?? {} }; }),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
    };
  });

  it("the setup step has a way back to the splash", async () => {
    render(<Onboarding onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Input API Key →" }));
    expect(await screen.findByRole("heading", { name: STR5.setupTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR5.back }));
    expect(screen.getByRole("button", { name: "Input API Key →" })).toBeTruthy();
  });

  it("'Get started' creates one Bot however fast it is double-clicked", async () => {
    render(<Onboarding onDone={vi.fn()} initialStep="new-bot" />);
    const go = screen.getByRole("button", { name: STR5.getStarted });
    fireEvent.click(go);
    fireEvent.click(go);
    await waitFor(() => expect(calls.filter((c) => c[0] === "createAgent")).toHaveLength(1));
    expect(calls.filter((c) => c[0] === "createAgent")).toHaveLength(1);
  });

  it("a starter card imports once however fast it is double-clicked", async () => {
    render(<Onboarding onDone={vi.fn()} initialStep="new-bot" />);
    const card = await screen.findByRole("button", { name: "Meet Chief of Staff" });
    fireEvent.click(card);
    fireEvent.click(card);
    await waitFor(() => expect(calls.filter((c) => c[0] === "importTemplate")).toHaveLength(1));
    expect(calls.filter((c) => c[0] === "previewTemplateImport")).toHaveLength(1);
  });
});

describe("Manage skills (fix-ui-botadmin)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({ getWorkflows: { workflows: [skill()] }, getWorkflow: { workflow: skill(), body: "1. Pull numbers\n" } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, settings: settingsFixture() });
    useOverlays.setState({ open: "skills" });
  });

  it("a new skill whose name collides with an existing one asks before replacing it", async () => {
    render(<PrivateSkills />);
    await screen.findByText("Weekly report");
    fireEvent.click(screen.getByRole("button", { name: STR.newSkill }));
    fireEvent.change(screen.getByLabelText(STR.name), { target: { value: "Weekly Report" } });
    fireEvent.change(screen.getByLabelText("Skill body (Markdown)"), { target: { value: "1. New\n" } });
    const confirm = vi.fn(() => false);
    window.confirm = confirm as unknown as typeof window.confirm;
    fireEvent.click(screen.getByRole("button", { name: STR.save }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(bridge.calls.some(([c]) => c === "createWorkflow")).toBe(false);
    expect((screen.getByLabelText("Skill body (Markdown)") as HTMLTextAreaElement).value).toBe("1. New\n"); // the draft survives
    window.confirm = (() => true) as unknown as typeof window.confirm;
    fireEvent.click(screen.getByRole("button", { name: STR.save }));
    await waitFor(() => expect(bridge.calls.some(([c]) => c === "createWorkflow")).toBe(true));
  });

  it("a name that collides with nothing saves without asking", async () => {
    render(<PrivateSkills />);
    await screen.findByText("Weekly report");
    fireEvent.click(screen.getByRole("button", { name: STR.newSkill }));
    fireEvent.change(screen.getByLabelText(STR.name), { target: { value: "Garden rules" } });
    const confirm = vi.fn(() => false);
    window.confirm = confirm as unknown as typeof window.confirm;
    fireEvent.click(screen.getByRole("button", { name: STR.save }));
    await waitFor(() => expect(bridge.calls.some(([c]) => c === "createWorkflow")).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("releasing a text selection outside the modal doesn't throw the draft away", async () => {
    const { container } = render(<PrivateSkills />);
    await screen.findByText("Weekly report");
    const scrim = container.querySelector(".scrim")!;
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.click(scrim); // the drag started inside the dialog and ended on the backdrop
    expect(useOverlays.getState().open).toBe("skills");
    fireEvent.mouseDown(scrim); // a real click on the backdrop still closes it
    expect(useOverlays.getState().open).toBeNull();
  });
});

describe("New chat (fix-ui-botadmin)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({ createGroup: { id: "g2" }, createAgent: { id: "n1" }, openAgent: () => ({ agent: botFixture("g2", "Group") }), getAgentTranscriptTail: { entries: [] } });
    useUi.setState({ ...initialState(), bots: { p: botFixture("p", "Planner"), s: botFixture("s", "Scout") }, activeBotId: "p", settings: settingsFixture(), view: { kind: "new-chat" } });
  });

  it("'Create group' creates one group on a double click", async () => {
    render(<NewChat />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    fireEvent.click(screen.getByRole("option", { name: /Planner/ }));
    fireEvent.click(screen.getByRole("option", { name: /Scout/ }));
    const create = screen.getByRole("button", { name: "Create group" });
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(bridge.calls.filter(([c]) => c === "createGroup")).toHaveLength(1));
    expect(bridge.calls.filter(([c]) => c === "createGroup")).toHaveLength(1);
  });

  it("'Create new Bot' creates one Bot on a double ↵", async () => {
    render(<NewChat />);
    const to = screen.getByLabelText(STR.toLabel);
    fireEvent.keyDown(to, { key: "Enter" });
    fireEvent.keyDown(to, { key: "Enter" });
    await waitFor(() => expect(bridge.calls.filter(([c]) => c === "createAgent")).toHaveLength(1));
    expect(bridge.calls.filter(([c]) => c === "createAgent")).toHaveLength(1);
  });

  it("a failed create is shown instead of vanishing as an unhandled rejection", async () => {
    installFakeBridge({ createAgent: () => { throw new Error("Couldn't reach the computer"); } });
    render(<NewChat />);
    fireEvent.keyDown(screen.getByLabelText(STR.toLabel), { key: "Enter" });
    await waitFor(() => expect(useUi.getState().actionError).toBe("Couldn't reach the computer"));
  });

  it("hides the cancel affordance when there is no chat to go back to", () => {
    useUi.setState({ bots: {}, activeBotId: null });
    render(<NewChat />);
    expect(screen.queryByRole("button", { name: "Cancel new chat" })).toBeNull();
  });

  it("tolerates a sorted id the bots map can't resolve, instead of crashing the pane", () => {
    // sortedBotIds() derives every id from each entry's own `.id` field, not from the map's keys.
    // If a summary is ever stored under a key that disagrees with its own `.id` (the store bug this
    // suite also covers), the sorted list contains an id `bots[id]` cannot resolve. NewChat must skip
    // that entry rather than throw `Cannot read properties of undefined (reading 'settings')`.
    useUi.setState({
      bots: { p: botFixture("p", "Planner"), stale: { ...botFixture("s", "Scout"), id: "ghost" } },
    });
    expect(() => render(<NewChat />)).not.toThrow();
    expect(screen.getByRole("option", { name: /Planner/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Scout/ })).toBeNull();
  });

  it("store invariant: a Bot is always keyed by its own summary id, never by the id used to ask for it", async () => {
    // This fixture's openAgent always answers as "g2" regardless of which id was requested — standing
    // in for any case where the id a caller asked for and the id a response actually describes diverge.
    // openBot must key the map by the response's own id, or sortedBotIds() and the map fall out of step.
    render(<NewChat />);
    fireEvent.keyDown(screen.getByLabelText(STR.toLabel), { key: "Enter" });
    await waitFor(() => expect(bridge.calls.some(([c]) => c === "openAgent")).toBe(true));
    const bots = useUi.getState().bots;
    expect(Object.entries(bots).every(([key, b]) => b.id === key)).toBe(true);
    expect(bots.n1).toBeUndefined();
  });
});

describe("Template menu (fix-ui-botadmin)", () => {
  beforeEach(() => { useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, settings: settingsFixture() }); });

  it("asks before deleting a shared template, and does nothing when the answer is no", async () => {
    const bridge = installFakeBridge({ getTemplate: { template: { id: "t1" } } });
    render(<TemplateMenu botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: STR5.templateActions }));
    const item = await screen.findByRole("menuitem", { name: STR5.deleteTemplate });
    window.confirm = (() => false) as unknown as typeof window.confirm;
    fireEvent.click(item);
    expect(bridge.calls.some(([c]) => c === "deleteTemplate")).toBe(false);
  });

  it("surfaces a failed delete instead of dropping the rejection", async () => {
    installFakeBridge({ getTemplate: { template: { id: "t1" } }, deleteTemplate: () => { throw new Error("Template is gone"); } });
    render(<TemplateMenu botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: STR5.templateActions }));
    const item = await screen.findByRole("menuitem", { name: STR5.deleteTemplate });
    window.confirm = (() => true) as unknown as typeof window.confirm;
    fireEvent.click(item);
    await waitFor(() => expect(useUi.getState().actionError).toBe("Template is gone"));
  });
});

describe("Marketplace (fix-ui-botadmin)", () => {
  const entry: CatalogEntry = { id: "curated:linear", name: "Linear", kind: "plugin", source: "curated", description: "Linear things", category: "Code", logo: null, action: "add", state: "available" };
  const view: MarketplaceView = {
    installed: { count: 1, logos: [] }, featuredBots: [], forYou: { because: "GitHub", entries: [entry] },
    fromTeam: [], featuredPlugins: [], categories: [],
  };
  beforeEach(() => {
    installFakeBridge({ getMarketplace: view });
    useMarketplace.setState({ open: true, page: "detail", detailId: "curated:linear", view, query: "", results: null, waiting: {}, recent: [], error: null });
  });

  it("a detail page has a way back to the catalogue", () => {
    render(<MarketplaceModal />);
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR5.back }));
    expect(useMarketplace.getState().page).toBe("home");
    expect(screen.getByRole("button", { name: "Add Linear" })).toBeTruthy();
  });

  it("a detail page for a listing that hasn't loaded says so instead of rendering nothing", () => {
    useMarketplace.setState({ detailId: "curated:unknown", view: null });
    render(<MarketplaceModal />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: STR5.back })).toBeTruthy();
  });

  it("Escape with a template sheet layered on top closes the sheet, not the Marketplace", () => {
    useMarketplace.setState({ page: "home" });
    useTemplates.setState({ sheet: { kind: "import", preview } });
    render(<><MarketplaceModal /><ImportSheet /></>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTemplates.getState().sheet).toBeNull();
    expect(useMarketplace.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useMarketplace.getState().open).toBe(false);
  });
});
