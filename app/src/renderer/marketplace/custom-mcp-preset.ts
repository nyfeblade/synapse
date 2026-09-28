/**
 * Known custom-MCP presets. The add form stays generic (PLG-08); a name or URL we already
 * recognize fills the fields the user would otherwise have to copy from that server's docs.
 *
 * Composio's pair is from their Connect docs: URL https://connect.composio.dev/mcp and header
 * x-consumer-api-key.
 */
export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_HEADER = "x-consumer-api-key";
export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
export const SLACK_HEADER = "Authorization";
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_HEADER = "Authorization";

export function isComposioCustomServer(name: string, url: string): boolean {
  return name.trim().toLowerCase() === "composio" || url.trim().toLowerCase().includes("composio.dev");
}

export function isSlackCustomServer(name: string, url: string): boolean {
  return name.trim().toLowerCase() === "slack" || url.trim().toLowerCase().includes("mcp.slack.com");
}

export function isGithubCustomServer(name: string, url: string): boolean {
  return name.trim().toLowerCase() === "github" || url.trim().toLowerCase().includes("githubcopilot.com");
}

export function applyCustomMcpPreset(
  name: string,
  url: string,
  headerName: string,
): { url: string; headerName: string } {
  if (isComposioCustomServer(name, url)) {
    return {
      url: url.trim() ? url : COMPOSIO_MCP_URL,
      headerName: headerName.trim() ? headerName : COMPOSIO_HEADER,
    };
  }
  if (isSlackCustomServer(name, url)) {
    return {
      url: url.trim() ? url : SLACK_MCP_URL,
      headerName: headerName.trim() ? headerName : SLACK_HEADER,
    };
  }
  if (isGithubCustomServer(name, url)) {
    return {
      url: url.trim() ? url : GITHUB_MCP_URL,
      headerName: headerName.trim() ? headerName : GITHUB_HEADER,
    };
  }
  return { url, headerName };
}
