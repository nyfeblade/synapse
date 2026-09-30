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

const RULE_FIELD = /When a Bot wants to/;
let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useUi.setState({ ...initialState(), settings: settings() });
});
afterEach(cleanup);

describe("Settings → General → auto-review rules", () => {
  const mount = (over: Partial<HostSettingsView> = {}) => {
    useUi.setState({ settings: settings(over) });
    h.gateway = (cmd, args) => (cmd === "setHostSettings" ? { ...useUi.getState().settings!, ...(args as Partial<HostSettingsView>) } : {});
    return render(<GeneralSection />);
  };

  it("swaps the button to Save Rule and offers a Cancel while a rule is being edited", () => {
    mount({ allowInstructions: ["reply to emails"] });
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(screen.getByRole("button", { name: COPY.saveRule })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: COPY.saveRule })).toBeNull();
    expect((screen.getByLabelText(RULE_FIELD) as HTMLInputElement).value).toBe("");
  });

  it("leaves edit mode on Escape", () => {
    mount({ allowInstructions: ["reply to emails"] });
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(screen.getByRole("button", { name: COPY.saveRule })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText(RULE_FIELD), { key: "Escape" });
    expect(screen.queryByRole("button", { name: COPY.saveRule })).toBeNull();
    expect(screen.getByRole("button", { name: COPY.addRule })).toBeTruthy();
  });

  it("edits the rule the pencil was clicked on even after another rule is deleted", async () => {
    mount({ allowInstructions: ["one", "two", "three"] });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit rule" })[2]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete rule" })[0]!);
    await waitFor(() => expect(useUi.getState().settings!.allowInstructions).toEqual(["two", "three"]));
    fireEvent.change(screen.getByLabelText(RULE_FIELD), { target: { value: "three edited" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.saveRule }));
    await waitFor(() => expect(useUi.getState().settings!.allowInstructions).toEqual(["two", "three edited"]));
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
