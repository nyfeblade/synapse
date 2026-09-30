// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINEERING_MODE_EXTRA_TOKENS, type BotSummary } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
import "../../src/renderer/components/UpdatesSection"; // registers Settings → Updates (Phase 5 registry, as main.tsx does)
import { initialState } from "../../src/renderer/reducer";
import { safetyFixture } from "./fake-bridge";
import { useUi } from "../../src/renderer/store";

const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "Inbox zero.", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
  lastBotMessageAt: 0,
};
const calls: [string, Record<string, unknown>][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      // FollowupsToggle's, GoogleToggle's, GitHubRow's, BrowserRow's, MacAppRow's and the Composio row's mount-time reads; not under test here
      if (cmd !== "getModelAccess" && cmd !== "getModelCatalog" && cmd !== "getModelPicks" && cmd !== "getSafetyReviewer" && cmd !== "getPhase5Settings" && cmd !== "getGoogleStatus" && cmd !== "getGitHubStatus" && cmd !== "getLocalBrowserAllowed" && cmd !== "getLocalMacAppAllowed" && cmd !== "getLocalDryRun" && cmd !== "getComposioStatus" && cmd !== "getSafety" && cmd !== "listMacActions") calls.push([cmd, args]);
      if (cmd === "setHostSettings") return { ok: true, result: { ...useUi.getState().settings, ...args } };
      return { ok: true, result: { agent: bot } };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    secrets: { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn() },
  };
  useUi.setState({ ...initialState(), bots: { a: bot }, settings: { autoReviewEnabled: true, allowInstructions: ["Use the Bash tool to run the test suite"], blockInstructions: [], userTimeZone: "America/New_York", userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false } });
});
afterEach(cleanup);

describe("Bot settings panel (SET-15, BOT-25, BOT-18)", () => {
  it("saves name and description on blur and the model from the dropdown", async () => {
    render(<BotSettingsPanel botId="a" />);
    const name = screen.getByLabelText("Bot name");
    fireEvent.change(name, { target: { value: "Courier 2" } });
    fireEvent.blur(name);
    fireEvent.click(screen.getByRole("button", { name: "Model: Sonnet 5" }));
    fireEvent.click(screen.getByRole("option", { name: "Opus 5" }));
    await vi.waitFor(() => expect(calls).toEqual([["updateAgent", { id: "a", name: "Courier 2" }], ["updateAgent", { id: "a", model: "claude-opus-5" }]]));
  });

  it("one Engine control: inside the model picker beside Claude models, none as a separate field", async () => {
    const { useModelCatalog } = await import("../../src/renderer/model-catalog");
    useModelCatalog.setState({ view: { groups: [{ provider: "anthropic", label: "Anthropic", models: [{ ref: "claude-sonnet-5", label: "Sonnet 5", badges: [], whatWorks: [], contextWindow: 1 }] }] }, load: async () => {} });
    try {
      render(<BotSettingsPanel botId="a" />);
      expect(document.querySelector('[data-setting="engine"]')).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Model: Sonnet 5" }));
      const engine = screen.getByRole("radiogroup", { name: "Engine" });
      expect(screen.getAllByRole("radiogroup", { name: "Engine" })).toHaveLength(1);
      fireEvent.click(within(engine).getByRole("radio", { name: "Synapse (Experimental)" }));
      await vi.waitFor(() => expect(calls).toContainEqual(["updateAgent", { id: "a", engine: "synapse" }]));
    } finally { useModelCatalog.setState({ view: null }); }
  });

  it("edits the avatar through the editor; Set avatar stays disabled until something changes", async () => {
    render(<BotSettingsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
    const set = screen.getByRole("button", { name: "Set avatar" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    // The six Synapse forms, the pebble first — and no material or motion pickers any more.
    expect(screen.getAllByRole("button", { name: / shape$/ }).map((x) => x.getAttribute("aria-label"))).toEqual(
      ["Pebble shape", "Orb shape", "Tile shape", "Pill shape", "Dome shape", "Gem shape"]);
    expect(screen.queryByRole("group", { name: "Material" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Motion" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Gem shape" }));
    fireEvent.click(screen.getByRole("button", { name: "Teal" }));
    fireEvent.click(set);
    await vi.waitFor(() => expect(calls[0]).toEqual(["updateAgent", { id: "a", avatarShape: "gem", avatarColor: "#4ba495" }]));
  });

  it("shows a visible error when saving a rename fails, without an unhandled rejection", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd !== "getPhase5Settings") calls.push([cmd, args]);
      if (cmd === "updateAgent") return { ok: false, error: { code: "GATEWAY_ERROR", message: "Couldn't reach the computer" } };
      return { ok: true, result: { agent: bot } };
    });
    render(<BotSettingsPanel botId="a" />);
    const name = screen.getByLabelText("Bot name");
    fireEvent.change(name, { target: { value: "Courier 2" } });
    fireEvent.blur(name);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't reach the computer");
  });

  it("Engineering mode calls setAgentEngineeringMode and says what it loads and what it costs", async () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never }); // new-user walk finding 8: advanced controls
    render(<BotSettingsPanel botId="a" />);
    const n = ENGINEERING_MODE_EXTRA_TOKENS.toLocaleString("en-US");
    // UI polish pass: the cost is a quiet value beside the switch (real data), not a sentence under it.
    expect(screen.getByText(`+${n} tokens`)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Engineering mode" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setAgentEngineeringMode", { id: "a", enabled: true }]));
  });

  it("Permission mode selects a per-Bot mode and warns on Full auto (feat-mac-access-parity)", async () => {
    render(<BotSettingsPanel botId="a" />);
    const select = screen.getByRole("combobox", { name: "Permission mode" }) as HTMLSelectElement;
    expect(select.value).toBe("ask"); // default
    expect(screen.queryByText(/without asking, except the always-ask and never lists/i)).toBeNull();
    fireEvent.change(select, { target: { value: "full-auto" } });
    await vi.waitFor(() => expect(calls).toContainEqual(["setAgentPermMode", { id: "a", mode: "full-auto" }]));
  });

  // full-auto-quiet: under the Full auto option, one short factual line naming what still asks.
  it("shows the Full-auto warning when the Bot is already in Full auto, naming what still asks", () => {
    useUi.setState({ bots: { a: { ...bot, settings: { ...bot.settings, permMode: "full-auto" } } } });
    render(<BotSettingsPanel botId="a" />);
    const line = screen.getByText(/without asking\./i);
    expect(line).toBeTruthy();
    for (const word of [/delet/i, /send/i, /spend|money/i, /security|access/i]) expect(line.textContent).toMatch(word);
  });
});

// Traceability T1 (gate §4): six sections, General current; sections this file never registers stay
// disabled; Account is live via SettingsModal.tsx's own registration; Close works.
describe("Settings nav and close (T1)", () => {
  it("shows the nav with General current, unregistered sections disabled, and closes", () => {
    useUi.setState({ settingsOpen: true });
    render(<SettingsModal />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector("[aria-current='page']")?.textContent).toBe("General");
    for (const n of ["Voice", "Computer", "Schedules", "System"]) expect((screen.getByRole("button", { name: n }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Account" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(useUi.getState().settingsOpen).toBe(false);
  });
});

describe("Settings → Rules (was Auto-review; SET-05, SET-06, safety v2)", () => {
  it("toggles Auto-review, compiles a rule in plain English, adds it, and deletes a reviewer rule", async () => {
    const view = safetyFixture();
    const added = { ...view, rules: [...view.rules, { id: "rule-1", type: "ask" as const, text: "Ask me before anything over $50", kinds: ["pay" as const], scope: {}, limits: { overAmount: 50 }, except: [], source: "owner" as const, enabled: true, createdAt: 1, words: ["Ask first", "Payments", "over $50"] }] };
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      if (!cmd.startsWith("get") && cmd !== "listMacActions") calls.push([cmd, args]);
      if (cmd === "setHostSettings") return { ok: true, result: { ...useUi.getState().settings, ...args } };
      if (cmd === "getSafety") return { ok: true, result: view };
      if (cmd === "compileSafetyRule") return { ok: true, result: { ok: true, type: "ask", words: ["Ask first", "Payments", "over $50"], preview: { changed: 2, of: 40, examples: [] }, conflicts: [] } };
      if (cmd === "addSafetyRule") return { ok: true, result: added };
      return { ok: true, result: {} };
    });
    useUi.setState({ settingsFocus: "auto-review" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("switch", { name: "Auto-review" }));
    const input = await screen.findByLabelText("Add rule");
    const add = screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Ask me before anything over $50" } });
    await screen.findByText("Would have changed 2 of your last 40 actions");
    expect(screen.getByLabelText("Compiled rule").textContent).toContain("over $50");
    fireEvent.click(add);
    await screen.findByRole("switch", { name: "Rule on: Ask me before anything over $50" });
    fireEvent.click(screen.getByRole("button", { name: "Delete rule: Use the Bash tool to run the test suite" }));
    await vi.waitFor(() => expect(calls).toEqual([
      ["setHostSettings", { autoReviewEnabled: false }],
      ["compileSafetyRule", { text: "Ask me before anything over $50", botId: null }],
      ["addSafetyRule", { text: "Ask me before anything over $50", botId: null, asExceptionTo: null }],
      ["setHostSettings", { allowInstructions: [] }],
    ]));
    expect(screen.queryByText("Your rules are private to you. The built-in safety checks apply no matter what.")).toBeNull(); // UI polish pass: no subtitles
  });
});

// UI polish pass (brief 2): one search field in the Settings chrome finds a preference in any
// section by label or keyword and jumps there; a miss is the shared EmptyView.
describe("Settings search", () => {
  it("finds a row in another section and jumps to it", () => {
    useUi.setState({ settingsOpen: true, settingsFocus: null });
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "api key" } });
    const hit = screen.getByRole("button", { name: /Anthropic API key/ });
    expect(hit.textContent).toContain("Account");
    fireEvent.click(hit);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector("[aria-current='page']")?.textContent).toBe("Account");
    expect((screen.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement).value).toBe("");
  });

  it("a miss says so, with no subtitle", () => {
    useUi.setState({ settingsOpen: true, settingsFocus: null });
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "zzzz" } });
    expect(screen.getByRole("status").textContent).toBe("No matching settings");
  });
});
