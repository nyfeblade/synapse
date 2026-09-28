import { describe, expect, it } from "vitest";
import {
  COMPOSIO_HEADER,
  COMPOSIO_MCP_URL,
  GITHUB_HEADER,
  GITHUB_MCP_URL,
  SLACK_HEADER,
  SLACK_MCP_URL,
  applyCustomMcpPreset,
  isComposioCustomServer,
  isGithubCustomServer,
  isSlackCustomServer,
} from "../../src/renderer/marketplace/custom-mcp-preset";

describe("applyCustomMcpPreset", () => {
  it("fills Composio's Connect URL and header from the name, any case", () => {
    expect(applyCustomMcpPreset("composio", "", "")).toEqual({ url: COMPOSIO_MCP_URL, headerName: COMPOSIO_HEADER });
    expect(isComposioCustomServer("COMPOSIO", "")).toBe(true);
  });

  it("fills only the header when the URL already names Composio", () => {
    expect(applyCustomMcpPreset("Work", "https://connect.composio.dev/mcp", "")).toEqual({
      url: "https://connect.composio.dev/mcp",
      headerName: COMPOSIO_HEADER,
    });
  });

  it("does not overwrite a URL or header the caller already set", () => {
    expect(applyCustomMcpPreset("Composio", "https://example.com/mcp", "Authorization")).toEqual({
      url: "https://example.com/mcp",
      headerName: "Authorization",
    });
  });

  it("leaves every other server untouched", () => {
    expect(applyCustomMcpPreset("Linear", "", "")).toEqual({ url: "", headerName: "" });
    expect(isComposioCustomServer("Linear", "https://mcp.linear.app/mcp")).toBe(false);
    expect(isSlackCustomServer("Linear", "https://mcp.linear.app/mcp")).toBe(false);
    expect(isGithubCustomServer("Linear", "https://mcp.linear.app/mcp")).toBe(false);
  });

  it("fills GitHub's Copilot MCP URL and Authorization from the name", () => {
    expect(applyCustomMcpPreset("github", "", "")).toEqual({ url: GITHUB_MCP_URL, headerName: GITHUB_HEADER });
    expect(isGithubCustomServer("GITHUB", "")).toBe(true);
  });

  it("fills Slack's official MCP URL and Authorization from the name, any case", () => {
    expect(applyCustomMcpPreset("slack", "", "")).toEqual({ url: SLACK_MCP_URL, headerName: SLACK_HEADER });
    expect(isSlackCustomServer("SLACK", "")).toBe(true);
  });

  it("fills only Slack's header when the URL already names mcp.slack.com", () => {
    expect(applyCustomMcpPreset("Work", "https://mcp.slack.com/mcp", "")).toEqual({
      url: "https://mcp.slack.com/mcp",
      headerName: SLACK_HEADER,
    });
  });
});
