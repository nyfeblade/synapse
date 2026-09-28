import { describe, expect, it } from "vitest";
import {
  VOICE_ENGINE_MEMORY_MB, VOICE_MODE_FACTS, defaultVoiceMode, engineOfVoice, enginesInMode,
  availableFromVmStat, isVoiceMode, resolveVoiceMode, shouldDropToLight, voiceBlockedByMode,
} from "../src/voice-mode";

const GiB = 1024 ** 3;
const roomy = { totalBytes: 64 * GiB, freeBytes: 40 * GiB };

describe("the voice mode a machine starts on (bug 164)", () => {
  it("gives a 16 GB Mac Light, and a bigger one Full", () => {
    expect(defaultVoiceMode({ totalBytes: 8 * GiB, freeBytes: 6 * GiB })).toBe("light");
    expect(defaultVoiceMode({ totalBytes: 16 * GiB, freeBytes: 12 * GiB })).toBe("light");
    expect(defaultVoiceMode({ totalBytes: 18 * GiB, freeBytes: 12 * GiB })).toBe("full");
    expect(defaultVoiceMode({ totalBytes: 36 * GiB, freeBytes: 20 * GiB })).toBe("full");
  });

  it("gives a big Mac whose memory is already tight Light, not Full", () => {
    expect(defaultVoiceMode({ totalBytes: 64 * GiB, freeBytes: 2 * GiB })).toBe("light");
  });

  it("assumes a small machine when the memory figures can't be read", () => {
    expect(defaultVoiceMode({ totalBytes: 0, freeBytes: 0 })).toBe("light");
    expect(defaultVoiceMode({ totalBytes: Number.NaN, freeBytes: 40 * GiB })).toBe("light");
  });

  it("lets the user's saved choice override the machine, in both directions", () => {
    // The whole point of the setting: a 16 GB Mac may choose Full, a 64 GB Mac may choose Light.
    expect(resolveVoiceMode("full", { totalBytes: 16 * GiB, freeBytes: 8 * GiB })).toBe("full");
    expect(resolveVoiceMode("light", roomy)).toBe("light");
  });

  it("falls back to the machine's default when nothing valid is saved", () => {
    for (const saved of [undefined, null, "", "medium", 3, {}]) {
      expect(resolveVoiceMode(saved, roomy)).toBe("full");
      expect(resolveVoiceMode(saved, { totalBytes: 8 * GiB, freeBytes: 4 * GiB })).toBe("light");
    }
  });

  it("only accepts the two modes that exist", () => {
    expect(isVoiceMode("light")).toBe(true);
    expect(isVoiceMode("full")).toBe(true);
    for (const v of ["Light", "FULL", "auto", "", null, undefined, 1]) expect(isVoiceMode(v)).toBe(false);
  });
});

describe("dropping to Light mid-call", () => {
  it("drops Full when free memory goes under the floor", () => {
    expect(shouldDropToLight("full", 0.5 * GiB)).toBe(true);
  });

  it("leaves a healthy Full call alone", () => {
    expect(shouldDropToLight("full", 8 * GiB)).toBe(false);
  });

  it("never fires on Light — there is nothing further to drop to", () => {
    expect(shouldDropToLight("light", 0.1 * GiB)).toBe(false);
  });

  it("does nothing when the figure is unreadable rather than guessing", () => {
    expect(shouldDropToLight("full", Number.NaN)).toBe(false);
  });
});

describe("which engines a mode may load", () => {
  it("holds Light to Kokoro and Apple", () => {
    expect([...enginesInMode("light")].sort()).toEqual(["apple", "kokoro"]);
  });

  it("lets Full load everything", () => {
    expect([...enginesInMode("full")].sort()).toEqual(["apple", "f5", "kokoro", "qwen"]);
  });

  it("reads the engine off a saved voice value", () => {
    expect(engineOfVoice("qwen3:vivian")).toBe("qwen");
    expect(engineOfVoice("kokoro:af_heart")).toBe("kokoro");
    expect(engineOfVoice("f5:my-voice")).toBe("f5");
    expect(engineOfVoice("com.apple.voice.premium.en-US.Ava")).toBe("apple");
    expect(engineOfVoice("")).toBe(null);
    expect(engineOfVoice(undefined)).toBe(null);
  });
});

describe("a Bot whose voice the mode can't load", () => {
  it("blocks a Qwen and a cloned voice on Light", () => {
    expect(voiceBlockedByMode("qwen3:vivian", "light")).toBe(true);
    expect(voiceBlockedByMode("f5:my-voice", "light")).toBe(true);
  });

  it("never blocks Kokoro or Apple, which Light is built on", () => {
    expect(voiceBlockedByMode("kokoro:af_heart", "light")).toBe(false);
    expect(voiceBlockedByMode("com.apple.voice.premium.en-US.Ava", "light")).toBe(false);
  });

  it("blocks nothing at all on Full", () => {
    for (const v of ["qwen3:vivian", "f5:my-voice", "kokoro:af_heart", "com.apple.voice.premium.en-US.Ava"]) {
      expect(voiceBlockedByMode(v, "full")).toBe(false);
    }
  });

  it("has no opinion about a Bot with no voice set", () => {
    expect(voiceBlockedByMode(null, "light")).toBe(false);
  });
});

describe("what the control tells the user", () => {
  it("counts Kokoro into Full as well — it still speaks every reply's first sentence", () => {
    expect(VOICE_MODE_FACTS.light.memoryMb).toBe(VOICE_ENGINE_MEMORY_MB.kokoro);
    expect(VOICE_MODE_FACTS.full.memoryMb).toBe(
      VOICE_ENGINE_MEMORY_MB.kokoro + VOICE_ENGINE_MEMORY_MB.qwen + VOICE_ENGINE_MEMORY_MB.whisper,
    );
  });

  it("quotes the same time to the first word for both, because Kokoro says it either way", () => {
    expect(VOICE_MODE_FACTS.full.firstWordMs).toBe(VOICE_MODE_FACTS.light.firstWordMs);
  });

  it("says Full costs more memory, which is the reason the control exists", () => {
    expect(VOICE_MODE_FACTS.full.memoryMb).toBeGreaterThan(VOICE_MODE_FACTS.light.memoryMb);
  });
});

describe("what counts as available memory on macOS", () => {
  // Real `vm_stat` from this Mac (2026-09-24) while a call kept dropping to Light: "free" was 0.9 GB,
  // under the 1.5 GB floor, but 8+ GB sat in inactive/purgeable pages macOS hands back instantly.
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                    54875.",
    "Pages active:                                 558562.",
    "Pages inactive:                               525672.",
    "Pages speculative:                               410.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             285026.",
    "Pages purgeable:                               16757.",
  ].join("\n");

  it("counts free + inactive + speculative + purgeable pages, not just free", () => {
    const bytes = availableFromVmStat(sample);
    expect(bytes).toBe((54875 + 525672 + 410 + 16757) * 16384);
    expect(shouldDropToLight("full", bytes!)).toBe(false);
  });

  it("returns null for output it can't read, so the caller falls back", () => {
    expect(availableFromVmStat("")).toBeNull();
    expect(availableFromVmStat("Pages free: 12.")).toBeNull(); // no page size line
  });
});
