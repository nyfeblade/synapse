// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, type SkillView } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";
import { ComposerPlusMenu } from "../../src/renderer/components/ComposerPlusMenu";
import { extractMentions, MentionPicker } from "../../src/renderer/components/MentionPicker";
import { SkillPicker } from "../../src/renderer/components/SkillPicker";
import { useComposer } from "../../src/renderer/composer-store";
import { useOverlays } from "../../src/renderer/overlays";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const skill = (id: string, name: string): SkillView => ({ id, name, description: `Use this when ${name}`, source: null, managed: false, bodyChars: 1, disabledFor: [], updatedAt: 1 });
const WORKFLOWS = { workflows: [skill("weekly-report", "Weekly report"), skill("deploy-to-prod", "Deploy to prod"), skill("standup", "Standup")] };

describe("composer pickers: skills, mentions and the clipboard", () => {
  afterEach(cleanup);
  beforeEach(() => {
    useComposer.setState({ byBot: {} });
    useOverlays.setState({ open: null });
    useUi.setState({ bots: { b: botFixture("b", "Piper") } } as never);
    try { localStorage.clear(); } catch { /* storage unavailable */ }
  });

  it("clamps the selection when the filtered list shrinks, so Enter still picks", async () => {
    installFakeBridge({ getWorkflows: WORKFLOWS });
    const onPick = vi.fn();
    const { rerender } = render(<SkillPicker botId="b" query="" onPick={onPick} onClose={() => {}} />);
    await screen.findByRole("listbox", { name: STR.skills });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    rerender(<SkillPicker botId="b" query="weekly" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("weekly-report", "Weekly report");
  });

  it("Escape closes the / skill picker and hands Enter back to the rest of the app", async () => {
    installFakeBridge({ getWorkflows: WORKFLOWS, sendPrompt: { accepted: true } });
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "/dep" } });
    expect(await screen.findByRole("listbox", { name: STR.skills })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: STR.skills })).toBeNull());
    // and typing a fresh query brings it back
    fireEvent.change(box, { target: { value: "/week" } });
    expect(await screen.findByRole("listbox", { name: STR.skills })).toBeTruthy();
  });

  it("the / skill picker keeps its hands off the keyboard while an overlay owns it", async () => {
    installFakeBridge({ getWorkflows: WORKFLOWS });
    const onPick = vi.fn();
    render(<SkillPicker botId="b" query="dep" onPick={onPick} onClose={() => {}} />);
    await screen.findByRole("listbox", { name: STR.skills });
    useOverlays.setState({ open: "palette" });
    const seen = vi.fn();
    const spy = (e: KeyboardEvent) => seen(e.defaultPrevented);
    window.addEventListener("keydown", spy);
    fireEvent.keyDown(document.body, { key: "Enter" });
    window.removeEventListener("keydown", spy);
    expect(onPick).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith(false);
  });

  it("a chosen skill shows the name the picker displayed, not its slug", async () => {
    installFakeBridge({ getWorkflows: WORKFLOWS });
    render(<Composer botId="b" name="Piper" running={false} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Piper" }), { target: { value: "/dep" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Deploy to prod/ }));
    expect(await screen.findByText("/Deploy to prod")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove skill Deploy to prod" })).toBeTruthy();
  });

  it("a skill added from the + menu also shows its name", async () => {
    installFakeBridge({ getWorkflows: WORKFLOWS });
    render(<><ComposerPlusMenu botId="b" /><Composer botId="b" name="Piper" running={false} /></>);
    fireEvent.click(screen.getAllByRole("button", { name: STR.attachFile })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: STR.useASkill }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Weekly report" }));
    expect(await screen.findByText("/Weekly report")).toBeTruthy();
  });

  it("Photo from clipboard says so when the clipboard holds no image, under a real label", async () => {
    installFakeBridge({});
    (navigator as unknown as { clipboard: { read: () => Promise<unknown[]> } }).clipboard = { read: () => Promise.resolve([{ types: ["text/plain"], getType: () => Promise.reject(new Error("no")) }]) };
    render(<ComposerPlusMenu botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.photoFromClipboard }));
    await waitFor(() => expect(useComposer.getState().byBot.b!.attachments[0]).toMatchObject({ name: "Clipboard", error: "No image on the clipboard." }));
  });

  it("the mention picker takes arrows, Enter and Escape instead of letting Enter send", async () => {
    installFakeBridge({});
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<MentionPicker query="" names={["Courier", "Scout"]} onPick={onPick} onClose={onClose} />);
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("Scout");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter completes the mention instead of sending the half-typed message", async () => {
    const bridge = installFakeBridge({ sendPrompt: { accepted: true }, listMcpServers: { servers: [] } });
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hey @Pi" } });
    expect(await screen.findByRole("listbox", { name: "Mention" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("hey @Piper "));
    expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(0);
  });

  it("extractMentions needs a real @mention, not an @ inside an email address", () => {
    const names = ["Gmail", "Courier", "Scout"];
    expect(extractMentions("email me at bob@gmail.com", names)).toEqual([]);
    expect(extractMentions("@Gmail check my inbox", names)).toEqual(["Gmail"]);
    expect(extractMentions("ask @scout about it", names)).toEqual(["Scout"]);
    expect(extractMentions("ask @scouting about it", names)).toEqual([]);
  });
});
