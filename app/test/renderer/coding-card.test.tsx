// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentCard } from "../../src/renderer/components/cards/CodingAgentCard";

afterEach(cleanup);
describe("coding-agent card", () => {
  it("shows title, repo, branch, status and the PR link", () => {
    render(<CodingAgentCard botId="b" entryId="t1s1" card={{ kind: "coding-agent", agent: { id: "coding-1", botId: "b", title: "README fix", repo: "garden-app", branch: "bots/readme-fix-1a2b", worktree: "/w", status: "done", startedAt: 1, endedAt: 2, prUrl: "https://github.com/alex/garden-app/pull/42", summary: "Fixed the typo." } }} />);
    const card = screen.getByRole("region", { name: "Coding agent: README fix" });
    expect(card.textContent).toContain("garden-app");
    expect(card.textContent).toContain("bots/readme-fix-1a2b");
    expect(card.textContent).toContain("Done");
    expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href")).toBe("https://github.com/alex/garden-app/pull/42");
  });

  it("0.1.4 first-run: a running agent has Stop, which asks the host to cancel it; an ended one has none", async () => {
    const call = vi.fn(async () => ({ ok: true, result: { agent: {} } }));
    (window as unknown as { synapse: unknown }).synapse = { call, onEvent: () => () => {}, onConnection: () => () => {} };
    const agent = { id: "coding-9", botId: "b", title: "Refactor", repo: "garden-app", branch: "bots/refactor-9", worktree: "/w", status: "running" as const, startedAt: 1, endedAt: null, prUrl: null, summary: null };
    const { rerender } = render(<CodingAgentCard botId="b" entryId="t1s1" card={{ kind: "coding-agent", agent }} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("cancelCodingAgent", { id: "coding-9" }));
    rerender(<CodingAgentCard botId="b" entryId="t1s1" card={{ kind: "coding-agent", agent: { ...agent, status: "cancelled", endedAt: 2, summary: "Cancelled." } }} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("region", { name: "Coding agent: Refactor" }).textContent).toContain("Cancelled");
  });
});
