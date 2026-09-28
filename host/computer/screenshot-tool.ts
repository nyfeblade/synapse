import type { BotToolDef } from "../brain/types";
import { captureScreen } from "./capture";
import type { DisplayManager } from "./displays";

/** TOOL-01 Screenshot: the main Bot's read-only view of its own screen (BRW-01). */
export function createScreenshotTool(o: { botId: string; displays: DisplayManager; workspace: string; now(): number }): BotToolDef {
  return {
    name: "Screenshot",
    description: "Take a read-only screenshot of your screen on the computer (1280×800). You cannot click or type yourself; use mcp__bot__Task with subagent_type computerUse or browserUse for that.",
    readOnly: true,
    schema: {},
    handler: async () => {
      try {
        const c = await captureScreen({ displays: o.displays, botId: o.botId, workspace: o.workspace, now: o.now });
        const saved = c.path ? `Saved to ${c.path}.` : "It could not be saved to disk.";
        return { text: `Screenshot of your screen (${c.display}, 1280×800). ${saved}`, images: [{ data: c.webp.toString("base64"), mimeType: "image/webp" }] };
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  };
}
