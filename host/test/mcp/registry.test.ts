import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { McpRegistry, parseMcpToolName, slugify } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

let dir: string;
let reg: McpRegistry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpreg-"));
  reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "settings.json")), now: () => 5 });
});

describe("McpRegistry", () => {
  it("slugs names into SDK-safe server ids and never collides with bot or claude_ai", () => {
    expect(slugify("Google Calendar")).toBe("google-calendar");
    expect(slugify("bot")).toBe("bot-server");
    expect(slugify("claude_ai_Gmail")).toBe("claude-ai-gmail-server");
    expect(parseMcpToolName("mcp__linear__create_issue")).toEqual({ server: "linear", tool: "create_issue" });
    expect(parseMcpToolName("mcp__claude_ai_Google_Calendar__list_events")).toEqual({ server: "claude_ai_Google_Calendar", tool: "list_events" });
    expect(parseMcpToolName("Bash")).toBeNull();
  });

  it("adds remote and command servers, stores secrets 0600 and keeps named instances apart (PLG-08, PLG-09)", () => {
    const a = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
    const b = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp", label: "work" }, "curated", "curated:linear");
    const c = reg.add({ name: "Files", command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "s3cret" } }, "custom");
    expect([a.id, b.id, c.id]).toEqual(["linear", "linear-work", "files"]);
    expect(reg.byCatalogId("curated:linear")).toHaveLength(2);
    const file = path.join(dir, "mcp", "servers.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "mcp")).mode & 0o777).toBe(0o700);
    // Open item 1: a command server with env (keys) is host-proxied; its values never reach the Bot's CLI config.
    expect(reg.commandServerConfigs()).toEqual({});
    expect(reg.hostProxied(c)).toBe(true);
    expect(reg.envFor("files")).toEqual({ TOKEN: "s3cret" });
    expect(reg.rename("linear-work", "personal").label).toBe("personal");
    expect(() => reg.add({ name: "Bad", url: "http://example.com/mcp" }, "custom")).toThrow(/https/);
    expect(() => reg.add({ name: "Both" }, "custom")).toThrow(/url or command/);
  });

  it("per-tool toggles drive disallowed tool names and the hook guard (PLG-02, CT-12 fallbacks)", () => {
    reg.add({ name: "Files", command: "npx" }, "custom");
    reg.setToolEnabled("files", "delete_file", false);
    reg.setToolEnabled("claude_ai_Gmail", "send_email", false);
    expect(reg.disallowedToolNames().sort()).toEqual(["mcp__files__delete_file"]); // synapse-public: no claude.ai connector to toggle
    expect(reg.guardTool("mcp__files__delete_file")).toMatch(/turned off/);
    expect(reg.guardTool("mcp__files__read_file")).toBeNull();
    reg.setToolEnabled("files", "delete_file", true);
    expect(reg.disallowedToolNames()).toEqual([]);
  });

  it("instructions (≤500) render into the system prompt extra", () => {
    const a = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
    reg.setInstructions(a.id, "Always file issues in the GARDEN team.".padEnd(600, "!"));
    expect(reg.instructions(a.id)).toHaveLength(500);
    expect(reg.systemAppendExtra()).toMatch(/^# Connector notes\n- Linear: Always file issues in the GARDEN team\./);
  });

  it("a server the user turned off contributes no connector notes (bug 54)", () => {
    // Its tools are gone from the Bot's spawn (sdkServers / commandServerConfigs filter on enabled),
    // so a note telling the Bot how to use it is an instruction to use a connector it cannot reach.
    const a = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
    const b = reg.add({ name: "Files", command: "npx" }, "custom");
    reg.setInstructions(a.id, "Always file issues in the GARDEN team.");
    reg.setInstructions(b.id, "Only touch the /tmp scratch dir.");
    reg.setEnabled(a.id, false);
    expect(reg.systemAppendExtra()).toBe("# Connector notes\n- Files: Only touch the /tmp scratch dir.");
    reg.setEnabled(a.id, true);
    expect(reg.systemAppendExtra()).toContain("- Linear: Always file issues in the GARDEN team.");
  });

  it("remove() clears custom instructions so a reissued slug never inherits stale connector guidance", () => {
    const a = reg.add({ name: "Files", command: "npx" }, "custom");
    reg.setInstructions(a.id, "Only touch the /tmp scratch dir.");
    expect(reg.instructions("files")).toBe("Only touch the /tmp scratch dir.");
    reg.remove("files");
    // A later, unrelated server can reuse the freed "files" slug.
    const b = reg.add({ name: "Files", command: "other-cmd" }, "custom");
    expect(b.id).toBe("files");
    expect(reg.instructions("files")).toBe("");
    expect(reg.systemAppendExtra()).toBe("");
  });

  it("detects command-server tools from session tool lists; claude.ai connector tools are ignored (synapse-public)", () => {
    reg.add({ name: "Files", command: "npx" }, "custom");
    reg.noteSessionTools(["Bash", "mcp__bot__SendMessage", "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__send_email", "mcp__claude_ai_Google_Calendar__list_events", "mcp__files__read_file"]);
    expect((reg as unknown as Record<string, unknown>).claudeAiServers).toBeUndefined();
    expect(reg.sessionTools("claude_ai_Gmail")).toEqual([]);
    expect(reg.sessionTools("files")).toEqual(["read_file"]);
  });

  it("a raw Slack user token stored as Authorization is sent as Bearer", () => {
    const s = reg.add({ name: "Slack", url: "https://mcp.slack.com/mcp", headers: { Authorization: "xoxp-123-workspace-token" } }, "curated", "curated:slack");
    expect(reg.headersFor(s.id)).toEqual({ Authorization: "Bearer xoxp-123-workspace-token" });
    reg.setHeader(s.id, "Authorization", "xoxp-rotated");
    expect(reg.headersFor(s.id)).toEqual({ Authorization: "Bearer xoxp-rotated" });
  });
});
