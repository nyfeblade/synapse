import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { createComputerTool } from "../../computer/computer-tool";
import type { DisplayManager } from "../../computer/displays";
import { SseHub } from "../../gateway/sse-hub";
import { tmpConfig } from "../helpers";

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

function setup(enforce = true) {
  const cfg = tmpConfig();
  const calls: string[] = [];
  const touched: number[] = [];
  const displays = {
    ensure: async () => ({ botId: "b", index: 4, display: ":4", cdpPort: 9226, running: true, generation: 1 }),
    touch: () => touched.push(1),
    x: () => ({
      xdotool: async (a: string[]) => { calls.push(a.join(" ")); return ""; },
      cursor: async () => ({ x: 640, y: 400 }),
      screenshotWebp: async () => WEBP,
    }),
  } as unknown as DisplayManager;
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const slept: number[] = [];
  const tool = createComputerTool({ botId: "b", displays, hub, workspace: cfg.workspace, enforce: () => enforce, now: () => 77, sleep: async (ms) => { slept.push(ms); } });
  return { tool, calls, events, slept, touched };
}

describe("Computer tool (BRW-03)", () => {
  it("runs the action and its then-steps, settles 2 s once, appends a screenshot, reports the cursor", async () => {
    const s = setup();
    const r = await s.tool.handler({ action: "click", x: 100, y: 200, description: "Open Sign in", then: [{ action: "wait", durationMs: 300 }, { action: "scroll", direction: "down", amount: 2 }] });
    expect(s.calls).toEqual(["mousemove --sync 100 200", "click --repeat 1 --delay 80 1", "click --repeat 2 --delay 40 5"]);
    expect(s.slept).toEqual([300, 2000]);
    expect(s.touched.length).toBe(3);
    expect(r.text).toMatch(/^Done on the box desktop\. Screenshot saved to .*\/\.host-out\/screens\/b\/77\.webp\. Pointer at \(640, 400\)\.$/);
    expect(r.images?.[0]?.mimeType).toBe("image/webp");
    expect(s.events.filter((e) => e.channel === "computer-action").map((e) => (e.payload as { kind: string }).kind)).toEqual(["click", "scroll"]);
  });

  it("a plain screenshot neither settles nor emits an event", async () => {
    const s = setup();
    const r = await s.tool.handler({ action: "screenshot" });
    expect(s.slept).toEqual([]);
    expect(s.events.filter((e) => e.channel === "computer-action")).toEqual([]);
    expect(r.images).toHaveLength(1);
  });

  it("returns validation errors as tool errors without touching the display", async () => {
    const s = setup(true);
    const r = await s.tool.handler({ action: "click", x: 5, y: 5 });
    expect(r).toEqual({ text: "Add a description of what this click or drag is for (Auto-review needs it), then retry.", isError: true });
    expect(s.calls).toEqual([]);
  });

  it("reports the screenshot couldn't be saved (rather than a literal \"null\") when the screens dir is a symlink", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(path.join(cfg.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "computer-tool-elsewhere-")), path.join(cfg.workspace, ".host-out", "screens"));
    const displays = {
      ensure: async () => ({ botId: "b", index: 4, display: ":4", cdpPort: 9226, running: true, generation: 1 }),
      touch: () => {},
      x: () => ({ xdotool: async () => "", cursor: async () => ({ x: 0, y: 0 }), screenshotWebp: async () => WEBP }),
    } as unknown as DisplayManager;
    const tool = createComputerTool({ botId: "b", displays, hub: new SseHub(), workspace: cfg.workspace, enforce: () => true, now: () => 1 });
    const r = await tool.handler({ action: "screenshot" });
    expect(r.text).not.toContain("null");
    expect(r.text).toContain("could not be saved to disk");
  });

  it("passes the mcpfix tools/list pattern (never z.record(), served fine over MCP)", async () => {
    const s = setup();
    const server = toSdkMcpServer({ botTools: () => [s.tool] } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["Computer"]);
    } finally {
      await client.close();
    }
  });
});
