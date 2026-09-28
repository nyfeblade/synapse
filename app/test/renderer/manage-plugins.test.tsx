// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, type McpServerView } from "@synapse/shared";
import { ConnectCard } from "../../src/renderer/components/cards/ConnectCard";
import { extractMentions, mentionQuery } from "../../src/renderer/components/MentionPicker";
import { ManagePlugins } from "../../src/renderer/marketplace/ManagePlugins";

const servers: McpServerView[] = [
  { id: "linear-work", name: "Linear", label: "work", kind: "remote", status: "connected", catalogId: "curated:linear", instructions: "", error: null, tools: [{ name: "list_issues", description: "", enabled: true }, { name: "delete_issue", description: "", enabled: false }] },
  { id: "gmail", name: "Gmail", label: null, kind: "remote", status: "connected", catalogId: null, instructions: "", error: null, tools: [{ name: "send_email", description: "", enabled: true }] },
];
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  const results: Record<string, unknown> = { listMcpServers: { servers }, listPluginMarketplaces: { marketplaces: [] }, setMcpToolEnabled: { server: servers[0] }, installPlugin: { entry: {}, serverIds: ["linear"], needsAuth: true, openUrl: null }, startMcpAuth: { authorizationUrl: "https://auth.example/a" }, getWorkflows: { workflows: [{ id: "s1", name: "weekly-report", description: "Writes the weekly report" }] } };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: results[cmd] ?? {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("Manage plugins loading vs empty (bug 37)", () => {
  it("names loading separately from empty for servers, markets, and skills", async () => {
    let resolveServers!: (v: unknown) => void;
    let resolveMarkets!: (v: unknown) => void;
    const serversP = new Promise((r) => { resolveServers = r; });
    const marketsP = new Promise((r) => { resolveMarkets = r; });
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string) => {
      if (cmd === "listMcpServers") return serversP.then((servers) => ({ ok: true, result: { servers } }));
      if (cmd === "listPluginMarketplaces") return marketsP.then((marketplaces) => ({ ok: true, result: { marketplaces } }));
      if (cmd === "getWorkflows") return { ok: true, result: { workflows: [] } };
      return { ok: true, result: {} };
    });
    render(<ManagePlugins />);
    // Each list names its own loading state: one shared "Loading…" cannot say WHICH list is waiting.
    expect(screen.getByRole("status", { name: STR5.installedTab }).textContent).toBe("Loading…");
    expect(screen.getByRole("status", { name: STR5.marketplaces }).textContent).toBe("Loading…");
    expect(screen.queryByText("No plugins installed yet.")).toBeNull();
    expect(screen.queryByText("No plugin marketplaces added.")).toBeNull();
    resolveServers([]);
    // The server list answers on its own; the marketplaces, still in flight, keep saying so.
    expect(await screen.findByText("No plugins installed yet.")).toBeTruthy();
    expect(screen.getByRole("status", { name: STR5.marketplaces }).textContent).toBe("Loading…");
    expect(screen.queryByText("No plugin marketplaces added.")).toBeNull();
    resolveMarkets([]);
    expect(await screen.findByText("No plugin marketplaces added.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Private skills" }));
    expect(await screen.findByText("No private skills yet.")).toBeTruthy();
  });

  it("the skills list names its loading state before it has an answer", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string) =>
      cmd === "getWorkflows" ? new Promise(() => {}) : { ok: true, result: cmd === "listMcpServers" ? { servers: [] } : { marketplaces: [] } });
    render(<ManagePlugins />);
    fireEvent.click(screen.getByRole("tab", { name: "Private skills" }));
    expect((await screen.findByRole("status", { name: STR5.privateSkillsTab })).textContent).toBe("Loading…");
    expect(screen.queryByText("No private skills yet.")).toBeNull();
  });

  // THE ERROR ARM. Every list used to turn a failed read into an empty one (`.catch(() => set([]))`),
  // so "the host said no" rendered as "you have none" — the exact lie this bug is about. Each list
  // now says it could not be read, keeps its neighbours, and offers a Retry that actually re-reads.
  const FAIL = "Could not reach the computer";
  function failFirst(cmd: string) {
    const real = (window as unknown as { synapse: { call: (c: string, a: unknown) => Promise<unknown> } }).synapse.call;
    let failed = false;
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (c: string, a: unknown) => {
      if (c === cmd && !failed) { failed = true; return { ok: false, error: { code: "GATEWAY_ERROR", message: FAIL } }; }
      return real(c, a);
    });
  }

  it("a failed server list says so with a Retry, never 'No plugins installed yet.'", async () => {
    failFirst("listMcpServers");
    render(<ManagePlugins />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(STR5.serversLoadFailed);
    expect(alert.textContent).toContain(FAIL);
    expect(screen.queryByText("No plugins installed yet."), "a failed read rendered as an empty list").toBeNull();
    // Its neighbour is independent: the marketplaces still load and still say they are empty.
    expect(await screen.findByText("No plugin marketplaces added.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Linear (work)" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed marketplace list says so with a Retry, and the servers stay on screen", async () => {
    failFirst("listPluginMarketplaces");
    render(<ManagePlugins />);
    expect((await screen.findByRole("alert")).textContent).toContain(STR5.marketplacesLoadFailed);
    expect(screen.queryByText("No plugin marketplaces added.")).toBeNull();
    expect(await screen.findByRole("group", { name: "Linear (work)" }), "one failed list blanked the other").toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No plugin marketplaces added.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed skills list says so with a Retry, never 'No private skills yet.'", async () => {
    failFirst("getWorkflows");
    render(<ManagePlugins />);
    fireEvent.click(screen.getByRole("tab", { name: "Private skills" }));
    expect((await screen.findByRole("alert")).textContent).toContain(STR5.skillsLoadFailed);
    expect(screen.queryByText("No private skills yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("weekly-report")).toBeTruthy();
  });
});

describe("Manage plugins and skills (PLG-02, PLG-08, PLG-09)", () => {
  it("lists accounts with labels and per-tool switches", async () => {
    render(<ManagePlugins />);
    const linear = await screen.findByRole("group", { name: "Linear (work)" });
    const off = within(linear).getByRole("switch", { name: "delete_issue" });
    expect(off.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(off);
    await vi.waitFor(() => expect(calls).toContainEqual(["setMcpToolEnabled", { serverId: "linear-work", tool: "delete_issue", enabled: true }]));
    expect(screen.getByRole("group", { name: "Gmail" })).toBeTruthy();
  });

  it("adds a custom server with url or command", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: "Add custom MCP server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Files" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx -y files-mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["addMcpServer", { name: "Files", command: "npx", args: ["-y", "files-mcp"] }]));
  });

  it("Private skills tab reads getWorkflows (SKL-05)", async () => {
    render(<ManagePlugins />);
    fireEvent.click(screen.getByRole("tab", { name: "Private skills" }));
    expect(await screen.findByText("weekly-report")).toBeTruthy();
  });
});

describe("connect card (PLG-05)", () => {
  it("Add → authorize; Authorize when added; Connected when done", async () => {
    const { rerender } = render(<ConnectCard botId="b" entryId="t1s1" card={{ kind: "connect", serverId: null, catalogId: "curated:linear", name: "Linear", logo: null, toolCount: 12, state: "available" }} />);
    expect(screen.getByText("Linear is packaged as a plugin. 12 tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Linear" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://auth.example/a" }]));
    rerender(<ConnectCard botId="b" entryId="t1s1" card={{ kind: "connect", serverId: "linear", catalogId: "curated:linear", name: "Linear", logo: null, toolCount: 12, state: "connected" }} />);
    expect(screen.getByText("✓ Connected")).toBeTruthy();
  });
});

describe("@-mentions (PLG-06)", () => {
  it("finds the query at the caret and extracts known names", () => {
    expect(mentionQuery("use @lin", 8)).toBe("lin");
    expect(mentionQuery("mail a@b.com", 12)).toBeNull();
    expect(extractMentions("ask @Linear and @Google Calendar", ["Linear", "Google Calendar", "Gmail"])).toEqual(["Linear", "Google Calendar"]);
  });
});

// Final integration: Phase 5's Private skills tab hands off to Phase 2's full private-skills manager
// (new / edit / delete / import, per-Bot switches) instead of a read-only list.
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { useOverlays } from "../../src/renderer/overlays";
describe("Private skills tab → Phase 2 manager (integration)", () => {
  it("opens the Phase 2 private-skills manager and closes the Marketplace", async () => {
    useMarketplace.setState({ open: true, page: "manage" });
    render(<ManagePlugins />);
    fireEvent.click(screen.getByRole("tab", { name: "Private skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit private skills" }));
    expect(useOverlays.getState().open).toBe("skills");
    expect(useMarketplace.getState().open).toBe(false);
  });
});
