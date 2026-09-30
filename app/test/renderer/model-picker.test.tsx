// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogView, ModelPicksView, SafetyReviewerView } from "@synapse/shared";
import { ModelPicker, ModelPickerList } from "../../src/renderer/components/ModelPicker";
import { SafetyReviewerBlock } from "../../src/renderer/components/settings/SafetyReviewerBlock";

const VIEW: ModelCatalogView = { groups: [
  { provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], whatWorks: [], contextWindow: 200_000 }] },
  { provider: "openai", label: "OpenAI", models: [
    { ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", badges: ["supported"], contextWindow: 1_050_000, whatWorks: [{ label: "Tools and replies", state: "yes" }, { label: "Auto-review", state: "asks" }, { label: "Coding agents", state: "no" }] },
    { ref: "openai:gpt-6-astra", label: "GPT-6 Astra", badges: ["unchecked"], contextWindow: 1_050_000, whatWorks: [{ label: "Tools and replies", state: "unchecked" }] },
  ] },
  { provider: "ollama", label: "Ollama", models: [{ ref: "ollama:qwen3:4b", label: "qwen3:4b", badges: ["experimental", "local"], contextWindow: 32_768, whatWorks: [] }] },
] };
const calls: [string, unknown][] = [];
let safety: SafetyReviewerView;
beforeEach(() => {
  calls.length = 0;
  safety = { ref: "openai:gpt-6-luna", onClaude: false, qualified: false, checkedAt: null, reasons: [], state: "not-checked", chosen: null, choices: [{ ref: null, label: "Default" }, { ref: "openai:gpt-6-luna", label: "GPT-6 Luna · OpenAI" }, { ref: "gemini:gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite · Gemini" }] };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: { model?: string; ref?: string | null }) => {
      calls.push([c, a]);
      if (c === "getCostPreview") return { ok: true, result: { model: a.model, usdPer100: a.model?.startsWith("ollama") ? 0 : 1.25, turns: 12 } };
      if (c === "getSafetyReviewer") return { ok: true, result: safety };
      if (c === "setSafetyReviewer") { safety = { ...safety, chosen: a.ref ?? null, ref: a.ref ?? safety.ref }; return { ok: true, result: safety }; }
      if (c === "runSafetyCheck") { safety = { ...safety, job: { id: "j1", done: 0, total: 345 } }; return { ok: true, result: safety }; }
      if (c === "cancelSafetyCheck") { safety = { ...safety, job: null }; return { ok: true, result: safety }; }
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {},
  };
});
afterEach(cleanup);

describe("the grouped model picker (spec §10)", () => {
  it("groups by provider with badges from evidence; Claude models carry none", () => {
    render(<ModelPickerList view={VIEW} current="openai:gpt-6.1-sol" botId="b1" onPick={() => {}} />);
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Anthropic", "OpenAI", "Ollama"]);
    expect(screen.getByRole("option", { name: "Sonnet 5" }).textContent).toBe("Sonnet 5");
    expect(screen.getByRole("option", { name: /GPT-6 Astra/ }).textContent).toBe("GPT-6 AstraNot checked");
    expect(screen.getByRole("option", { name: /qwen3/ }).textContent).toBe("qwen3:4bExperimentalLocal");
    expect(screen.getByRole("option", { name: /GPT-6.1 Sol/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows What works and the cost of 100 turns for the model under the pointer, and picks on click", async () => {
    const onPick = vi.fn();
    render(<ModelPickerList view={VIEW} current="openai:gpt-6.1-sol" botId="b1" onPick={onPick} />);
    const details = screen.getByRole("region", { name: "GPT-6.1 Sol: what works" });
    expect(within(details).getByText("Asks you")).toBeTruthy();
    await waitFor(() => expect(within(details).getByText("≈ $1.25")).toBeTruthy());
    fireEvent.mouseEnter(screen.getByRole("option", { name: /qwen3/ }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "qwen3:4b: what works" })).getByText("Free")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /GPT-6 Astra/ }));
    expect(onPick).toHaveBeenCalledWith("openai:gpt-6-astra");
    expect(calls.filter(([c]) => c === "getCostPreview").map(([, a]) => (a as { model: string }).model)).toEqual(["openai:gpt-6.1-sol", "ollama:qwen3:4b"]);
  });
});

describe("OpenRouter's live list in the picker", () => {
  // A fake live list: 150 models (OpenRouter lists hundreds), plus the one this Bot uses.
  const many = Array.from({ length: 150 }, (_, i) => ({ ref: `openrouter:maker/m-${i}`, label: `Maker: Model ${i}`, badges: ["unchecked" as const], whatWorks: [], contextWindow: 128_000, price: { input: i === 7 ? 0.0005 : 3, output: 15 }, liveOnly: true as const }));
  const OR: ModelCatalogView = { groups: [{ provider: "openrouter", label: "OpenRouter", searchable: true, models: [
    { ref: "openrouter:other/used", label: "Other: Used", badges: ["unchecked"], whatWorks: [], contextWindow: 128_000, price: { input: 0.1, output: 0.4 } }, ...many,
  ] }] };

  it("one search box, prices from the live list, Not checked badges, and a capped list until searched", async () => {
    const onPick = vi.fn();
    render(<ModelPickerList view={OR} current="openrouter:maker/m-149" botId="b1" onPick={onPick} />);
    const box = screen.getByRole("combobox", { name: "Search models" });
    // 60 rows, plus the current model kept in view past the cap.
    expect(screen.getAllByRole("option")).toHaveLength(61);
    expect(screen.getByText("61 of 151")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Other: Used/ }).textContent).toBe("Other: Used$0.10 / $0.40Not checked");
    fireEvent.change(box, { target: { value: "model 7" } });
    // The name as typed first (7, 70–79), then every other row holding both words.
    expect(screen.getAllByRole("option").slice(0, 11).map((o) => o.textContent)).toEqual([
      "Maker: Model 7$0.00050 / $15.00Not checked", ...[70, 71, 72, 73, 74, 75, 76, 77, 78, 79].map((i) => `Maker: Model ${i}$3.00 / $15.00Not checked`),
    ]);
    fireEvent.mouseEnter(screen.getByRole("option", { name: /Model 7\$/ }));
    expect(within(screen.getByRole("region", { name: /what works/ })).getByText("$0.00050 in · $15.00 out")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Model 7\$/ }));
    expect(onPick).toHaveBeenCalledWith("openrouter:maker/m-7");
    fireEvent.change(box, { target: { value: "nothing like this" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});

describe("0.1.7: one searchable list across providers and keys", () => {
  const w = { whatWorks: [], contextWindow: 128_000 };
  const ALL: ModelCatalogView = { groups: [
    { provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], ...w }, { ref: "claude-opus-5-5", label: "Opus 5.5", badges: [], ...w }] },
    { provider: "openai", label: "OpenAI", models: [{ ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", badges: ["supported"], ...w }, { ref: "openai:gpt-6-luna", label: "GPT-6 Luna", badges: ["unchecked"], ...w }] },
    { provider: "gemini", label: "Gemini", models: [{ ref: "gemini:gemini-3.5-flash", label: "Gemini 3.5 Flash", badges: ["experimental"], ...w }] },
    { provider: "ollama", label: "Ollama", models: [{ ref: "ollama:qwen3:4b", label: "qwen3:4b", badges: ["local"], ...w }] },
  ] };
  const PICKS: ModelPicksView = {
    keys: { anthropic: [{ id: "k1", label: "Anthropic", isDefault: true }], openai: [{ id: "k1", label: "Personal", isDefault: true }, { id: "kwork", label: "Work", isDefault: false }], gemini: [{ id: "k1", label: "Gemini", isDefault: true }] },
    recent: [{ ref: "openai:gpt-6.1-sol", keyId: "kwork", at: 30, mine: true }, { ref: "claude-opus-5-5[1m]", keyId: "k1", at: 20, mine: false }, { ref: "openai:gone-model", keyId: null, at: 10, mine: true }],
    inUse: [],
  };

  it("lists a model once per key where a provider has two, with the key's label; Recent on top", () => {
    render(<ModelPicker view={ALL} picks={PICKS} current={{ ref: "openai:gpt-6.1-sol", keyId: "kwork" }} botId="b1" onPick={() => {}} />);
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Recent", "Anthropic", "OpenAI", "Gemini", "Ollama"]);
    const recent = screen.getByRole("group", { name: "Recent" });
    // A dated or long-context id lands on its model; a model no longer offered is left out.
    expect(within(recent).getAllByRole("option").map((o) => o.getAttribute("aria-label") ?? o.textContent)).toEqual(["GPT-6.1 Sol · Work", "Opus 5.5"]);
    const openai = screen.getByRole("group", { name: "OpenAI" });
    expect(within(openai).getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["GPT-6.1 Sol · Personal", "GPT-6.1 Sol · Work", "GPT-6 Luna · Personal", "GPT-6 Luna · Work"]);
    // Only the Work row of GPT-6.1 Sol is the current choice (in Recent and in its group).
    expect(screen.getAllByRole("option", { selected: true }).map((o) => o.getAttribute("aria-label"))).toEqual(["GPT-6.1 Sol · Work", "GPT-6.1 Sol · Work"]);
    // One key: no label beside the model.
    expect(within(screen.getByRole("group", { name: "Gemini" })).getByRole("option").textContent).toBe("Gemini 3.5 FlashExperimental");
  });

  it("type to search across providers and key labels; arrows and Enter pick the model and its key", () => {
    const onPick = vi.fn();
    render(<ModelPicker view={ALL} picks={PICKS} current={{ ref: "claude-sonnet-5", keyId: null }} botId="b1" onPick={onPick} />);
    const box = screen.getByRole("combobox", { name: "Search models" });
    expect(document.activeElement).toBe(box); // typing searches at once
    fireEvent.change(box, { target: { value: "work" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["GPT-6.1 Sol · Work", "GPT-6 Luna · Work"]);
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
    fireEvent.change(box, { target: { value: "luna work" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["GPT-6 Luna · Work"]);
    fireEvent.change(box, { target: { value: "gpt" } });
    // The first match is active; arrows move it (aria-activedescendant follows) and Enter picks.
    const active = () => document.getElementById(box.getAttribute("aria-activedescendant")!)!.getAttribute("aria-label");
    expect(active()).toBe("GPT-6.1 Sol · Personal");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(active()).toBe("GPT-6 Luna · Personal");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("openai:gpt-6.1-sol", "kwork");
  });

  it("badges are quiet labels: a Blocked or Not checked model can still be picked", () => {
    const onPick = vi.fn();
    const view: ModelCatalogView = { groups: [{ provider: "openai", label: "OpenAI", models: [{ ref: "openai:gpt-x", label: "GPT X", badges: ["blocked"], whatWorks: [], contextWindow: 1 }] }] };
    render(<ModelPicker view={view} picks={null} current={{ ref: "claude-sonnet-5", keyId: null }} botId="b1" onPick={onPick} />);
    const row = screen.getByRole("option", { name: /GPT X/ });
    expect(row.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith("openai:gpt-x", null);
  });

  it("the Engine hook shows beside Claude models only, when Bot settings passes it", () => {
    const onChange = vi.fn();
    const engine = { value: "synapse", options: [{ id: "synapse", label: "Synapse" }, { id: "claude-code", label: "Claude Code" }], onChange };
    render(<ModelPicker view={ALL} picks={PICKS} current={{ ref: "claude-sonnet-5", keyId: null }} botId="b1" onPick={() => {}} engine={engine} />);
    const group = screen.getByRole("radiogroup", { name: "Engine" });
    fireEvent.click(within(group).getByRole("radio", { name: "Claude Code" }));
    expect(onChange).toHaveBeenCalledWith("claude-code");
    fireEvent.mouseEnter(screen.getByRole("option", { name: "GPT-6 Luna · Work" }));
    expect(screen.queryByRole("radiogroup", { name: "Engine" })).toBeNull();
  });

  it("compact: recent and in-use models, then All models… opens the full list in place", () => {
    const onPick = vi.fn();
    render(<ModelPicker compact view={ALL} picks={{ ...PICKS, inUse: [{ ref: "gemini:gemini-3.5-flash", keyId: null }, { ref: "ollama:qwen3:4b", keyId: null }] }}
      current={{ ref: "claude-sonnet-5", keyId: null }} botId="b1" onPick={onPick} />);
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label") ?? o.textContent)).toEqual(
      ["GPT-6.1 Sol · Work", "Opus 5.5", "Sonnet 5", "Gemini 3.5 FlashExperimental", "qwen3:4bLocal", "All models…"]);
    expect(screen.queryByRole("region", { name: /what works/ })).toBeNull(); // compact: no details
    const box = screen.getByRole("combobox", { name: "Search models" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" }); // All models…
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Recent", "Anthropic", "OpenAI", "Gemini", "Ollama"]);
    expect(onPick).not.toHaveBeenCalled();
    // Typing in the compact form searches every model.
    fireEvent.change(box, { target: { value: "flash" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("gemini:gemini-3.5-flash", null);
  });
});

describe("the safety reviewer block (spec §7a)", () => {
  it("shows the model, its state, lets the user pick and run the check", async () => {
    render(<SafetyReviewerBlock />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Not checked");
    const select = screen.getByLabelText("Reviewer model") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default (GPT-6 Luna · OpenAI)", "GPT-6 Luna · OpenAI", "Gemini 3.5 Flash-Lite · Gemini"]);
    fireEvent.change(select, { target: { value: "gemini:gemini-3.5-flash-lite" } });
    await waitFor(() => expect(calls).toContainEqual(["setSafetyReviewer", { ref: "gemini:gemini-3.5-flash-lite" }]));
    fireEvent.click(screen.getByRole("button", { name: "Run safety check" }));
    // Background: the button gives way to quiet progress and Cancel.
    await waitFor(() => expect(screen.getByRole("progressbar").textContent).toBe("0 of 345"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run safety check" })).toBeTruthy());
    expect(calls.map(([c]) => c)).toContain("cancelSafetyCheck");
  });

  it("stays out of the way on Claude alone", async () => {
    safety = { ref: null, onClaude: true, qualified: true, checkedAt: null, reasons: [], state: "qualified", chosen: null, choices: [{ ref: null, label: "Default" }] };
    const { container } = render(<SafetyReviewerBlock />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
