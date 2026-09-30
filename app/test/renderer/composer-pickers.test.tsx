// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  bridge = installFakeBridge({ updateAgent: { agent: bot }, setAgentPermMode: { agent: bot }, getModelAccess: { models: {} } });
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
    await waitFor(() => expect(bridge.calls).toContainEqual(["updateAgent", { id: "a", model: "claude-opus-5-5" }]));
    expect(useUi.getState().panel).toBe("closed");
  });

  it("with OpenRouter set up, the short menu keeps the models in use and leaves the live list to Bot settings; Claude has no badge", async () => {
    const w = { whatWorks: [], contextWindow: 128_000 };
    useModelCatalog.setState({ view: { groups: [
      { provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], ...w }] },
      { provider: "openrouter", label: "OpenRouter", searchable: true, models: [
        { ref: "openrouter:other/used", label: "Other: Used", badges: ["unchecked"], ...w },
        ...Array.from({ length: 40 }, (_, i) => ({ ref: `openrouter:maker/m-${i}`, label: `Maker ${i}`, badges: ["unchecked" as const], liveOnly: true as const, ...w })),
      ] },
    ] }, load: async () => {} });
    render(<ModelModePills botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Sonnet 5" }));
    const items = screen.getAllByRole("menuitemradio").map((i) => i.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).not.toMatch(/Supported|Not checked/);
    expect(items[1]).toContain("Not checked");
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
