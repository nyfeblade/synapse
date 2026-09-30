import { LIMITSC, type ScreenView } from "@synapse/shared";
import type { BotToolDef } from "../brain/types";
import type { SseHub } from "../gateway/sse-hub";
import { sleep as realSleep } from "../util/sleep";
import { captureScreen } from "./capture";
import { SETTLE_ACTIONS, computerSchema, eventFor, planAction, validateComputer, type ComputerInput } from "./computer-actions";
import type { DisplayManager } from "./displays";
import { readScreenText, type ScreenReader } from "./screen-read";
import { NATIVE_VIEW, isNative, toView } from "./screen-view";

export interface ComputerToolDeps {
  botId: string; displays: DisplayManager; hub: SseHub; workspace: string;
  enforce(): boolean; now(): number; sleep?(ms: number): Promise<void>;
  /** The screen as the model sees it (its screenshots' size and its coordinate space); default the display, 1:1. */
  view?: ScreenView;
  /** A model that can't read images: every result carries a text read of the screen instead of a screenshot. */
  textOnly?: { reader(): Promise<ScreenReader> };
}

export function computerDescription(v: ScreenView, textOnly: boolean): string {
  const seen = textOnly
    ? "The result is a text read of the screen (elements and OCR text, each with its centre point); call ReadScreen for a fresh read."
    : `A final screenshot (${v.w}×${v.h}) is always returned.`;
  return `Act on your screen (${v.w}×${v.h}): screenshot, click, double_click, move, drag, type, key (xdotool names), scroll, wait. Batch up to 9 follow-up steps in \`then\` (no screenshot inside \`then\`). ${seen} Coordinates must stay inside 0..${v.w - 1} × 0..${v.h - 1}. Give every click and drag a short \`description\` of its purpose.`;
}

/**
 * BRW-03: served on the `computer` MCP server (T13), so the model sees it as mcp__computer__Computer. The same tool,
 * provider-neutral, runs a Claude child and a provider child: only the view (coordinate scale) and whether the result
 * is a screenshot or a text read differ.
 */
export function createComputerTool(d: ComputerToolDeps): BotToolDef {
  const sleep = d.sleep ?? ((ms: number) => realSleep(ms));
  const view = d.view ?? NATIVE_VIEW;
  return {
    name: "Computer",
    description: computerDescription(view, !!d.textOnly),
    readOnly: false,
    schema: computerSchema,
    handler: async (args) => {
      const a = args as unknown as ComputerInput;
      const invalid = validateComputer(a, { enforce: d.enforce(), view });
      if (invalid) return { text: invalid, isError: true };
      try {
        const info = await d.displays.ensure(d.botId);
        const x = d.displays.x(d.botId);
        let mutated = false;
        for (const s of [a, ...(a.then ?? [])]) {
          d.displays.touch(d.botId);
          for (const st of planAction(s, view)) {
            if ("xdotool" in st) await x.xdotool(st.xdotool);
            else await sleep(st.sleepMs);
          }
          const ev = eventFor(s, view);
          if (ev) d.hub.publish({ channel: "computer-action", payload: { botId: d.botId, index: info.index, ...ev, at: d.now(), source: "computer" } });
          if (SETTLE_ACTIONS.has(s.action)) mutated = true;
        }
        if (mutated) await sleep(LIMITSC.settleMs);
        const raw = await x.cursor();
        const c = toView(view, raw.x, raw.y);
        if (d.textOnly) {
          const screen = await readScreenText(await d.textOnly.reader(), view);
          return { text: `Done on the box desktop. Pointer at (${c.x}, ${c.y}).\n${screen}` };
        }
        const shot = await captureScreen({ displays: d.displays, botId: d.botId, workspace: d.workspace, now: d.now, ...(isNative(view) ? {} : { size: view }) });
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
