import { describe, expect, it } from "vitest";
import { SkillLibrary } from "../../skills/library";
import { createSkillToolExtension } from "../../skills/skill-tool";
import { makeRunnerHarness } from "../runner/harness";

describe("save a skill in chat (SKL-02)", () => {
  it("writes SKILL.md and adds a skill-saved event row", async () => {
    const h = await makeRunnerHarness({
      toolExtensionsFactory: (bots, cfg) => createSkillToolExtension({ library: new SkillLibrary({ cfg }), bots, now: Date.now }),
      script: () => [
        { tool: "mcp__bot__update_state", input: { target: "workflow", action: "write", name: "Weekly report", description: "Use this when the user asks for the weekly report.", body: "1. Pull numbers\n2. Draft\n3. Ask before sending" } },
        { tool: "mcp__bot__SendMessage", input: { content: "Saved it as a skill." } },
      ],
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "Save the process we used as a skill called Weekly report", "n1");
    await h.untilIdle(id);
    const lib = new SkillLibrary({ cfg: h.cfg });
    expect(lib.read("weekly-report")!.file.description).toBe("Use this when the user asks for the weekly report.");
    const ev = h.bots.tail(id, 20).find((e) => e.kind === "event" && e.event.type === "skill-saved");
    expect(ev).toMatchObject({ event: { type: "skill-saved", skillId: "weekly-report", name: "Weekly report" } });
  });

  it("rejects an invalid skill with the validation text", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const ext = createSkillToolExtension({ library: new SkillLibrary({ cfg: h.cfg }), bots: h.bots, now: Date.now });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const r = await ext.updateState!.workflow!({ botId: id, slot: null, args: { target: "workflow", action: "write", name: "X", description: "", body: "b" }, now: Date.now });
    expect(r).toEqual({ text: 'Not saved — A skill needs a description (start it with "Use this when…").', isError: true });
  });
});
