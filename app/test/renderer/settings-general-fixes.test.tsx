// @vitest-environment jsdom
// Hand-testing round, Settings → General's auto-review rules and the modal's focus handling.
// Each test here was written RED against the shipped component before the fix landed.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostSettingsView } from "@synapse/shared";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
import { AutoReviewSection as GeneralSection } from "../../src/renderer/components/settings/GeneralSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { COPY, installBridge, settings } from "./settings-fixtures";
import { safetyFixture } from "./fake-bridge";

let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useUi.setState({ ...initialState(), settings: settings() });
});
afterEach(cleanup);

// Safety v2: Settings → Rules replaced the free-text rule editor. Rules are compiled before they're added.
describe("Settings → Rules", () => {
  const view = safetyFixture();
  const mount = (over: Partial<HostSettingsView> = {}, gw: (cmd: string, args: Record<string, unknown>) => unknown = () => ({})) => {
    useUi.setState({ settings: settings(over) });
    h.gateway = (cmd, args) => (cmd === "setHostSettings" ? { ...useUi.getState().settings!, ...(args as Partial<HostSettingsView>) } : cmd === "getSafety" ? view : gw(cmd, args));
    return render(<GeneralSection />);
  };

  it("a rule that can't be read exactly says why and can't be added", async () => {
    mount({}, (cmd) => (cmd === "compileSafetyRule" ? { ok: false, reason: "I couldn't turn “boss” into an exact rule." } : {}));
    fireEvent.change(await screen.findByLabelText(COPY.addRule), { target: { value: "Ask before emailing my boss" } });
    await screen.findByText("I couldn't turn “boss” into an exact rule.");
    expect((screen.getByRole("button", { name: COPY.addRule }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Escape clears a half-typed rule", async () => {
    mount();
    const field = await screen.findByLabelText(COPY.addRule) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Never send" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
  });

  it("picking a preset shows what changes before it switches", async () => {
    mount({}, (cmd, args) => (cmd === "setSafetyPreset" ? { ...view, preset: args.preview ? "balanced" : "hands-off", diff: { adds: [], removes: ["Sends", "Uploads to unknown sites"], changes: [] } } : {}));
    fireEvent.click(await screen.findByRole("radio", { name: "Hands-off" }));
    const group = await screen.findByRole("group", { name: "Switch to Hands-off" });
    expect(group.textContent).toContain("Stops asking");
    expect(group.textContent).toContain("Sends, Uploads to unknown sites");
    expect(h.calls.filter(([c]) => c === "setSafetyPreset")).toEqual([["setSafetyPreset", { preset: "hands-off", preview: true }]]);
    fireEvent.click(screen.getByRole("button", { name: "Switch to Hands-off" }));
    await waitFor(() => expect(h.calls.filter(([c]) => c === "setSafetyPreset").at(-1)).toEqual(["setSafetyPreset", { preset: "hands-off" }]));
  });

  it("lists the preset rules with their type, and reviewer rules as Checked by Auto-review", async () => {
    mount({ allowInstructions: ["reply to emails"] });
    expect(await screen.findByRole("switch", { name: "Rule on: Sends" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Type of rule: Sends" }) as HTMLSelectElement).value).toBe("ask");
    expect(screen.getAllByText("Checked by Auto-review").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete rule: reply to emails" }));
    await waitFor(() => expect(useUi.getState().settings!.allowInstructions).toEqual([]));
  });
});

describe("Settings modal focus", () => {
  it("moves focus into the dialog so typing never reaches the composer behind the scrim", async () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    render(<SettingsModal />);
    await waitFor(() => expect(document.querySelector(".settings-dialog")!.contains(document.activeElement)).toBe(true));
    outside.remove();
  });

  it("keeps Tab inside the dialog and restores focus when it closes", async () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    const view = render(<SettingsModal />);
    const dialog = document.querySelector<HTMLElement>(".settings-dialog")!;
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    focusable.at(-1)!.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));
    view.unmount();
    await waitFor(() => expect(document.activeElement).toBe(outside));
    outside.remove();
  });
});
