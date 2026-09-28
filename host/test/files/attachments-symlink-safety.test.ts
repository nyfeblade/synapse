import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../../files/attachments";
import { makeRunnerHarness } from "../runner/harness";

async function upload(store: AttachmentStore, botId: string, name: string, mime: string, data: Buffer) {
  return store.receive(botId, { id: botId, uploadId: `u-${name}`, name, mime, size: data.length, offset: 0, chunkBase64: data.toString("base64"), final: true });
}

// Controller ruling: attachments.ts must never follow a Bot-controlled symlink as bothost. The
// chunk-assembly part file already lives under hostPrivate (box has zero access there at all -- not
// even read -- so there's nothing for a Bot to swap). The store copy also lives under dataRoot/agents
// (bothost:bots 2750, no group-write bit, so box can't touch it either). Only the /workspace/uploads
// staging copy (box:bots 2775, box-writable) was at risk: stage() now writes through the shared
// writeHostOwnedFile (O_EXCL|O_NOFOLLOW, host-owned dir, mode 0644) instead of fs.copyFileSync.
describe("AttachmentStore never writes a staged copy through a symlinked /workspace/uploads", () => {
  it("refuses to stage, leaves the swapped-to directory untouched, and still stores/commits the attachment", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "vault.key"), "SECRET");
    fs.mkdirSync(path.join(h.cfg.workspace, ".host-out"), { recursive: true }); // secfix round 3: staging is .host-out/uploads
    fs.symlinkSync(elsewhere, path.join(h.cfg.workspace, ".host-out", "uploads"));

    const r = await upload(store, id, "notes.txt", "text/plain", Buffer.from("hello world, twenty-six b"));
    expect(r.attachment!.boxPath).toBeNull();
    expect(r.attachment!.name).toBe("notes.txt");
    expect(fs.readFileSync(r.attachment!.storePath, "utf8")).toBe("hello world, twenty-six b");
    expect(fs.readdirSync(elsewhere)).toEqual(["vault.key"]);
    expect(fs.readFileSync(path.join(elsewhere, "vault.key"), "utf8")).toBe("SECRET");
  });

  it("stages host-owned (mode 0644) and self-heals a group-writable uploads dir", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const store = new AttachmentStore({ cfg: h.cfg });
    const dir = path.join(h.cfg.workspace, ".host-out", "uploads"); // secfix round 3
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);
    const r = await upload(store, id, "notes.txt", "text/plain", Buffer.from("hello world, twenty-six b"));
    expect(r.attachment!.boxPath).toBe(path.join(dir, id, "notes.txt")); // bug #61: per-Bot
    expect(fs.statSync(r.attachment!.boxPath!).mode & 0o777).toBe(0o640); // secfix round 3: box reads via the bots group
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });
});
