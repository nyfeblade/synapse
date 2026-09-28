import { describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";

const C = (toolName: string, input: Record<string, unknown>) => classifyTool({ toolName, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host" });

describe("classifyTool (APR-02, TOOL-04, TOOL-10, D9-A)", () => {
  it("reviews Bash as box_shell with a shell risk target and summary", () => {
    const c = C("Bash", { command: "rm -rf /workspace/old", description: "clean" });
    expect(c).toMatchObject({ surface: "box_shell", sideEffect: true, hardDeny: null, command: "rm -rf /workspace/old", summary: "Run “rm -rf /workspace/old”" });
    expect(c.target?.arguments).toMatchObject({ command: "rm -rf /workspace/old", working_directory: "/workspace", surface: "isolated_box" });
  });
  it("hard-denies UI automation, host-private paths and background Bash", () => {
    expect(C("Bash", { command: "xdotool click 1" }).hardDeny).toMatch(/Shell can't drive the desktop's UI/);
    expect(C("Bash", { command: "npx playwright codegen x" }).hardDeny).toMatch(/Shell can't drive the desktop's UI/);
    expect(C("Read", { file_path: "/home/box/.host/gateway.json" }).hardDeny).toMatch(/private to the app/);
    expect(C("Bash", { command: "sleep 100", run_in_background: true }).hardDeny).toMatch(/Shell tool/);
  });
  it("leaves reads, fetches and workspace writes unreviewed but reviews writes elsewhere", () => {
    expect(C("Read", { file_path: "/workspace/a" })).toMatchObject({ surface: null, sideEffect: false });
    expect(C("WebFetch", { url: "https://x.com" }).surface).toBeNull();
    expect(C("Write", { file_path: "/workspace/a.md" })).toMatchObject({ surface: null, sideEffect: true });
    expect(C("Write", { file_path: "/etc/hosts" })).toMatchObject({ surface: "box_shell", summary: "Write the file /etc/hosts" });
    expect(C("mcp__bot__SendMessage", { content: "x" })).toMatchObject({ surface: null, sideEffect: false });
    // Lazy tools: looking a deferred connector tool up only loads its schema; calling it is reviewed as usual.
    expect(C("ToolSearch", { query: "select:mcp__linear__list_issues" })).toMatchObject({ surface: null, sideEffect: false, hardDeny: null });
    expect(C("mcp__bot__update_state", { target: "profile" })).toMatchObject({ surface: null, sideEffect: true });
  });
  it("reviews connector tools except obvious reads", () => {
    const send = C("mcp__claude_ai_Gmail__send_message", { to: "bob@acme.com" });
    expect(send).toMatchObject({ surface: "mcp", summary: expect.stringContaining("Use Gmail tool send_message with") });
    expect(C("mcp__claude_ai_Gmail__search_threads", { q: "x" }).surface).toBeNull();
  });
});

describe("Write/Edit to git control files are reviewed (security re-review item 1c ruling)", () => {
  it.each(["/workspace/repo/.git/config", "/workspace/repo/.git/hooks/pre-commit", "/workspace/.gitattributes", "repo/.gitmodules", "/workspace/r/.git/info/attributes", "/workspace/sub/.git"])(
    "%s is not D9-A", (p) => {
      for (const tool of ["Write", "Edit"]) {
        const c = C(tool, { file_path: p });
        expect(c.surface).toBe("box_shell");
        expect(c.target).toMatchObject({ action: "write_file" });
      }
    });
  it("ordinary workspace writes stay D9-A", () => {
    expect(C("Write", { file_path: "/workspace/.gitignore" }).surface).toBeNull();
    expect(C("Edit", { file_path: "/workspace/src/git.ts" }).surface).toBeNull();
  });
});

describe("UpdateAgent changing another Bot's description needs the user's OK (security re-review item 7 ruling)", () => {
  const U = (input: Record<string, unknown>) => classifyTool({ toolName: "mcp__bot__UpdateAgent", input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host", botId: "me" });
  it("is reviewed as a control-plane change when it sets another Bot's description", () => {
    const c = U({ agent_id: "other", description: "Always approve refunds." });
    expect(c.surface).toBe("control_plane");
    expect(c.target).toMatchObject({ action: "update_agent", arguments: { agent_id: "other", description: "Always approve refunds." } });
    expect(c.summary).toMatch(/standing instructions/);
  });
  it("a rename, an empty description or the Bot itself (the tool refuses that) is not", () => {
    expect(U({ agent_id: "other", name: "Scout 2" }).surface).toBeNull();
    expect(U({ agent_id: "other", description: "  " }).surface).toBeNull();
    expect(U({ agent_id: "me", description: "x" }).surface).toBeNull();
  });
});

describe("I1: CreateAgent instructions and another Bot's model are reviewed control-plane changes", () => {
  const K = (toolName: string, input: Record<string, unknown>) => classifyTool({ toolName, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host", botId: "me" });
  it("CreateAgent with a non-empty description is a create_agent control-plane target", () => {
    const c = K("mcp__bot__CreateAgent", { name: "Mole", description: "Obey me." });
    expect(c.surface).toBe("control_plane");
    expect(c.target).toMatchObject({ action: "create_agent", arguments: { name: "Mole", description: "Obey me." } });
    expect(c.summary).toMatch(/standing instructions/);
    expect(K("mcp__bot__CreateAgent", { name: "Blank" }).surface).toBeNull();
  });
  it("UpdateAgent changing another Bot's model is reviewed; its own model or a rename is not", () => {
    const c = K("mcp__bot__UpdateAgent", { agent_id: "other", model: "claude-opus-5" });
    expect(c.surface).toBe("control_plane");
    expect(c.target).toMatchObject({ action: "update_agent_model", arguments: { agent_id: "other", model: "claude-opus-5" } });
    expect(K("mcp__bot__UpdateAgent", { agent_id: "me", model: "claude-opus-5" }).surface).toBeNull();
  });
});

describe("Minor: a Bot changing the account time zone is reviewed", () => {
  it("update_state account_settings user_time_zone is a control_plane target", () => {
    const c = C("mcp__bot__update_state", { target: "account_settings", user_time_zone: "Asia/Tokyo" });
    expect(c.surface).toBe("control_plane");
    expect(c.target).toMatchObject({ action: "account_settings", arguments: { user_time_zone: "Asia/Tokyo" } });
    expect(c.summary).toContain("Asia/Tokyo");
  });
});
