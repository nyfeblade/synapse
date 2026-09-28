// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_HEADER_REDACTED, STR5, type McpServerView } from "@synapse/shared";
import { ManagePlugins } from "../../src/renderer/marketplace/ManagePlugins";

/**
 * Header-authenticated remote MCP servers, from the renderer's side. The host seals the value, so
 * the only thing that can reach this process is the header NAME and a redaction — these tests pin
 * that the UI is built for exactly that: it can say a key is set, replace it and remove it, and it
 * has nowhere to read one back from. SecretsSection.tsx is the same shape for Bot secrets.
 */
const withKey: McpServerView = {
  id: "composio", name: "Composio", label: null, kind: "remote", status: "connected", catalogId: null,
  instructions: "", error: null, tools: [], headers: [{ name: "x-consumer-api-key", value: MCP_HEADER_REDACTED }],
};
const withoutKey: McpServerView = {
  id: "plain", name: "Plain", label: null, kind: "remote", status: "connected", catalogId: null,
  instructions: "", error: null, tools: [], headers: [],
};

const calls: [string, unknown][] = [];
let servers: McpServerView[] = [];
beforeEach(() => {
  calls.length = 0;
  servers = [withKey, withoutKey];
  const results: Record<string, unknown> = {
    get listMcpServers() { return { servers }; },
    listPluginMarketplaces: { marketplaces: [] },
    addMcpServer: { server: withKey },
    setMcpServerHeader: { server: withKey },
    getWorkflows: { workflows: [] },
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: results[cmd] ?? {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
});
afterEach(cleanup);

// The fixture's installed Composio row renders the same hint, so a hint query over the whole
// screen would match that row and not the add form; scope it to the form being filled in.
const addForm = () => within(screen.getByLabelText(STR5.serverName).closest(".settings-card") as HTMLElement);

describe("adding a header-authenticated remote server", () => {
  it("sends the header name and value with the url, in one step", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Composio" } });
    fireEvent.change(screen.getByLabelText(STR5.serverUrl), { target: { value: "https://connect.composio.dev/mcp" } });
    fireEvent.change(screen.getByLabelText(STR5.headerName), { target: { value: "x-consumer-api-key" } });
    fireEvent.change(screen.getByLabelText(STR5.headerValue), { target: { value: "ck-secret-1" } });
    fireEvent.click(screen.getByRole("button", { name: STR5.add }));
    await vi.waitFor(() => expect(calls).toContainEqual(["addMcpServer", { name: "Composio", url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck-secret-1" } }]));
  });

  it("omits headers entirely when the user did not set one", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Plain" } });
    fireEvent.change(screen.getByLabelText(STR5.serverUrl), { target: { value: "https://plain.example/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: STR5.add }));
    await vi.waitFor(() => expect(calls).toContainEqual(["addMcpServer", { name: "Plain", url: "https://plain.example/mcp" }]));
  });

  it("the value field is a password field — a shoulder-surfer does not read the key off the screen", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    expect(screen.getByLabelText(STR5.headerValue).getAttribute("type")).toBe("password");
  });

  it("a header value without a header name is refused before it can be sent nowhere useful", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    // A generic server: Composio would fill the header name on its own, which is a different claim.
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Plain" } });
    fireEvent.change(screen.getByLabelText(STR5.serverUrl), { target: { value: "https://plain.example/mcp" } });
    fireEvent.change(screen.getByLabelText(STR5.headerValue), { target: { value: "ck-secret-1" } });
    expect((screen.getByRole("button", { name: STR5.add }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("naming the server Composio fills the Connect URL and the consumer-key header", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Composio" } });
    expect((screen.getByLabelText(STR5.serverUrl) as HTMLInputElement).value).toBe("https://connect.composio.dev/mcp");
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("x-consumer-api-key");
    expect(addForm().getByText(STR5.composioHeaderHint)).toBeTruthy();
  });

  it("a composio.dev URL fills the header name when it is still empty", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText(STR5.serverUrl), { target: { value: "https://connect.composio.dev/mcp" } });
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("x-consumer-api-key");
  });

  it("does not overwrite a header name the user already typed", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.headerName), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Composio" } });
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("Authorization");
  });

  it("a non-Composio server is left blank", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Linear" } });
    expect((screen.getByLabelText(STR5.serverUrl) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("");
    expect(addForm().queryByText(STR5.composioHeaderHint)).toBeNull();
    expect(addForm().getByText(STR5.headerHint)).toBeTruthy();
  });

  it("naming the server Slack fills the official URL and Authorization", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Slack" } });
    expect((screen.getByLabelText(STR5.serverUrl) as HTMLInputElement).value).toBe("https://mcp.slack.com/mcp");
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("Authorization");
    expect(screen.getByText(STR5.slackHeaderHint)).toBeTruthy();
  });

  it("a pasted Slack user token is sent as Bearer, even without the word Bearer", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "Slack" } });
    fireEvent.change(screen.getByLabelText(STR5.headerValue), { target: { value: "xoxp-123-workspace-token" } });
    fireEvent.click(screen.getByRole("button", { name: STR5.add }));
    await vi.waitFor(() => expect(calls).toContainEqual(["addMcpServer", {
      name: "Slack",
      url: "https://mcp.slack.com/mcp",
      headers: { Authorization: "Bearer xoxp-123-workspace-token" },
    }]));
  });

  it("naming the server GitHub fills the Copilot MCP URL and Authorization", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "GitHub" } });
    expect((screen.getByLabelText(STR5.serverUrl) as HTMLInputElement).value).toBe("https://api.githubcopilot.com/mcp/");
    expect((screen.getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("Authorization");
    expect(screen.getByText(STR5.githubHeaderHint)).toBeTruthy();
  });

  it("a pasted GitHub PAT is sent as Bearer", async () => {
    render(<ManagePlugins />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.addCustomServer }));
    fireEvent.change(screen.getByLabelText(STR5.serverName), { target: { value: "GitHub" } });
    fireEvent.change(screen.getByLabelText(STR5.headerValue), { target: { value: "ghp_exampletoken" } });
    fireEvent.click(screen.getByRole("button", { name: STR5.add }));
    await vi.waitFor(() => expect(calls).toContainEqual(["addMcpServer", {
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_exampletoken" },
    }]));
  });
});

describe("an existing server's key: shown as set, replaceable, removable, never readable", () => {
  it("lists the header name with a redaction in place of the value", async () => {
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Composio" });
    expect(within(card).getByText("x-consumer-api-key")).toBeTruthy();
    expect(within(card).getByText(MCP_HEADER_REDACTED)).toBeTruthy();
  });

  it("Replace asks for a new value and sends it; the field never starts populated", async () => {
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Composio" });
    fireEvent.click(within(card).getByRole("button", { name: STR5.replaceHeader("x-consumer-api-key") }));
    const field = within(card).getByLabelText(STR5.headerValue) as HTMLInputElement;
    expect(field.value, "a replace field that starts full would mean the value came back from the host").toBe("");
    fireEvent.change(field, { target: { value: "ck-secret-2" } });
    fireEvent.click(within(card).getByRole("button", { name: STR5.saveHeader }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setMcpServerHeader", { serverId: "composio", name: "x-consumer-api-key", value: "ck-secret-2" }]));
  });

  it("Remove clears it with a null value", async () => {
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Composio" });
    fireEvent.click(within(card).getByRole("button", { name: STR5.removeHeader("x-consumer-api-key") }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setMcpServerHeader", { serverId: "composio", name: "x-consumer-api-key", value: null }]));
  });

  it("a remote server with no key offers to add one", async () => {
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Plain" });
    fireEvent.click(within(card).getByRole("button", { name: STR5.addHeader }));
    fireEvent.change(within(card).getByLabelText(STR5.headerName), { target: { value: "Authorization" } });
    fireEvent.change(within(card).getByLabelText(STR5.headerValue), { target: { value: "Bearer ck-secret-3" } });
    fireEvent.click(within(card).getByRole("button", { name: STR5.saveHeader }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setMcpServerHeader", { serverId: "plain", name: "Authorization", value: "Bearer ck-secret-3" }]));
  });

  it("a Slack card with no token already has Authorization open so the user pastes, not Authorize", async () => {
    servers = [{
      id: "slack", name: "Slack", label: null, kind: "remote", status: "needs-auth", catalogId: "curated:slack",
      instructions: "", error: null, tools: [], headers: [],
    }];
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Slack" });
    expect((within(card).getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("Authorization");
    expect(within(card).getByText(STR5.slackHeaderHint)).toBeTruthy();
  });

  it("a GitHub card with no token already has Authorization open so the user pastes a PAT", async () => {
    servers = [{
      id: "github", name: "GitHub", label: null, kind: "remote", status: "needs-auth", catalogId: "curated:github",
      instructions: "", error: null, tools: [], headers: [],
    }];
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "GitHub" });
    expect((within(card).getByLabelText(STR5.headerName) as HTMLInputElement).value).toBe("Authorization");
    expect(within(card).getByText(STR5.githubHeaderHint)).toBeTruthy();
  });

  it("a command server has no header UI at all — headers are a remote-transport idea", async () => {
    servers = [{ id: "files", name: "Files", label: null, kind: "command", status: "connected", catalogId: null, instructions: "", error: null, tools: [] }];
    render(<ManagePlugins />);
    const card = await screen.findByRole("group", { name: "Files" });
    expect(within(card).queryByRole("button", { name: STR5.addHeader })).toBeNull();
  });
});
