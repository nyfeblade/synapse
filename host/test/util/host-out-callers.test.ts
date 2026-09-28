import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureScreen } from "../../computer/capture";
import type { DisplayManager } from "../../computer/displays";
import { AttachmentStore } from "../../files/attachments";
import { shouldFence } from "../../runner/discipline";
import { isAlwaysIgnored } from "../../triggers/match";
import { hostOutDir } from "../../util/host-out";
import { tmpConfig } from "../helpers";

// Final secfix round 3, ruling 4: the host's Bot-visible output moves out of box-writable folders
// (/workspace/uploads, /workspace/.bot/screens, /workspace/.bot/events, /workspace/teach-sessions) into
// /workspace/.host-out/{uploads,events,screens,teach}: bothost-owned 2750 dirs, 0640 files.
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16, 1)]);
const displays = {
  ensure: async (botId: string) => ({ botId, index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 }),
  x: () => ({ screenshotWebp: async () => WEBP }),
} as unknown as DisplayManager;

describe("secfix3 ruling 4: host output lives under /workspace/.host-out", () => {
  it("hostOutDir names the four folders", () => {
    for (const k of ["uploads", "events", "screens", "teach"] as const) expect(hostOutDir("/workspace", k)).toBe(`/workspace/.host-out/${k}`);
  });

  it("screenshots: .host-out/screens/<bot>/<ts>.webp, 0640, per-bot dir 0750", async () => {
    const cfg = tmpConfig();
    const r = await captureScreen({ displays, botId: "b", workspace: cfg.workspace, now: () => 1234 });
    expect(r.path).toBe(path.join(cfg.workspace, ".host-out", "screens", "b", "1234.webp"));
    expect(fs.statSync(r.path!).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.dirname(r.path!)).mode & 0o777).toBe(0o750);
    expect(fs.existsSync(path.join(cfg.workspace, ".bot", "screens"))).toBe(false);
  });

  it("screenshots: a box-planted .host-out (a symlinked screens dir) is refused and nothing lands outside", async () => {
    const cfg = tmpConfig();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "hostout-elsewhere-"));
    fs.mkdirSync(path.join(cfg.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(cfg.workspace, ".host-out", "screens"));
    const r = await captureScreen({ displays, botId: "b", workspace: cfg.workspace, now: () => 1 });
    expect(r.path).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("uploads: staged at .host-out/uploads/<botId>/<name>, 0640 (bug #61: per-Bot)", () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.workspace, { recursive: true });
    const store = new AttachmentStore({ cfg });
    const data = Buffer.from("hello");
    const r = store.receive("b1", { id: "b1", uploadId: "u1", name: "a.txt", mime: "text/plain", size: data.length, offset: 0, chunkBase64: data.toString("base64"), final: true });
    expect(r.attachment!.boxPath).toBe(path.join(cfg.workspace, ".host-out", "uploads", "b1", "a.txt"));
    expect(fs.statSync(r.attachment!.boxPath!).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(path.join(cfg.workspace, "uploads"))).toBe(false);
  });

  it("a Read of a staged upload or a saved webhook body is fenced as outside content", () => {
    expect(shouldFence("Read", { file_path: "/workspace/.host-out/uploads/a.pdf" })).toBe(true);
    expect(shouldFence("Read", { file_path: "/workspace/.host-out/events/b1/x.json" })).toBe(true);
  });

  it("file-watch triggers never fire on host output", () => {
    expect(isAlwaysIgnored("/workspace/.host-out/uploads/a.pdf", "/workspace")).toBe(true);
    expect(isAlwaysIgnored("/workspace/.host-out/teach/t1/demo.mp4", "/workspace")).toBe(true);
  });
});
