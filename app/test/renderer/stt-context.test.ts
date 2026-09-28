import { describe, expect, it } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { STT_RECENT_MESSAGES, sttContextFor } from "../../src/renderer/voice/stt-context";

// Bug 162: the renderer assembles what the recognizer should expect to hear.

const bot = (id: string, name: string) => [id, { id, profile: { name } } as unknown as BotSummary] as const;
const msg = (id: string, content: string): TranscriptEntry =>
  ({ kind: "message", id, role: "user", content, createdAt: 1 }) as TranscriptEntry;

describe("sttContextFor", () => {
  it("puts every Bot's name in", () => {
    const bots = Object.fromEntries([bot("a", "Nova"), bot("b", "Disk Saver")]);
    expect(sttContextFor(bots, {}, null)).toEqual(["Nova", "Disk Saver"]);
  });

  it("adds the open chat's own vocabulary after the names", () => {
    const bots = Object.fromEntries([bot("a", "Nova")]);
    const transcripts = { a: [msg("1", "OrbStack is slow"), msg("2", "restart OrbStack")] };
    expect(sttContextFor(bots, transcripts, "a")).toEqual(["Nova", "OrbStack"]);
  });

  it("mines only the chat that is open", () => {
    const bots = Object.fromEntries([bot("a", "Nova")]);
    const transcripts = { a: [msg("1", "Kokoro"), msg("2", "Kokoro")], b: [msg("3", "OrbStack"), msg("4", "OrbStack")] };
    expect(sttContextFor(bots, transcripts, "a")).toEqual(["Nova", "Kokoro"]);
  });

  it("mines nothing when no chat is open", () => {
    const bots = Object.fromEntries([bot("a", "Nova")]);
    expect(sttContextFor(bots, { a: [msg("1", "Kokoro"), msg("2", "Kokoro")] }, null)).toEqual(["Nova"]);
  });

  it("looks only at the recent messages", () => {
    const bots = {};
    const old = Array.from({ length: STT_RECENT_MESSAGES }, (_, i) => msg(`o${i}`, "filler word here"));
    const transcripts = { a: [msg("x1", "Kokoro"), msg("x2", "Kokoro"), ...old] };
    expect(sttContextFor(bots, transcripts, "a")).toEqual([]);
  });

  it("ignores an entry that is not a message", () => {
    const transcripts = { a: [{ kind: "tool_call", id: "t1" } as unknown as TranscriptEntry, msg("1", "Kokoro"), msg("2", "Kokoro")] };
    expect(sttContextFor({}, transcripts, "a")).toEqual(["Kokoro"]);
  });

  it("does not repeat a Bot name the chat also mentions", () => {
    const bots = Object.fromEntries([bot("a", "Kokoro")]);
    const transcripts = { a: [msg("1", "Kokoro"), msg("2", "Kokoro")] };
    expect(sttContextFor(bots, transcripts, "a")).toEqual(["Kokoro"]);
  });

  it("survives a Bot with no profile name", () => {
    const bots = { a: { id: "a" } as unknown as BotSummary };
    expect(sttContextFor(bots, {}, null)).toEqual([]);
  });

  it("says nothing when it knows nothing", () => {
    expect(sttContextFor({}, {}, null)).toEqual([]);
  });
});
