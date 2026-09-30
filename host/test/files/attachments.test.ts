import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAttachmentHooks } from "../../files/attachment-hooks";
import { AttachmentStore } from "../../files/attachments";
import { makeRunnerHarness } from "../runner/harness";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082", "hex");

async function upload(store: AttachmentStore, botId: string, name: string, mime: string, data: Buffer, chunk = 7) {
  let r: ReturnType<AttachmentStore["receive"]> = { received: 0, attachment: null };
  for (let off = 0; off < data.length || off === 0; off += chunk) {
    const part = data.subarray(off, off + chunk);
    r = store.receive(botId, { id: botId, uploadId: `u-${name}`, name, mime, size: data.length, offset: off, chunkBase64: part.toString("base64"), final: off + chunk >= data.length });
    if (off + chunk >= data.length) break;
  }
  return r;
}

describe("attachments in (CHAT-09)", () => {
  it("assembles chunks, stores content-addressed, stages to /workspace/uploads and dedupes names", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const r = await upload(store, id, "notes.txt", "text/plain", Buffer.from("hello world, twenty-six b"));
    expect(r.attachment).toMatchObject({ name: "notes.txt", size: 25, mime: "text/plain", boxPath: path.join(h.cfg.workspace, ".host-out", "uploads", id, "notes.txt") }); // bug #61: per-Bot
    expect(r.attachment!.attachmentId).toMatch(/^[0-9a-f]{64}\.txt$/);
    expect(fs.readFileSync(r.attachment!.storePath, "utf8")).toBe("hello world, twenty-six b");
    const r2 = await upload(store, id, "notes.txt", "text/plain", Buffer.from("different content here!!"));
    expect(path.basename(r2.attachment!.boxPath!)).toBe("notes (2).txt");
    expect(store.readChunk(id, r.attachment!.attachmentId, 6, 5)).toEqual({ chunkBase64: Buffer.from("world").toString("base64"), size: 25, eof: false });
  });

  // Task 39 fuzz: pasting paste.txt and dropping drop.txt with the same bytes gave both the same
  // content-addressed id, so the message listed drop.txt twice and paste.txt vanished.
  it("two same-content files with different names keep their own ids and names", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const a = (await upload(store, id, "paste.txt", "text/plain", Buffer.from("hello"))).attachment!;
    const b = (await upload(store, id, "drop.txt", "text/plain", Buffer.from("hello"))).attachment!;
    expect(a.attachmentId).not.toBe(b.attachmentId);
    expect(store.resolve(id, [a.attachmentId, b.attachmentId]).map((x) => x.name)).toEqual(["paste.txt", "drop.txt"]);
    const again = (await upload(store, id, "paste.txt", "text/plain", Buffer.from("hello"))).attachment!;
    expect(again.attachmentId).toBe(a.attachmentId); // same name + same bytes still dedupes
    expect(store.readChunk(id, b.attachmentId, 0, 5).chunkBase64).toBe(Buffer.from("hello").toString("base64"));
  });

  it("enforces type, size and offset rules", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    expect(() => store.receive(id, { id, uploadId: "x", name: "a.exe", mime: "application/octet-stream", size: 1, offset: 0, chunkBase64: "AA==", final: true })).toThrow("That file type isn't supported.");
    expect(() => store.receive(id, { id, uploadId: "y", name: "big.pdf", mime: "application/pdf", size: 26 * 1024 * 1024, offset: 0, chunkBase64: "AA==", final: false })).toThrow("big.pdf is larger than 25 MB.");
    expect(() => store.receive(id, { id, uploadId: "z", name: "a.txt", mime: "text/plain", size: 4, offset: 2, chunkBase64: "AA==", final: false })).toThrow(/offset/);
  });

  // Bug #61: the original is in the host-private Bot folder, so every file (videos too) is staged into the Bot's own
  // uploads folder and the model is told only that path, never the original's.
  it("stages videos too and tells the model only the staged path; images also go as image blocks", async () => {
    const h = await makeRunnerHarness({ hooksFactory: (bots) => createAttachmentHooks({ bots }), script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "seen" } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const img = (await upload(store, id, "dot.png", "image/png", PNG, 1024)).attachment!;
    const vid = (await upload(store, id, "clip.mp4", "video/mp4", Buffer.alloc(40, 1), 1024)).attachment!;
    expect(vid.boxPath).toBe(path.join(h.cfg.workspace, ".host-out", "uploads", id, "clip.mp4"));
    h.runner.sendPrompt(id, "look", "n1", { attachmentEntries: store.resolve(id, [img.attachmentId, vid.attachmentId]) });
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t1ua1")).toMatchObject({ kind: "user-attachment", batchId: "t1u", name: "dot.png" });
    const prompt = h.brain(id).inputs.at(-1)!.prompt;
    const note = prompt.find((p) => "text" in p && p.text.startsWith("<attached_files>")) as { text: string };
    expect(note.text).toContain(`- dot.png (image/png, 69 B): ${img.boxPath}\n`);
    expect(note.text).toContain(`- clip.mp4 (video/mp4, 40 B): ${vid.boxPath}\n`);
    expect(note.text).not.toContain(h.cfg.dataRoot);
    expect(prompt.some((p) => "image" in p && p.image.mediaType === "image/png")).toBe(true);
  });

  it("4.3 Email in: a file from an emailed task takes the upload path; a type the chat refuses is left out", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const big = Buffer.alloc(600 * 1024, 7); // more than one 512 KiB chunk
    const a = store.ingest(id, "ticket.txt", big)!;
    expect(a).toMatchObject({ name: "ticket.txt", size: big.length, boxPath: path.join(h.cfg.workspace, ".host-out", "uploads", id, "ticket.txt") });
    expect(fs.readFileSync(a.storePath).equals(big)).toBe(true);
    expect(store.ingest(id, "payload.exe", Buffer.from("MZ"))).toBeNull();
  });
});
