// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
