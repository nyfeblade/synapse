// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, STR5 } from "@synapse/shared";
import { ModelModePills } from "../../src/renderer/components/Composer";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useModelCatalog } from "../../src/renderer/model-catalog";
import { botFixture, installFakeBridge } from "./fake-bridge";

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  const bot = { ...botFixture("a", "Scout"), profile: { ...botFixture("a", "Scout").profile, model: "claude-sonnet-5" } };
  bridge = installFakeBridge({ updateAgent: { agent: bot }, pickAgentModel: { agent: bot }, setAgentPermMode: { agent: bot }, getModelAccess: { models: {} } });
  useUi.setState({ ...initialState(), bots: { a: bot }, panel: "closed" } as never);
});
afterEach(cleanup);

describe("new-user walk finding 13: the composer's model and mode chips open a small picker", () => {
  it("the model chip lists the models at the chip and saves a pick, without opening Bot settings", async () => {
    render(<ModelModePills botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Sonnet 5" }));
    const menu = screen.getByRole("menu");
    expect(menu.querySelector('[aria-checked="true"]')?.textContent).toContain("Sonnet 5");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Opus 5\.5/ }));
    await waitFor(() => expect(bridge.calls).toContainEqual(["pickAgentModel", { id: "a", model: "claude-opus-5-5", keyId: null }]));
    expect(useUi.getState().panel).toBe("closed");
  });

  it("with a catalog, the chip opens the compact picker: recent and in-use models, then All models… for the full list", async () => {
    const w = { whatWorks: [], contextWindow: 128_000 };
    useModelCatalog.setState({ view: { groups: [
      { provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], ...w }, { ref: "claude-opus-5", label: "Opus 5", badges: [], ...w }] },
      { provider: "openai", label: "OpenAI", models: [{ ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", badges: ["supported"], ...w }, { ref: "openai:gpt-6-luna", label: "GPT-6 Luna", badges: ["unchecked"], ...w }] },
      { provider: "openrouter", label: "OpenRouter", searchable: true, models: Array.from({ length: 40 }, (_, i) => ({ ref: `openrouter:maker/m-${i}`, label: `Maker ${i}`, badges: ["unchecked" as const], liveOnly: true as const, ...w })) },
    ] }, load: async () => {} });
    const bot = useUi.getState().bots.a!;
    bridge = installFakeBridge({ pickAgentModel: { agent: bot }, getModelAccess: { models: {} }, getModelPicks: { keys: { anthropic: [{ id: "k1", label: "Anthropic", isDefault: true }], openai: [{ id: "k1", label: "Personal", isDefault: true }, { id: "kwork", label: "Work", isDefault: false }] },
      recent: [{ ref: "openai:gpt-6.1-sol", keyId: "kwork", at: 2, mine: true }], inUse: [{ ref: "claude-sonnet-5", keyId: null }, { ref: "openai:gpt-6-luna", keyId: null }] } });
    render(<ModelModePills botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Sonnet 5" }));
    const list = await screen.findByRole("listbox", { name: "Model" });
    await waitFor(() => expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["GPT-6.1 Sol · WorkSupported", "Sonnet 5", "GPT-6 Luna · PersonalNot checked", "All models…"]));
    expect(within(list).getByRole("option", { name: "Sonnet 5" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(list).getByRole("option", { name: "All models…" }));
    await waitFor(() => expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Recent", "Anthropic", "OpenAI", "OpenRouter"]));
    fireEvent.click(within(list).getByRole("option", { name: "GPT-6 Luna · Work" }));
    await waitFor(() => expect(bridge.calls).toContainEqual(["pickAgentModel", { id: "a", model: "openai:gpt-6-luna", keyId: "kwork" }]));
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    useModelCatalog.setState({ view: null });
  });

  it("the mode chip lists Ask / Accept edits / Full auto and saves a pick", async () => {
    render(<ModelModePills botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: STR5.permModeAsk }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: STR5.permModeAcceptEdits }));
    await waitFor(() => expect(bridge.calls).toContainEqual(["setAgentPermMode", { id: "a", mode: "accept-edits" }]));
    expect(useUi.getState().panel).toBe("closed");
  });

  it("Bot settings calls the system prompt Instructions", () => {
    expect(STR.instructions).toBe("Instructions");
  });
});
