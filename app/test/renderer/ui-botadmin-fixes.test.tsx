// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { AvatarEditor } from "../../src/renderer/components/AvatarEditor";
import { BotAvatar } from "../../src/renderer/avatar/BotAvatar";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { GroupSettingsSheet } from "../../src/renderer/components/GroupSettingsSheet";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

const group = (id: string, memberIds: string[], over: Partial<BotSummary> = {}): BotSummary => ({
  ...botFixture(id, "Planner, Scout & Ledger"),
  group: { memberIds },
  ...over,
});

afterEach(cleanup);

describe("Bot settings: the model dropdown can be dismissed (fix-ui-botadmin)", () => {
  beforeEach(() => {
    installFakeBridge({ getPhase5Settings: { followups: false }, getGoogleStatus: { connected: false, enabled: false } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, settings: settingsFixture() });
  });

  it("closes on a mousedown outside the picker, so the next click reaches the row underneath", () => {
    render(<BotSettingsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: /^Model: / }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without changing the model", () => {
    const bridge = installFakeBridge({ getPhase5Settings: { followups: false }, getGoogleStatus: { connected: false, enabled: false } });
    render(<BotSettingsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: /^Model: / }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(bridge.calls.some(([c]) => c === "updateAgent")).toBe(false);
  });
});

describe("Avatar editor: Reset is local, removing a saved photo is its own action (fix-ui-botadmin)", () => {
  const baseProps = { botId: "b1", shape: "pebble" as const, color: "#ffffff", onSave: vi.fn(), onImageSaved: vi.fn(), onCancel: vi.fn() };
  beforeEach(() => { installFakeBridge({ clearAgentAvatar: { agent: botFixture("b1", "Scout") } }); });

  it("Reset does not delete the saved photo on the host", () => {
    const bridge = installFakeBridge({ clearAgentAvatar: { agent: botFixture("b1", "Scout") } });
    render(<AvatarEditor {...baseProps} hasImage={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(bridge.calls.some(([c]) => c === "clearAgentAvatar")).toBe(false);
  });

  it("offers 'Remove photo' only when there is a saved photo, and that is what clears it", async () => {
    const bridge = installFakeBridge({ clearAgentAvatar: { agent: botFixture("b1", "Scout") } });
    const onImageSaved = vi.fn();
    const { unmount } = render(<AvatarEditor {...baseProps} hasImage={false} />);
    expect(screen.queryByRole("button", { name: "Remove photo" })).toBeNull();
    unmount();
    render(<AvatarEditor {...baseProps} hasImage={true} onImageSaved={onImageSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(bridge.calls.some(([c]) => c === "clearAgentAvatar")).toBe(true));
    await waitFor(() => expect(onImageSaved).toHaveBeenCalled());
  });
});

describe("Group settings sheet (fix-ui-botadmin)", () => {
  beforeEach(() => {
    installFakeBridge({});
    useUi.setState({ ...initialState(), bots: { g: group("g", ["p", "s"]), p: botFixture("p", "Planner"), s: botFixture("s", "Scout") }, settings: settingsFixture() });
  });

  it("Escape inside the avatar editor closes only the editor, keeping the typed name", () => {
    const onClose = vi.fn();
    render(<GroupSettingsSheet groupId="g" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Launch crew" } });
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Launch crew");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer a group the shape/colour tab it can never show", () => {
    render(<GroupSettingsSheet groupId="g" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }));
    expect(screen.queryByRole("tab", { name: "Bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gem shape" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Upload" })).toBeTruthy();
  });

  // GroupPanel only ever mounts this sheet while `bots[groupId]` resolves, but the sheet itself stays
  // open across store updates (it's driven by its own local `sheet` state in GroupPanel, not by the
  // bots map), and a real-time delete or removal event could land in that window. It must fold quietly
  // rather than assert past a lookup that's gone stale — same class of bug as the Sidebar fix.
  it("renders nothing instead of crashing if its group disappears from the bots map while open", () => {
    const { rerender } = render(<GroupSettingsSheet groupId="g" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Group settings" })).toBeTruthy();
    useUi.setState({ bots: { p: botFixture("p", "Planner"), s: botFixture("s", "Scout") } });
    expect(() => rerender(<GroupSettingsSheet groupId="g" onClose={vi.fn()} />)).not.toThrow();
    expect(screen.queryByRole("dialog", { name: "Group settings" })).toBeNull();
  });
});

describe("BotAvatar honours a group's own picture (fix-ui-botadmin)", () => {
  beforeEach(() => { installFakeBridge({ getAgentAvatar: { mime: "image/png", bytesBase64: "AAAA" } }); });

  it("shows the uploaded image instead of the member stack", async () => {
    const g = group("gimg", ["p", "s"], { profile: { ...botFixture("gimg", "Crew").profile, avatarKind: "image", avatarVersion: 3 } });
    useUi.setState({ ...initialState(), bots: { gimg: g, p: botFixture("p", "Planner"), s: botFixture("s", "Scout") } });
    const { container } = render(<BotAvatar bot={g} size={40} />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  });

  it("still shows the member stack when the group has no picture of its own", () => {
    const g = group("gnoimg", ["p", "s"]);
    useUi.setState({ ...initialState(), bots: { gnoimg: g, p: botFixture("p", "Planner"), s: botFixture("s", "Scout") } });
    const { container } = render(<BotAvatar bot={g} size={40} />);
    expect(container.querySelector(".group-stack")).toBeTruthy();
  });
});

describe("Details panel survives switching Bots with a routine open (fix-ui-botadmin)", () => {
  beforeEach(() => {
    installFakeBridge({ getAgentAutomations: { routines: [] } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout"), b: botFixture("b", "Ledger") }, settings: settingsFixture(), panel: "routine", routineId: "r-from-a" });
  });

  it("falls back to the Bot's details instead of an empty panel, and forgets the stale routine", async () => {
    render(<DetailsPanel botId="b" />);
    expect(screen.getByLabelText("Conversation details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bot settings" })).toBeTruthy();
    await waitFor(() => expect(useUi.getState().panel).toBe("details"));
    expect(useUi.getState().routineId).toBeNull();
  });
});
