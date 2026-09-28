// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillView } from "@synapse/shared";
import { SkillChips, SkillPicker } from "../../src/renderer/components/SkillPicker";
import { useComposer } from "../../src/renderer/composer-store";
import { installFakeBridge } from "./fake-bridge";

const s = (id: string, name: string, disabledFor: string[] = []): SkillView => ({ id, name, description: `Use this when ${name}`, source: null, managed: false, bodyChars: 1, disabledFor, updatedAt: 1 });

describe("/ skill picker (SKL-03)", () => {
  beforeEach(() => {
    installFakeBridge({ getWorkflows: { workflows: [s("weekly-report", "Weekly report"), s("inbox-sweep", "Inbox sweep", ["b"]), s("standup", "Standup")] } });
    useComposer.setState({ byBot: {} });
  });

  it("offers enabled skills that match the query and picks with Enter", async () => {
    const onPick = vi.fn();
    render(<SkillPicker botId="b" query="st" onPick={onPick} onClose={() => {}} />);
    const list = await screen.findByRole("listbox", { name: "Skills" });
    expect(list.textContent).toContain("Standup");
    expect(list.textContent).not.toContain("Inbox sweep");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("standup", "Standup");
  });

  it("shows chosen skills as removable chips", () => {
    useComposer.getState().addSkill("b", "weekly-report");
    render(<SkillChips botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove skill weekly-report" }));
    expect(useComposer.getState().byBot.b!.skillIds).toEqual([]);
  });
});
