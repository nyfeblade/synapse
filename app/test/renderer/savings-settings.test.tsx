// @vitest-environment jsdom
// saving-settings: "put all of those saving options as options, settings" — Settings → Usage → Savings.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, STR5 } from "@synapse/shared";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useUsage } from "../../src/renderer/usage/store";
import { installBridge, settings, usageView } from "./settings-fixtures";

const savings = { days: 7, cacheTtl5m: 7.7, callFast: 1.2, callMatch: 6.3, longContextWhenNeeded: -0.4 };
let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useUi.setState({ ...initialState(), settings: settings({ rev: 1 }) });
  useUsage.setState({ view: { ...usageView, savings }, error: null });
});
afterEach(cleanup);

const group = () => screen.getByRole("region", { name: STR5.savings });
const checked = (name: string) => within(screen.getByRole("radiogroup", { name })).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);

describe("Settings → Usage → Savings", () => {
  it("renders the three settings at today's behaviour, each with its measured weekly figure", () => {
    render(<UsageSection />);
    const g = group();
    expect(within(g).getByRole("heading", { name: STR5.savings })).toBeTruthy();
    expect(checked(STR5.keepConversationsReady)).toEqual([STR5.cacheTtl1h]);
    expect((screen.getByRole("combobox", { name: STR5.callReplies }) as HTMLSelectElement).value).toBe("default");
    expect(checked(STR5.longContextModel)).toEqual([STR5.longContextOn]);
    expect(g.textContent).toContain("5 minutes ≈ $8/week less at your usage");
    expect(g.textContent).toContain("Fast on the whole call ≈ $1/week less · Match the Bot ≈ $6/week less at your usage");
    expect(g.textContent).toContain("Only when needed ≈ $0/week at your usage");
  });

  it("shows no figure while the week's estimate isn't there (never a made-up $0)", () => {
    useUsage.setState({ view: { ...usageView } });
    render(<UsageSection />);
    expect(group().textContent).not.toContain("/week");
  });

  it("while the saved values are loading, each is a neutral placeholder, not a default choice", () => {
    useUi.setState({ settings: null });
    render(<UsageSection />);
    expect(screen.queryByRole("radiogroup", { name: STR5.keepConversationsReady })).toBeNull();
    expect(screen.queryByRole("combobox", { name: STR5.callReplies })).toBeNull();
    expect(screen.getByRole("status", { name: STR5.keepConversationsReady })).toBeTruthy();
    expect(screen.getByRole("status", { name: STR5.callReplies })).toBeTruthy();
    expect(screen.getByRole("status", { name: STR5.longContextModel })).toBeTruthy();
  });

  it("saves each choice through setHostSettings", async () => {
    h.gateway = (cmd, args) => (cmd === "setHostSettings" ? settings({ ...useUi.getState().settings, ...args, rev: (useUi.getState().settings?.rev ?? 0) + 1 }) : cmd === "getUsage" ? { ...usageView, savings } : {});
    render(<UsageSection />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: STR5.keepConversationsReady })).getByRole("radio", { name: STR5.cacheTtl5m }));
    await waitFor(() => expect(h.calls).toContainEqual(["setHostSettings", { promptCacheTtl: "5m" }]));
    await waitFor(() => expect(checked(STR5.keepConversationsReady)).toEqual([STR5.cacheTtl5m]));
    fireEvent.change(screen.getByRole("combobox", { name: STR5.callReplies }), { target: { value: "fast" } });
    await waitFor(() => expect(h.calls).toContainEqual(["setHostSettings", { callReplies: "fast" }]));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: STR5.longContextModel })).getByRole("radio", { name: STR5.longContextWhenNeeded }));
    await waitFor(() => expect(h.calls).toContainEqual(["setHostSettings", { longContext: "when-needed" }]));
    expect(useUi.getState().settings).toMatchObject({ promptCacheTtl: "5m", callReplies: "fast", longContext: "when-needed" });
  });

  it("a save that fails goes back to the saved choice and says so", async () => {
    h.gateway = (cmd) => (cmd === "setHostSettings" ? new Error("disk full") : cmd === "getUsage" ? { ...usageView, savings } : {});
    render(<UsageSection />);
    fireEvent.change(screen.getByRole("combobox", { name: STR5.callReplies }), { target: { value: "match" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(STR.settingNotSaved));
    expect((screen.getByRole("combobox", { name: STR5.callReplies }) as HTMLSelectElement).value).toBe("default");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: STR5.keepConversationsReady })).getByRole("radio", { name: STR5.cacheTtl5m }));
    await waitFor(() => expect(checked(STR5.keepConversationsReady)).toEqual([STR5.cacheTtl1h]));
  });

  it("restores what the host has saved, and follows a later change from the host", () => {
    useUi.setState({ settings: settings({ promptCacheTtl: "5m", callReplies: "match", longContext: "when-needed", rev: 3 }) });
    render(<UsageSection />);
    expect(checked(STR5.keepConversationsReady)).toEqual([STR5.cacheTtl5m]);
    expect((screen.getByRole("combobox", { name: STR5.callReplies }) as HTMLSelectElement).value).toBe("match");
    expect(checked(STR5.longContextModel)).toEqual([STR5.longContextWhenNeeded]);
    act(() => useUi.getState().apply({ channel: "host-settings", payload: settings({ promptCacheTtl: "1h", callReplies: "fast", longContext: "on", rev: 4 }) } as never));
    expect(checked(STR5.keepConversationsReady)).toEqual([STR5.cacheTtl1h]);
    expect((screen.getByRole("combobox", { name: STR5.callReplies }) as HTMLSelectElement).value).toBe("fast");
  });
});
