// @vitest-environment jsdom
// Bug 258 item 4: "No limits", a per-Bot mode above Full auto, opt-in only. Choosing it opens one confirm that says
// what it removes and the risk; only the confirm sends it (with the confirm token the Mac requires). Switching back is
// one click. The header's subline shows "No limits".
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_LIMITS_CONFIRM, STR5, type BotSummary } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { headerSubline } from "../../src/renderer/components/ChatView";
import { ConfirmHost } from "../../src/renderer/components/ConfirmDialog";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { bot, installBridge, settings } from "./settings-fixtures";

let h: ReturnType<typeof installBridge>;
const withMode = (permMode: "ask" | "full-auto", noLimits = false): BotSummary => ({ ...bot, settings: { ...bot.settings, permMode, ...(noLimits ? { noLimits: true } : {}) } } as BotSummary);
beforeEach(() => {
  h = installBridge();
  h.gateway = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "getLocalBotMode") return { mode: "full-auto" };
    if (cmd === "setAgentNoLimits") return { agent: withMode("full-auto", args.enabled === true) };
    if (cmd === "setAgentPermMode") return { agent: withMode(args.mode as "ask") };
    return {};
  };
  useUi.setState({ ...initialState(), bots: { a: withMode("full-auto") }, settings: settings({}) });
});
afterEach(cleanup);

const select = () => screen.getByRole("combobox", { name: STR5.permMode }) as HTMLSelectElement;

describe("No limits in Bot settings", () => {
  it("is an option, never the default", () => {
    render(<BotSettingsPanel botId="a" />);
    expect([...select().options].map((o) => o.textContent)).toContain(STR5.permModeNoLimits);
    expect(select().value).toBe("full-auto");
  });

  it("choosing it asks first, with the risk sentence; Cancel sends nothing", async () => {
    render(<><BotSettingsPanel botId="a" /><ConfirmHost /></>);
    fireEvent.change(select(), { target: { value: "no-limits" } });
    expect(await screen.findByText(STR5.noLimitsConfirmLine)).toBeTruthy();
    expect(STR5.noLimitsConfirmLine).toMatch(/tricked by content it reads could access private files or send data out without asking/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.filter(([c]) => c === "setAgentNoLimits" || c === "setAgentPermMode")).toEqual([]);
  });

  it("confirming sends it with the confirm token, and the select shows No limits", async () => {
    render(<><BotSettingsPanel botId="a" /><ConfirmHost /></>);
    fireEvent.change(select(), { target: { value: "no-limits" } });
    fireEvent.click(await screen.findByRole("button", { name: STR5.noLimitsConfirmVerb }));
    await vi.waitFor(() => expect(h.calls).toContainEqual(["setAgentNoLimits", { id: "a", enabled: true, confirm: NO_LIMITS_CONFIRM }]));
    await vi.waitFor(() => expect(select().value).toBe("no-limits"));
  });

  it("switching back is one click (no confirm)", async () => {
    useUi.setState({ bots: { a: withMode("full-auto", true) } });
    render(<><BotSettingsPanel botId="a" /><ConfirmHost /></>);
    expect(select().value).toBe("no-limits");
    fireEvent.change(select(), { target: { value: "full-auto" } });
    await vi.waitFor(() => expect(h.calls).toContainEqual(["setAgentPermMode", { id: "a", mode: "full-auto" }]));
    expect(screen.queryByText(STR5.noLimitsConfirmLine)).toBeNull();
  });

  it("shows a label, not an explanatory subtitle", () => {
    useUi.setState({ bots: { a: withMode("full-auto", true) } });
    render(<BotSettingsPanel botId="a" />);
    expect(screen.queryByText(STR5.permModeFullAutoHelp)).toBeNull();
    expect(screen.queryByText(STR5.permModeFullAutoWarning)).toBeNull();
  });
});

describe("the header", () => {
  it("shows No limits in the subline", () => {
    expect(headerSubline(withMode("full-auto", true), {})).toContain(STR5.permModeNoLimits);
    expect(headerSubline(withMode("full-auto"), {})).toContain(STR5.permModeFullAuto);
    expect(headerSubline(withMode("full-auto"), {})).not.toContain(STR5.permModeNoLimits);
  });
});
