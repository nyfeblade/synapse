import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureScreen } from "../../computer/capture";
import type { DisplayManager } from "../../computer/displays";
import { tmpConfig } from "../helpers";

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16, 1)]);
function fakeDisplays() {
  return {
    ensure: async (botId: string) => ({ botId, index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 }),
    x: () => ({ screenshotWebp: async () => WEBP }),
  } as unknown as DisplayManager;
}

// Controller ruling: captureScreen must not follow a Bot-controlled symlink as bothost. It now
// writes through the shared writeHostOwnedFile (O_EXCL|O_NOFOLLOW, host-owned dir, mode 0644 so the
// Bot can still read its own screenshots back), the same technique webhook-server.ts uses for
// oversized bodies under /workspace/.bot/events.
describe("captureScreen never writes a screenshot through a symlinked screens directory", () => {
  it("refuses to write, leaves the swapped-to directory untouched, and still returns the webp/dataUrl", async () => {
    const cfg = tmpConfig();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "capture-elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "vault.key"), "SECRET");
    fs.mkdirSync(path.join(cfg.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(cfg.workspace, ".host-out", "screens"));
    const r = await captureScreen({ displays: fakeDisplays(), botId: "b", workspace: cfg.workspace, now: () => 1234 });
    expect(r.path).toBeNull();
    expect(r.webp).toEqual(WEBP);
    expect(r.dataUrl).toBe(`data:image/webp;base64,${WEBP.toString("base64")}`);
    expect(fs.readdirSync(elsewhere)).toEqual(["vault.key"]);
    expect(fs.readFileSync(path.join(elsewhere, "vault.key"), "utf8")).toBe("SECRET");
  });

  it("writes the screenshot host-owned (mode 0644, readable by the Bot) and self-heals a group-writable per-bot dir", async () => {
    const cfg = tmpConfig();
    const dir = path.join(cfg.workspace, ".host-out", "screens", "b");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777); // force past umask, so the self-heal below is actually exercised
    const r = await captureScreen({ displays: fakeDisplays(), botId: "b", workspace: cfg.workspace, now: () => 1234 });
    expect(r.path).toBe(path.join(dir, "1234.webp"));
    expect(fs.statSync(r.path!).mode & 0o777).toBe(0o640);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });
});
