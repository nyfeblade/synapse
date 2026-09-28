import { describe, expect, it } from "vitest";
import { demoScript } from "../../brain/demo-script";
import { FakeBrain } from "../../brain/fake-brain";
import type { TurnEvent } from "../../brain/types";
import { input, testWiring } from "./helpers";

// Task 34 (fuzz pass, LOC-06 lifecycle journey): the FUZZ Bot relays what a tool returned, so an
// E2E can see that the "unavailable" text actually reached the Bot.
describe("FUZZ demo: relaying a tool result", () => {
  it("a relayLastToolOutput step sends the previous tool's output as a message", async () => {
    const events: TurnEvent[] = [];
    const b = new FakeBrain("bot1", testWiring(), () => [
      { tool: "Bash", input: { command: "ls" }, output: "Your computer \"Mac\" can't be reached — it seems to be offline." },
      { relayLastToolOutput: true },
    ]);
    await b.runTurn(input(), (e) => events.push(e));
    const sends = events.filter((e): e is Extract<TurnEvent, { kind: "tool_start" }> => e.kind === "tool_start" && e.name === "mcp__bot__SendMessage");
    expect(sends.map((e) => e.input.content)).toEqual(["Your computer \"Mac\" can't be reached — it seems to be offline."]);
  });

  it("\"local-wait: <cmd>\" waits long enough for the LOC-06 watchdog and relays the result", () => {
    const steps = demoScript({ ...input(), prompt: [{ type: "text", text: "local-wait: sleep 120" }] } as never, { turnIndex: 0 });
    const shell = steps.find((s) => "tool" in s && s.tool === "mcp__bot__ExternalShell") as unknown as { input: { command: string; block_ms: number } };
    expect(shell.input.command).toBe("sleep 120");
    expect(shell.input.block_ms).toBeGreaterThanOrEqual(90_000);
    expect(steps.some((s) => "relayLastToolOutput" in s)).toBe(true);
  });
});
