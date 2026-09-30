// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { NewChat } from "../../src/renderer/components/NewChat";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useTemplates } from "../../src/renderer/templates/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const starter = (id: string, name: string) => ({ id: `starter:${id}`, name, title: "", blurb: `${name} blurb`, avatarShape: "orb", avatarColor: "#3472d9", tools: [] });
beforeEach(() => {
  installFakeBridge({ listStarterTemplates: { starters: [starter("a", "Chief of Staff"), starter("b", "Inbox Triage"), starter("c", "Night Shift"), starter("d", "Feedback Miner"), starter("e", "Trip Planner")] } });
  useUi.setState({ ...initialState(), bots: { s: botFixture("s", "Scout"), f: botFixture("f", "Feedback Miner Bot") }, view: { kind: "new-chat" } } as never);
});
afterEach(cleanup);

describe("new-user walk finding 16: New chat filters, and offers a few templates", () => {
  it("typing filters the Bots and drops Create group chat", () => {
    render(<NewChat />);
    fireEvent.change(screen.getByLabelText("To:"), { target: { value: "Scout" } });
    expect(screen.getByRole("option", { name: /^Scout/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Feedback Miner Bot/ })).toBeNull();
    expect(screen.queryByRole("option", { name: STR.createGroupChat })).toBeNull();
  });

  it("shows four templates under Create new Bot; picking one opens its preview", async () => {
    const importEntry = vi.fn(async () => {});
    useTemplates.setState({ importEntry });
    render(<NewChat />);
    await screen.findByRole("option", { name: /Chief of Staff/ });
    expect(screen.queryByRole("option", { name: /Trip Planner/ })).toBeNull();
    // review (taste): name only, with the blurb as the tooltip — no second line
    const inbox = screen.getByRole("option", { name: /Inbox Triage/ });
    expect(inbox.textContent).not.toContain("Inbox Triage blurb");
    expect(inbox.getAttribute("title")).toBe("Inbox Triage blurb");
    fireEvent.click(inbox);
    expect(importEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "starter:b", source: "starter" }));
  });
});
