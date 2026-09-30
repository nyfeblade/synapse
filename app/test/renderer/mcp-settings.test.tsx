// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR_MCP } from "@synapse/shared";
import { McpApprovals, type McpStatusView } from "../../src/renderer/components/McpApprovals";
import { McpSection } from "../../src/renderer/components/settings/McpSection";
import { settingEntries } from "../../src/renderer/components/settings/search-index";

/**
 * 0.1.4: Settings → System → MCP and the first-connect card. Titles and labels only; the switch starts off; the
 * snippets are copied, never written anywhere; each app can be revoked; the audit shows client, tool and Bot.
 */
afterEach(cleanup);

const snippets = { claudeDesktop: '{"mcpServers":{"synapse":{}}}', claudeCode: "claude mcp add synapse", cursor: '{"cursor":1}' };
function mount(state: Partial<McpStatusView>, audit: unknown[] = []) {
  let s: McpStatusView = { enabled: false, error: null, clients: [], pending: [], snippets, ...state };
  const invoke = vi.fn(async (name: string, args: { id?: string }) => {
    if (name === "mcp.enable") s = { ...s, enabled: true };
    if (name === "mcp.disable") s = { ...s, enabled: false };
    if (name === "mcp.revoke") s = { ...s, clients: s.clients.filter((c) => c.id !== args.id) };
    if (name === "mcp.allow" || name === "mcp.deny") s = { ...s, pending: s.pending.filter((p) => p.id !== args.id) };
    if (name === "mcp.audit") return { ok: true, result: { entries: audit } };
    return { ok: true, result: s };
  });
  (window as unknown as { synapse: unknown }).synapse = { native: { invoke, on: () => () => {} } };
  return invoke;
}

describe("Settings → System → MCP", () => {
  it("is off by default; turning it on shows the setup snippets to copy, per client", async () => {
    const invoke = mount({});
    render(<McpSection />);
    const sw = await screen.findByRole("switch", { name: STR_MCP.access });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("mcp-snippet")).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("switch", { name: STR_MCP.access }).getAttribute("aria-checked")).toBe("true"));
    expect(invoke).toHaveBeenCalledWith("mcp.enable", {});
    expect(screen.getByTestId("mcp-snippet").textContent).toBe(snippets.claudeDesktop);
    fireEvent.click(screen.getByRole("radio", { name: "Claude Code" }));
    expect(screen.getByTestId("mcp-snippet").textContent).toBe(snippets.claudeCode);
    fireEvent.click(screen.getByRole("radio", { name: "Cursor" }));
    expect(screen.getByTestId("mcp-snippet").textContent).toBe(snippets.cursor);
    // Nothing but the status, the switch and the audit is ever asked of main: no config file is touched.
    expect(invoke.mock.calls.map((c) => c[0]).filter((n) => !["mcp.status", "mcp.enable", "mcp.audit"].includes(n))).toEqual([]);
  });

  it("lists approved apps with Revoke, and the activity log with client, tool and Bot", async () => {
    const invoke = mount({ enabled: true, clients: [{ id: "c1", key: "cursor", name: "Cursor", exe: "/Applications/Cursor.app", createdAt: 1, lastSeenAt: Date.now() }] },
      [{ at: Date.now(), clientId: "c1", client: "Cursor", tool: "ask_bot", bot: "Piper", outcome: "ok" }, { at: Date.now(), clientId: "c1", client: "Cursor", tool: "start_task", bot: "Piper", outcome: "limited" }]);
    render(<McpSection />);
    expect(await screen.findByText("Cursor · ask_bot · Piper")).toBeTruthy();
    expect(screen.getByText("Limited")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp.revoke", { id: "c1" }));
    await waitFor(() => expect(screen.getByText(STR_MCP.noApps)).toBeTruthy());
  });

  it("is findable in Settings search", () => {
    expect(settingEntries().some((e) => e.section === "system" && e.label === STR_MCP.access && e.keywords?.includes("claude desktop"))).toBe(true);
  });
});

describe("the first-connect card", () => {
  it("names the app and what launched it; Allow and Deny answer it", async () => {
    const invoke = mount({ enabled: true, pending: [{ id: "p1", key: "claude-desktop", name: "Claude Desktop", exe: "/Applications/Claude.app", createdAt: 1 }, { id: "p2", key: "x", name: "Evil", exe: "/tmp/evil", createdAt: 2 }] });
    render(<McpApprovals />);
    expect(await screen.findByText(STR_MCP.wants("Claude Desktop"))).toBeTruthy();
    expect(screen.getByText("/Applications/Claude.app")).toBeTruthy();
    const cards = screen.getAllByRole("alertdialog");
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[1]!.querySelector("button.btn-secondary")!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp.deny", { id: "p2" }));
    fireEvent.click(screen.getByRole("button", { name: STR_MCP.allow }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp.allow", { id: "p1" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("shows nothing when no app is waiting", async () => {
    mount({});
    const { container } = render(<McpApprovals />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
