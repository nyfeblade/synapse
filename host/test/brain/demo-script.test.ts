import { describe, expect, it } from "vitest";
import { demoScript } from "../../brain/demo-script";

// Task 30 fuzz: the FUZZ Bot's greeting promised to write its own description, which the I7 / re-review item 7 rulings forbid.
describe("FUZZ demo greeting", () => {
  it("doesn't claim the Bot writes its own description", () => {
    const steps = demoScript({ prompt: [{ text: "hi" }], source: "kickstart" } as never, {} as never) as { input?: { content?: string } }[];
    const text = steps.map((s) => s.input?.content ?? "").join(" ");
    expect(text).toMatch(/^Hi! Tell me what you'd like help with/);
    expect(text).not.toMatch(/my own description/);
    expect(text).toMatch(/Bot Settings/);
  });
});
