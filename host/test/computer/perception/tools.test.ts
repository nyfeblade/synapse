import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SseEvent } from "@synapse/shared";
import { createComputerTool } from "../../../computer/computer-tool";
import type { DisplayManager } from "../../../computer/displays";
import { LIVE_TOOLS_CHARS_CEILING, createPerceptionTools } from "../../../computer/perception/tools";
import type { PerceptionService } from "../../../computer/perception/service";
import { SseHub } from "../../../gateway/sse-hub";

/** Same wire measure as host/test/perf/prompt-budget.test.ts, on the `computer` server. */
function wire(t: { name: string; description: string; schema: Record<string, unknown> }): number {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(z.object(t.schema as never), { io: "input" })));
  return JSON.stringify({ name: `mcp__computer__${t.name}`, description: t.description, input_schema: schema }).length;
}

function fakeService(calls: string[], fail = false) {
  return {
    look: async (q?: string) => { calls.push(`look ${q ?? ""}`.trim()); if (fail) throw new Error("CDP went away"); return { text: "view" }; },
    act: async (a: unknown) => { calls.push(`act ${JSON.stringify(a)}`); return { text: "diff\nsettled" }; },
    screenshot: async (r?: string) => { calls.push(`shot ${r ?? ""}`.trim()); return { text: "s", images: [{ data: "", mimeType: "image/webp" }] }; },
  } as unknown as PerceptionService;
}

describe("Live perception tools", () => {
  it("are Look, Act and Screenshot with tiny schemas, well under the Computer tool's", () => {
    const tools = createPerceptionTools({ service: async () => fakeService([]), botId: "b", hub: new SseHub(), now: () => 1 });
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([["Look", true], ["Act", false], ["Screenshot", true]]);
    const live = tools.reduce((s, t) => s + wire(t as never), 0);
    const displays = {} as DisplayManager;
    const computer = wire(createComputerTool({ botId: "b", displays, hub: new SseHub(), workspace: "/tmp", enforce: () => true, now: () => 1 }) as never);
    process.stdout.write(`live tool schemas ${live} chars (Look ${wire(tools[0] as never)}, Act ${wire(tools[1] as never)}, Screenshot ${wire(tools[2] as never)}); Computer ${computer} chars\n`);
    expect(live, `Look+Act+Screenshot schemas (${live} chars)`).toBeLessThan(LIVE_TOOLS_CHARS_CEILING);
    expect(live).toBeLessThan(computer);
  });

  it("delegate to the display's service, publish the act for the preview cursor, and turn failures into tool errors", async () => {
    const calls: string[] = [];
    const hub = new SseHub();
    const events: SseEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const [look, act, shot] = createPerceptionTools({ service: async () => fakeService(calls), botId: "b", hub, now: () => 5 });
    expect((await look!.handler({})).text).toBe("view");
    await look!.handler({ query: "the red button" });
    expect((await act!.handler({ do: "click", on: "e3" })).text).toBe("diff\nsettled");
    expect((await shot!.handler({ region: "0,0,10,10" })).images).toHaveLength(1);
    expect(calls).toEqual(["look", "look the red button", 'act {"do":"click","on":"e3"}', "shot 0,0,10,10"]);
    expect(events.filter((e) => e.channel === "computer-action").map((e) => (e.payload as { kind: string }).kind)).toEqual(["click"]);
    const [broken] = createPerceptionTools({ service: async () => fakeService([], true), botId: "b", hub, now: () => 5 });
    expect(await broken!.handler({})).toEqual({ text: "Look failed: CDP went away", isError: true });
  });
});
