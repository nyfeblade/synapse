import { describe, expect, it } from "vitest";
import { createVoiceModule } from "../../voice/module";

describe("setAgentVoice (BOT-24)", () => {
  it("validates speed and language, stores voice settings", async () => {
    const saved: unknown[] = [];
    const m = createVoiceModule({ bots: { updateSettings: (id: string, p: unknown) => { saved.push([id, p]); return { id }; } } } as never);
    await m.handlers.setAgentVoice!({ id: "b", voice: "Samantha", speechRate: 1.25, spokenLanguage: "en-US" });
    expect(saved).toEqual([["b", { voice: "Samantha", speechRate: 1.25, spokenLanguage: "en-US" }]]);
    await m.handlers.setAgentVoice!({ id: "b", voice: null, spokenLanguage: null });
    expect(saved[1]).toEqual(["b", { voice: null, spokenLanguage: null }]);
    await expect(Promise.resolve().then(() => m.handlers.setAgentVoice!({ id: "b", speechRate: 3 }))).rejects.toThrow(/Speed/);
    await expect(Promise.resolve().then(() => m.handlers.setAgentVoice!({ id: "b", spokenLanguage: "english!!" }))).rejects.toThrow(/Language/);
  });
});

describe("noteVoiceCall (voice calls)", () => {
  it("writes 'Voice call started' and 'Voice call ended · 3m 12s' markers into the chat", async () => {
    const appended: [string, { kind: string; text: string }][] = [];
    let n = 0;
    const bots = { has: (id: string) => id === "b", auxEntryIds: (_id: string, k: number) => Array.from({ length: k }, () => `x${++n}`), appendEntry: (id: string, e: { kind: string; text: string }) => { appended.push([id, e]); } };
    const m = createVoiceModule({ bots } as never);
    await m.handlers.noteVoiceCall!({ id: "b", phase: "started" });
    await m.handlers.noteVoiceCall!({ id: "b", phase: "ended", durationMs: 192_400 });
    expect(appended.map(([id, e]) => [id, e.kind, e.text])).toEqual([["b", "notice", "Voice call started"], ["b", "notice", "Voice call ended · 3m 12s"]]);
    await expect(Promise.resolve().then(() => m.handlers.noteVoiceCall!({ id: "b", phase: "paused" as never }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => m.handlers.noteVoiceCall!({ id: "nope", phase: "started" }))).rejects.toThrow();
  });
});
