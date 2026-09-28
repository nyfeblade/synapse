// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, type SkillView } from "@synapse/shared";
import { PrivateSkills } from "../../src/renderer/components/PrivateSkills";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const skill = (over: Partial<SkillView> = {}): SkillView => ({ id: "weekly-report", name: "Weekly report", description: "Use this when the user asks for the weekly report.", source: null, managed: false, bodyChars: 20, disabledFor: [], updatedAt: 1, ...over });

describe("Private skills (SKL-05, UI-10)", () => {
  afterEach(cleanup);
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({ getWorkflows: { workflows: [skill()] }, getWorkflow: { workflow: skill(), body: "1. Pull numbers\n" } });
    useUi.setState({ bots: { a: botFixture("a", "Scout") } } as never);
  });

  it("lists skills in the Marketplace frame with the Plugins tab disabled", async () => {
    render(<PrivateSkills />);
    const dlg = screen.getByRole("dialog", { name: STR.managePluginsAndSkills });
    expect(await within(dlg).findByText("Weekly report")).toBeTruthy();
    expect((within(dlg).getByRole("tab", { name: "Plugins" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dlg).getByRole("tab", { name: STR.privateSkills }).getAttribute("aria-selected")).toBe("true");
  });

  it("the managed teach skill isn't a private skill: not listed, so the empty state shows once loaded (e2e flake)", async () => {
    let resolve!: (v: unknown) => void;
    installFakeBridge({ getWorkflows: () => new Promise((r) => { resolve = r; }) });
    render(<PrivateSkills />);
    const dlg = screen.getByRole("dialog", { name: STR.managePluginsAndSkills });
    expect(within(dlg).queryByText(STR.noSkills)).toBeNull(); // still loading: no empty state yet
    resolve({ workflows: [skill({ id: "learn-from-demonstration", name: "learn-from-demonstration", managed: true })] });
    expect(await within(dlg).findByText(STR.noSkills)).toBeTruthy();
    expect(within(dlg).queryByText("learn-from-demonstration")).toBeNull();
  });

  it("edits a skill in the Markdown editor and saves", async () => {
    render(<PrivateSkills />);
    fireEvent.click(await screen.findByRole("button", { name: `${STR.editSkill} Weekly report` }));
    const body = await screen.findByLabelText("Skill body (Markdown)");
    expect((body as HTMLTextAreaElement).value).toBe("1. Pull numbers\n");
    fireEvent.change(body, { target: { value: "1. Pull numbers\n2. Draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: STR.save }));
    await waitFor(() => expect(bridge.calls.some(([c, a]) => c === "updateWorkflow" && (a as { body: string }).body === "1. Pull numbers\n2. Draft\n")).toBe(true));
  });

  it("toggles a Bot off and deletes", async () => {
    render(<PrivateSkills />);
    await screen.findByText("Weekly report");
    fireEvent.click(screen.getByRole("switch", { name: "Weekly report for Scout" }));
    expect(bridge.calls.at(-1)).toEqual(["setAgentWorkflowEnabled", { id: "a", workflowId: "weekly-report", enabled: false }]);
    window.confirm = () => true;
    fireEvent.click(screen.getByRole("button", { name: `${STR.deleteSkill} Weekly report` }));
    await vi.waitFor(() => expect(bridge.calls).toContainEqual(["deleteWorkflow", { workflowId: "weekly-report" }]));
  });

  it("imports pasted Markdown", async () => {
    render(<PrivateSkills />);
    fireEvent.click(screen.getByRole("button", { name: STR.importSkill }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.importMarkdown }));
    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# Garden rules\n\nUse this when…" } });
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
    expect(bridge.calls.at(-1)).toEqual(["importWorkflowText", { markdown: "# Garden rules\n\nUse this when…" }]);
  });
});

// Final integration: Phase 4 installs a managed teach skill whose source isn't a URL; the list must still render.
describe("Private skills with a non-URL source (integration)", () => {
  afterEach(cleanup);
  it("renders the list instead of crashing on new URL()", async () => {
    installFakeBridge({ getWorkflows: { workflows: [skill({ id: "folder", name: "Folder skill", source: "managed", managed: false }), skill()] } });
    useUi.setState({ bots: { a: botFixture("a", "Scout") } } as never);
    render(<PrivateSkills />);
    const dlg = screen.getByRole("dialog", { name: STR.managePluginsAndSkills });
    expect(await within(dlg).findByText("Weekly report")).toBeTruthy();
    expect(within(dlg).getByText("managed")).toBeTruthy();
  });
});
