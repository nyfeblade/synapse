import { describe, expect, it } from "vitest";
import { messageText } from "../../brain/types";
import { clockReminder, collectHiddenTurn, collectUserTurn, HIDDEN_MARKER, kickstartText, nudgeText, renderBotPrompt, restartResumeText, spawnKeyOf } from "../../runner/prompt-collector";
import { TEXT } from "../../review/texts";

const profile = { name: "Piper", title: "", description: "Keep answers short.", avatarShape: "pebble" as const, avatarColor: "#3472d9", avatarKind: "shape" as const };

describe("prompt collector", () => {
  it("renders the Bot prompt with profile, zone and teammates, byte-stable", () => {
    const p = { profile, timeZone: "America/New_York", workspace: "/workspace", teammates: [{ name: "Scout", title: "Research", description: "x".repeat(300) }], sections: { memory: "", skills: "" } };
    const a = renderBotPrompt(p);
    expect(a).toContain("You are Piper");
    expect(a).toContain("Bots' computer");
    expect(a).toContain("Keep answers short.");
    expect(a).toContain("America/New_York");
    expect(a).toContain(`- Scout — ${"x".repeat(120)}`);
    expect(renderBotPrompt(p)).toBe(a);
    expect(renderBotPrompt({ ...p, teammates: [] })).toContain("(none yet)");
    expect(renderBotPrompt({ ...p, teammates: [{ id: "g-1", name: "Pricing", title: "", description: "", group: { memberNames: ["Scout", "Ledger"] } }] })).toContain("- Pricing (id: g-1) (group) — members: Scout, Ledger");
  });

  it("never tells the Bot to write its own description; that's user-only (I7 ruling)", () => {
    const kick = kickstartText();
    const a = renderBotPrompt({ profile, timeZone: "UTC", workspace: "/workspace", teammates: [], sections: { memory: "", skills: "" } });
    for (const text of [a, kick]) {
      expect(text).not.toMatch(/write (your own|or rewrite your) description|name, label and description/);
      expect(text).toContain("Bot Settings");
    }
  });

  it("prepends every unconfirmed user message with its address and ends with the reply reminder (EVT-10, EVT-12, OUT-03)", () => {
    const msgs = [
      { kind: "message" as const, id: "t2u", role: "user" as const, content: "first", createdAt: 1 },
      { kind: "message" as const, id: "t3u", role: "user" as const, content: "second", createdAt: 2 },
    ];
    const out = collectUserTurn({
      messages: msgs.map((entry) => ({ entry, before: [], after: [] })),
      profileUpdate: "Your profile was updated: name \"Piper\".",
      blocks: [],
    });
    expect(out.map(messageText)).toEqual([
      "[t2u] first",
      "[t3u] second",
      "<system_reminder>Your profile was updated: name \"Piper\".</system_reminder>",
      expect.stringContaining("Answer this message by calling the SendMessage tool"),
    ]);
  });

  it("puts the clock on the turn, not in the cached system prompt (bug 50)", () => {
    // TurnRunner.decorate adds the clock to every turn (host/test/runner/clock.test.ts asserts what the
    // model sees); the collector must not add a second one, and the system prompt must carry none.
    const now = Date.UTC(2031, 2, 10, 18, 0);
    const clock = clockReminder(now, "UTC");
    expect(clock).toContain("2031-03-10 18:00");
    const turn = collectUserTurn({
      messages: [{ entry: { kind: "message", id: "t1u", role: "user", content: "hi", createdAt: 1 }, before: [], after: [] }],
      profileUpdate: null, blocks: [],
    });
    expect(turn.map(messageText).join("\n")).not.toMatch(/<system_reminder>Now: /);
    const sys = renderBotPrompt({ profile, timeZone: "UTC", workspace: "/workspace", teammates: [], sections: { memory: "", skills: "" } });
    expect(sys).not.toContain("2031-03-10");
    expect(sys).not.toMatch(/Now: /);
    expect(sys).not.toMatch(/Read the clock off the computer/);
  });

  it("marks hidden turns and quotes unsent text in nudges (EVT-04, §13.3)", () => {
    expect(messageText(collectHiddenTurn("do it")[0]!)).toBe(`${HIDDEN_MARKER}\ndo it`);
    expect(nudgeText("reply", "")).not.toContain("You wrote this");
    const n = nudgeText("reply", "a".repeat(700));
    expect(n).toContain(`You wrote this but never sent it: «${"a".repeat(600)}»`);
  });

  it("changes the spawn key only when spawn-time state changes (§16.2)", () => {
    const k = spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "t" });
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "t" })).toBe(k);
    expect(spawnKeyOf({ systemAppend: "B", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "t" })).not.toBe(k);
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "u" })).not.toBe(k);
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "t", effort: "low" }))
      .not.toBe(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], tokenHash: "t", effort: "max" }));
  });
});

// Gate M-1 (EVT-19): after a restart the Bot read the killed tool call as a rejection and stopped.
describe("restart resume texts (EVT-19, gate M-1)", () => {
  it("the resume wake says the interrupted tool call did not complete, was not declined, and must be re-run to finish", () => {
    const t = restartResumeText();
    expect(t).toMatch(/did NOT complete/);
    expect(t).toMatch(/NOT declined/);
    expect(t).toMatch(/re-run/i);
    expect(t).toMatch(/Auto-review/);
    expect(t).toMatch(/finish the task/i);
    expect(t).toContain("SendMessage");
  });

  it("the quiescing tool result doesn't read as a rejection", () => {
    expect(TEXT.quiescing).toMatch(/did NOT run/);
    expect(TEXT.quiescing).toMatch(/not declined/i);
    expect(TEXT.quiescing).toMatch(/re-run/i);
    expect(TEXT.quiescing).not.toMatch(/\b(rejected|denied|blocked)\b/i);
  });
});
