import { describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";
import { ForceAskReviewer, pluginInstallRule } from "../../review/force-ask";

const o = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
const inner = { review: async () => ({ kind: "allow" as const, stage: "model" as const, verdict: null }), clearCache: () => {} };
const req = (toolName: string, input: Record<string, unknown>) => {
  const c = classifyTool({ toolName, input, toolUseId: "t" }, o);
  return { surface: c.surface, target: c.target, toolName } as never;
};

describe("PLG-07 install card", () => {
  it("classifies AddMcpServer with a command and InstallPlugin as control_plane", () => {
    expect(classifyTool({ toolName: "mcp__bot__AddMcpServer", input: { name: "files", command: "npx", args: ["-y", "x"] }, toolUseId: "t" }, o)).toMatchObject({ surface: "control_plane", target: { action: "install_local_mcp_server" } });
    // P5 review I5: a remote AddMcpServer is control_plane too (and an ownership card: it adds a server for every Bot).
    expect(classifyTool({ toolName: "mcp__bot__AddMcpServer", input: { name: "linear", url: "https://mcp.linear.app/mcp" }, toolUseId: "t" }, o)).toMatchObject({ surface: "control_plane", target: { action: "add_mcp_server" } });
    expect(classifyTool({ toolName: "mcp__bot__InstallPlugin", input: { plugin_id: "mkt:g/garden" }, toolUseId: "t" }, o)).toMatchObject({ surface: "control_plane", target: { action: "install_plugin", arguments: { plugin_id: "mkt:g/garden" } } });
  });

  it("forces a card for local servers, allows plugins without them, and delegates everything else", async () => {
    const r = new ForceAskReviewer(inner, [pluginInstallRule((id) => id === "mkt:g/garden")]);
    await expect(r.review(req("mcp__bot__AddMcpServer", { name: "files", command: "npx" }))).resolves.toMatchObject({ kind: "block", stage: "floor" });
    await expect(r.review(req("mcp__bot__InstallPlugin", { plugin_id: "mkt:g/garden" }))).resolves.toMatchObject({ kind: "block" });
    await expect(r.review(req("mcp__bot__InstallPlugin", { plugin_id: "curated:linear" }))).resolves.toMatchObject({ kind: "allow", stage: "fast" });
    await expect(r.review({ surface: "box_shell", target: { action: "shell" } } as never)).resolves.toMatchObject({ kind: "allow", stage: "model" });
  });
});
