// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelCatalogView, ModelPicksView, TemplatePreview } from "@synapse/shared";
import { NewChat } from "../../src/renderer/components/NewChat";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { ImportSheet } from "../../src/renderer/templates/ImportSheet";
import { useTemplates } from "../../src/renderer/templates/store";
import { useModelCatalog } from "../../src/renderer/model-catalog";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

/**
 * 0.1.7: creating a Bot shows its model; with several keys for the model's provider it also shows which key pays, the
 * provider's default preselected. With one key nothing extra shows. The choice is saved exactly as the picker saves it.
 */
const w = { whatWorks: [], contextWindow: 1 };
const CATALOG: ModelCatalogView = { groups: [
  { provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], ...w }] },
  { provider: "openai", label: "OpenAI", models: [{ ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", badges: ["supported"], ...w }] },
] };
const picks = (two: boolean): ModelPicksView => ({
  keys: { anthropic: [{ id: "k1", label: "Anthropic", isDefault: true }], openai: two ? [{ id: "k1", label: "Personal", isDefault: true }, { id: "kwork", label: "Work", isDefault: false }] : [{ id: "k1", label: "Personal", isDefault: true }] },
  recent: [], inUse: [], newBotModel: "openai:gpt-6.1-sol",
});
const preview: TemplatePreview = { token: "tk", name: "Trip Desk", description: "Plans trips.", facts: [], playbooks: [], jobs: [], apps: [], thirdParty: false };
const bot = botFixture("new", "Tutor");
let bridge: ReturnType<typeof installFakeBridge>;
const setup = (two: boolean) => {
  bridge = installFakeBridge({
    getModelPicks: picks(two), getModelCatalog: CATALOG, createAgent: { id: "new" }, importTemplate: { id: "new" }, previewTemplateImport: { token: "tk" },
    pickAgentModel: { agent: bot }, openAgent: { agent: bot }, getAgentTranscriptTail: { entries: [] }, completeOnboarding: {}, updateAgent: { agent: bot },
    listStarterTemplates: { starters: [] }, getOnboarding: { hasSeenOnboarding: false, tokenConfigured: true },
  });
};
beforeEach(() => { useUi.setState({ ...initialState(), bots: {} } as never); useModelCatalog.setState({ view: CATALOG, load: async () => {} }); });
afterEach(() => { cleanup(); useTemplates.setState({ sheet: null, afterAdd: null }); useModelCatalog.setState({ view: null }); });

/** Each way a Bot is made, and the button that makes it. */
const PATHS: { name: string; mount(): void; create(): void }[] = [
  { name: "New chat → Create Bot", mount: () => render(<NewChat />), create: () => fireEvent.click(screen.getByRole("option", { name: /Create new Bot/ })) },
  { name: "the first Bot in onboarding", mount: () => render(<Onboarding onDone={() => {}} initialStep="new-bot" />), create: () => fireEvent.click(screen.getByRole("button", { name: "Get started" })) },
  { name: "a starter, template or shared Bot (the import sheet)", mount: () => { useTemplates.setState({ sheet: { kind: "import", preview } }); render(<ImportSheet />); }, create: () => fireEvent.click(screen.getByRole("button", { name: /Add/ })) },
];

describe.each(PATHS)("creating a Bot: $name", ({ mount, create }) => {
  it("with one key: the model shows, no key choice, nothing extra saved", async () => {
    setup(false);
    mount();
    const step = await screen.findByRole("group", { name: "Model" });
    expect(within(step).getByRole("button", { name: /Model: GPT-6\.1 Sol/ })).toBeTruthy();
    expect(within(step).queryByRole("radiogroup")).toBeNull();
    create();
    await waitFor(() => expect(bridge.calls.some(([c]) => c === "createAgent" || c === "importTemplate")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.calls.some(([c]) => c === "pickAgentModel")).toBe(false);
  });

  it("with two keys: a key choice with the default preselected; the owner's pick is saved to the new Bot", async () => {
    setup(true);
    mount();
    const step = await screen.findByRole("group", { name: "Model" });
    const keys = await within(step).findByRole("radiogroup");
    expect(within(keys).getByRole("radio", { name: "Personal" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(keys).getByRole("radio", { name: "Work" }));
    create();
    await waitFor(() => expect(bridge.calls).toContainEqual(["pickAgentModel", { id: "new", model: "openai:gpt-6.1-sol", keyId: "kwork" }]));
  });
});

describe("the model choice while creating", () => {
  it("the compact picker opens from the Model row; picking a Claude model drops the key row", async () => {
    setup(true);
    render(<NewChat />);
    const step = await screen.findByRole("group", { name: "Model" });
    await within(step).findByRole("radiogroup");
    fireEvent.click(within(step).getByRole("button", { name: /Model:/ }));
    fireEvent.click(within(step).getByRole("option", { name: "All models…" }));
    fireEvent.click(within(step).getByRole("option", { name: "Sonnet 5" }));
    await waitFor(() => expect(within(step).getByRole("button", { name: "Model: Sonnet 5" })).toBeTruthy());
    expect(within(step).queryByRole("radiogroup")).toBeNull();
  });
});
