import type { ComputerActionKind } from "@synapse/shared";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../../brain/types";
import type { SseHub } from "../../gateway/sse-hub";
import { ACT_KINDS, type ActInput, type PerceptionService } from "./service";

/**
 * Live perception tools (the "Live (beta)" computer mode). Served on the `computer` MCP server to a computerUse
 * subagent in place of the Computer tool. Schemas are kept tiny: every char here is re-sent on every model call.
 * Measured by host/test/computer/perception/tools.test.ts; the ceiling moves only by a decision.
 */
// Measured 2026-09-21: 1,169 chars (Look 332, Act 547, Screenshot 290) vs the Computer tool's 2,876.
export const LIVE_TOOLS_CHARS_CEILING = 1_250;

const KIND: Partial<Record<ActInput["do"], ComputerActionKind>> = { click: "click", double: "click", right: "click", select: "click", hover: "move", type: "type", key: "key", scroll: "scroll", drag: "drag" };

export function createPerceptionTools(d: { service(): Promise<PerceptionService>; botId: string; hub: SseHub; now(): number; index?(): number }): BotToolDef[] {
  const run = (name: string, fn: (s: PerceptionService) => Promise<BotToolResult>) => async (): Promise<BotToolResult> => {
    try {
      return await fn(await d.service());
    } catch (e) {
      return { text: `${name} failed: ${(e as Error).message}`, isError: true };
    }
  };
  return [
    {
      name: "Look",
      description: 'Your screen as text, one line per element: id role "name" states. query: ask about it (text, colours, a chart, "in e12") for a short answer. No image.',
      readOnly: true,
      schema: { query: z.string().optional() },
      handler: (a) => run("Look", (s) => s.look(typeof a.query === "string" ? a.query : undefined))(),
    },
    {
      name: "Act",
      description: 'Real mouse/keyboard on an element. on: id from Look or "x,y". text: what to type, keys (ctrl+s), option, "down 3", or file path. to: drop target. Returns what changed once the screen settles.',
      readOnly: false,
      schema: { do: z.enum(ACT_KINDS), on: z.string().optional(), text: z.string().optional(), to: z.string().optional() },
      handler: (a) => run("Act", async (s) => {
        const input = a as unknown as ActInput;
        const kind = KIND[input.do];
        if (kind) d.hub.publish({ channel: "computer-action", payload: { botId: d.botId, index: d.index?.() ?? 0, kind, x: null, y: null, at: d.now(), source: "computer" } });
        return s.act(input);
      })(),
    },
    {
      name: "Screenshot",
      description: 'Image of the screen, cropped to region ("x,y,w,h" or an id). Only for canvas, photos, colours or games.',
      readOnly: true,
      schema: { region: z.string().optional() },
      handler: (a) => run("Screenshot", (s) => s.screenshot(typeof a.region === "string" ? a.region : undefined))(),
    },
  ];
}
