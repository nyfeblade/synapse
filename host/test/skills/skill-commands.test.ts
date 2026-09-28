import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { markdownToSkill } from "../../skills/import";
import { SkillLibrary } from "../../skills/library";
import { createSkillCommands } from "../../skills/skill-commands";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
function setup(fetchFn?: typeof fetch) {
  const cfg = tmpConfig();
  initLayout(cfg);
  fs.mkdirSync(path.join(cfg.dataRoot, "agents", B), { recursive: true });
  const library = new SkillLibrary({ cfg });
  return { library, cmd: createSkillCommands({ library, botIds: () => [B], fetchFn }) };
}

describe("markdownToSkill", () => {
  it("uses frontmatter when present, else the first heading and paragraph", () => {
    expect(markdownToSkill("# Deploy checklist\n\nUse this when shipping.\n\n1. Test\n")).toEqual({ name: "Deploy checklist", description: "Use this when shipping.", body: "# Deploy checklist\n\nUse this when shipping.\n\n1. Test\n" });
    expect(markdownToSkill("Always write tests.\n", "CLAUDE")).toMatchObject({ name: "CLAUDE", description: "Always write tests." });
  });
});

describe("skills commands (SKL-05)", () => {
  it("creates, updates, toggles per Bot and deletes", async () => {
    const { cmd } = setup();
    const { workflow } = await cmd.createWorkflow!({ name: "Weekly report", description: "Use this when…", body: "1." });
    expect(workflow).toMatchObject({ id: "weekly-report", disabledFor: [] });
    expect((await cmd.updateWorkflow!({ workflowId: "weekly-report", body: "2." })).workflow.bodyChars).toBe(3);
    expect(await cmd.setAgentWorkflowEnabled!({ id: B, workflowId: "weekly-report", enabled: false })).toEqual({ disabled: ["weekly-report"] });
    expect((await cmd.getWorkflows!({})).workflows[0]!.disabledFor).toEqual([B]);
    expect((await cmd.getWorkflow!({ workflowId: "weekly-report" })).body).toBe("2.\n");
    await cmd.deleteWorkflow!({ workflowId: "weekly-report" });
    expect((await cmd.getWorkflows!({})).workflows).toEqual([]);
  });

  it("imports pasted Markdown, a URL (kept as metadata.source, re-import updates) and a folder", async () => {
    let body = "---\nname: Standup\ndescription: Use this when writing the standup.\n---\n1. Read commits\n";
    const fetchFn = (async () => new Response(body, { headers: { "content-type": "text/markdown" } })) as typeof fetch;
    const { library, cmd } = setup(fetchFn);
    expect((await cmd.importWorkflowText!({ markdown: "# Garden rules\n\nUse this when editing garden-app.\n" })).workflow.id).toBe("garden-rules");
    const u = await cmd.importWorkflowUrl!({ url: "https://example.com/standup.md" });
    expect(u.workflow).toMatchObject({ id: "standup", source: "https://example.com/standup.md" });
    body = body.replace("1. Read commits", "1. Read commits\n2. Read calendar");
    await cmd.importWorkflowUrl!({ url: "https://example.com/standup.md" });
    expect(library.read("standup")!.file.body).toContain("2. Read calendar");
    await expect(cmd.importWorkflowUrl!({ url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    const f = await cmd.importWorkflowFolder!({ name: "Invoices", files: [{ path: "SKILL.md", text: "---\nname: Invoices\ndescription: Use this when paying invoices.\n---\nSteps\n" }, { path: "scripts/pay.sh", text: "echo pay" }, { path: "../evil", text: "x" }] });
    expect(f.workflow.id).toBe("invoices");
    expect(library.helperFiles("invoices")).toEqual(["scripts/pay.sh"]);
  });

  it("propagates a real write failure from writeHelper instead of silently skipping it like an unsafe path", async () => {
    const { cmd } = setup();
    const orig = fs.writeSync.bind(fs);
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, text: unknown, ...rest: unknown[]) => {
      if (typeof text === "string" && text.includes("BOOM")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return (orig as (...a: unknown[]) => number)(fd, text, ...rest);
    }) as typeof fs.writeSync);
    try {
      expect(() => cmd.importWorkflowFolder!({
        name: "Receipts",
        files: [
          { path: "SKILL.md", text: "---\nname: Receipts\ndescription: Use this when filing receipts.\n---\nSteps\n" },
          { path: "scripts/file.sh", text: "echo BOOM" },
        ],
      })).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
  });
});
