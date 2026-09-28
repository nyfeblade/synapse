import { describe, expect, it } from "vitest";
import { demoScript } from "../../brain/demo-script";
import type { TurnInput } from "../../brain/types";

// Task 50 fuzz: the FUZZ brain can hold a routine run or a group member turn in flight, so abuse cases
// (delete / kill the host / change members mid-run) have something running to interrupt.
const input = (source: string, text: string) => ({ source, prompt: [{ text }], systemAppend: "You are Planner, a persistent assistant" }) as unknown as TurnInput;

describe("demoScript slow steps (FUZZ)", () => {
  it("a routine whose prompt says 'slowly' waits 4 s before reporting", () => {
    expect(demoScript(input("routine", 'Routine "Sweep" fired.\nDo it slowly'), { turnIndex: 0 })).toEqual([
      { wait: 4000 },
      { tool: "mcp__bot__SendMessage", input: { content: "Routine ran: Sweep" } },
    ]);
  });

  it("a group post that says 'slowly' makes the member turn wait 4 s before posting", () => {
    expect(demoScript(input("group-member", "[Group chat: G]\nUser: slowly plan a trip\nIt's your turn"), { turnIndex: 0 })[0]).toEqual({ wait: 4000 });
  });

  it("other routine and group turns stay instant", () => {
    expect(demoScript(input("routine", 'Routine "Sweep" fired.'), { turnIndex: 0 })[0]).not.toHaveProperty("wait");
    expect(demoScript(input("group-member", "User: plan a trip\nIt's your turn"), { turnIndex: 0 })[0]).not.toHaveProperty("wait");
  });

  it("a member passes only on a take posted after the latest user message, so later room turns get a fresh take", () => {
    const later = "[Group chat: G]\nUser: plan a trip\nScout: Here's a first take: plan a trip\nUser: pick a date\nIt's your turn";
    expect(demoScript(input("group-member", later), { turnIndex: 0 })).toEqual([{ tool: "mcp__bot__SendMessage", input: { content: "Here's a first take: pick a date" } }]);
    const same = "[Group chat: G]\nUser: pick a date\nScout: Here's a first take: pick a date\nIt's your turn";
    expect(demoScript(input("group-member", same), { turnIndex: 0 })).toEqual([{ tool: "mcp__bot__SendMessage", input: { content: "(pass)" } }]);
  });
});
