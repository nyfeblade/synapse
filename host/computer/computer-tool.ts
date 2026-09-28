import { LIMITSC } from "@synapse/shared";
import type { BotToolDef } from "../brain/types";
import type { SseHub } from "../gateway/sse-hub";
import { sleep as realSleep } from "../util/sleep";
import { captureScreen } from "./capture";
import { SETTLE_ACTIONS, computerSchema, eventFor, planAction, validateComputer, type ComputerInput } from "./computer-actions";
import type { DisplayManager } from "./displays";

export interface ComputerToolDeps {
  botId: string; displays: DisplayManager; hub: SseHub; workspace: string;
  enforce(): boolean; now(): number; sleep?(ms: number): Promise<void>;
}

/** BRW-03: served on the `computer` MCP server (T13), so the model sees it as mcp__computer__Computer. */
export function createComputerTool(d: ComputerToolDeps): BotToolDef {
  const sleep = d.sleep ?? ((ms: number) => realSleep(ms));
  return {
    name: "Computer",
    description:
      "Act on your screen (1280×800): screenshot, click, move, drag, type, key (xdotool names), scroll, wait. Batch up to 9 follow-up steps in `then` (no screenshot inside `then`); a final screenshot is always returned. Coordinates must stay inside 0..1279 × 0..799. Give every click and drag a short `description` of its purpose.",
    readOnly: false,
    schema: computerSchema,
    handler: async (args) => {
      const a = args as unknown as ComputerInput;
      const invalid = validateComputer(a, { enforce: d.enforce() });
      if (invalid) return { text: invalid, isError: true };
      try {
        const info = await d.displays.ensure(d.botId);
        const x = d.displays.x(d.botId);
        let mutated = false;
        for (const s of [a, ...(a.then ?? [])]) {
          d.displays.touch(d.botId);
          for (const st of planAction(s)) {
            if ("xdotool" in st) await x.xdotool(st.xdotool);
            else await sleep(st.sleepMs);
          }
          const ev = eventFor(s);
          if (ev) d.hub.publish({ channel: "computer-action", payload: { botId: d.botId, index: info.index, ...ev, at: d.now(), source: "computer" } });
          if (SETTLE_ACTIONS.has(s.action)) mutated = true;
        }
        if (mutated) await sleep(LIMITSC.settleMs);
        const shot = await captureScreen({ displays: d.displays, botId: d.botId, workspace: d.workspace, now: d.now });
        const c = await x.cursor();
        const saved = shot.path ? `Screenshot saved to ${shot.path}.` : "The screenshot could not be saved to disk.";
        return {
          text: `Done on the box desktop. ${saved} Pointer at (${c.x}, ${c.y}).`,
          images: [{ data: shot.webp.toString("base64"), mimeType: "image/webp" }],
        };
      } catch (e) {
        return { text: `Computer action failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
