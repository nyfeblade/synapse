import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAttachmentSendExtension } from "../../files/attachment-send";
import { createFileCommands, pdfPages, resolveReadable } from "../../files/file-access";
import { makeRunnerHarness } from "../runner/harness";

describe("files out (FILE-03, FILE-06)", () => {
  it("sends a /workspace file as an attachment card with size, mime and pages", async () => {
    let target = "";
    const h = await makeRunnerHarness({
      toolExtensionsFactory: (_b, cfg) => createAttachmentSendExtension({ cfg }),
      script: () => [{ tool: "mcp__bot__SendMessage", input: { type: "attachment", url: `file://${target}`, content: "Here's the report." } }],
    });
    target = path.join(h.cfg.workspace, "report.pdf");
    fs.writeFileSync(target, "%PDF-1.4\n1 0 obj <</Type /Pages /Kids [2 0 R 3 0 R]>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type /Page>>\n");
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "send it", "n1");
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t1s1")).toMatchObject({ message: { type: "attachment", name: "report.pdf", mime: "application/pdf", pages: 2, caption: "Here's the report." } });
  });

  it("refuses files outside /workspace and the attachment store, and symlink escapes", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    expect(() => resolveReadable(h.cfg, "/etc/passwd")).toThrow("That file isn't in /workspace or your attachments.");
    fs.symlinkSync("/etc/hosts", path.join(h.cfg.workspace, "sneaky"));
    expect(() => resolveReadable(h.cfg, path.join(h.cfg.workspace, "sneaky"))).toThrow("That file isn't in /workspace or your attachments.");
    expect(() => resolveReadable(h.cfg, path.join(h.cfg.workspace, "..", "x"))).toThrow();
  });

  it("reads ranges for previews and Save", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    fs.writeFileSync(path.join(h.cfg.workspace, "a.csv"), "a,b\n1,2\n");
    const cmd = createFileCommands({ cfg: h.cfg });
    expect(await cmd.readWorkspaceFile!({ path: path.join(h.cfg.workspace, "a.csv"), offset: 4, length: 100 })).toEqual({ chunkBase64: Buffer.from("1,2\n").toString("base64"), size: 8, mime: "text/csv", eof: true });
    expect(pdfPages(path.join(h.cfg.workspace, "a.csv"))).toBeNull();
  });

  it("accepts https links without fetching", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const ext = createAttachmentSendExtension({ cfg: h.cfg });
    const delivered: unknown[] = [];
    const r = await ext.sendTypes!.attachment!({ botId: "b", slot: {} as never, now: Date.now, args: { url: "https://example.com/files/deck.pptx" }, deliver: (m) => (delivered.push(m), {} as never) });
    expect(r).toEqual({ text: "Sent deck.pptx." });
    expect(delivered[0]).toMatchObject({ type: "attachment", name: "deck.pptx", size: null, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  });
});
