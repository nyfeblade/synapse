import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureScreen } from "../../computer/capture";
import { createScreenshotTool } from "../../computer/screenshot-tool";
import type { DisplayManager } from "../../computer/displays";
import { tmpConfig } from "../helpers";

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16, 1)]);

function fakeDisplays(ensured: string[]) {
  return {
    ensure: async (botId: string) => { ensured.push(botId); return { botId, index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 }; },
    x: () => ({ screenshotWebp: async () => WEBP }),
  } as unknown as DisplayManager;
}

describe("Screenshot (TOOL-01)", () => {
  it("captures lazily (ensure), saves a WebP under /workspace/.bot/screens/<bot>/ and returns it as an image block", async () => {
    const cfg = tmpConfig();
    const ensured: string[] = [];
    const tool = createScreenshotTool({ botId: "bot-a", displays: fakeDisplays(ensured), workspace: cfg.workspace, now: () => 1234 });
    expect(tool).toMatchObject({ name: "Screenshot", readOnly: true });
    const r = await tool.handler({});
    const file = path.join(cfg.workspace, ".host-out", "screens", "bot-a", "1234.webp");
    expect(ensured).toEqual(["bot-a"]);
    expect(fs.readFileSync(file)).toEqual(WEBP);
    expect(r.text).toBe(`Screenshot of your screen (:2, 1280×800). Saved to ${file}.`);
    expect(r.images).toEqual([{ data: WEBP.toString("base64"), mimeType: "image/webp" }]);
  });

  it("keeps only the newest 200 captures per Bot", async () => {
    const cfg = tmpConfig();
    let t = 0;
    for (let i = 0; i < 203; i++) await captureScreen({ displays: fakeDisplays([]), botId: "b", workspace: cfg.workspace, now: () => ++t });
    const files = fs.readdirSync(path.join(cfg.workspace, ".host-out", "screens", "b"));
    expect(files).toHaveLength(200);
    expect(files).not.toContain("1.webp");
    expect(files).toContain("203.webp");
  });

  it("returns the screen-full text as a tool error instead of throwing", async () => {
    const cfg = tmpConfig();
    const displays = { ensure: async () => { throw new Error("All of the shared computer's desktop screens are taken."); } } as unknown as DisplayManager;
    const r = await createScreenshotTool({ botId: "b", displays, workspace: cfg.workspace, now: () => 1 }).handler({});
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/^All of the shared computer's desktop screens/);
  });

  it("reports the screenshot couldn't be saved (rather than a literal \"null\") when the screens dir is a symlink (controller ruling: never follow a Bot-controlled symlink as bothost)", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(path.join(cfg.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-tool-elsewhere-")), path.join(cfg.workspace, ".host-out", "screens"));
    const r = await createScreenshotTool({ botId: "bot-a", displays: fakeDisplays([]), workspace: cfg.workspace, now: () => 1234 }).handler({});
    expect(r.text).not.toContain("null");
    expect(r.text).toBe("Screenshot of your screen (:2, 1280×800). It could not be saved to disk.");
    expect(r.images).toEqual([{ data: WEBP.toString("base64"), mimeType: "image/webp" }]);
  });
});
