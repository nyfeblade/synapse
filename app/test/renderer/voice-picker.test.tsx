// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { VoiceSection } from "../../src/renderer/components/settings/VoiceSection";
import { voiceOptions } from "../../src/renderer/voice/audio-devices";

// Bug 106: Settings → Voice picks the voice calls speak with, best quality first, with Preview
// and a way to download better voices.

const VOICES = [
  { id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", lang: "en-US", quality: "premium", siri: false, personal: false },
  { id: "com.apple.voice.enhanced.en-US.Samantha", name: "Samantha", lang: "en-US", quality: "enhanced", siri: false, personal: false },
  { id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", lang: "en-US", quality: "default", siri: false, personal: false },
];

function installBridge(chosen: string | null = null, voices = VOICES) {
  const invoked: [string, Record<string, unknown>][] = [];
  const results: Record<string, unknown> = { "audio.devices.list": { devices: [], prefs: { input: null, output: null } }, "audio.voices.list": { voices, chosen }, "audio.testSpeaker": { ok: true },
    // Bug 164: Qwen3 and the voice-quality control — this suite is about the Apple voices, so Qwen
    // is absent and the mode is the one that changes nothing.
    "qwen.status": { state: "missing", voices: [] }, "voiceMode.get": { mode: "full", memoryMb: 0, machineDefault: "full" } };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "audio.voice.set") return { ok: true, result: { voice: a.voice } };
        return { ok: true, result: results[n] ?? {} };
      }),
      on: () => () => {},
    },
  };
  return { invoked };
}

describe("voice options", () => {
  it("Automatic first (naming the voice it will use), then each voice with its quality", () => {
    expect(voiceOptions(VOICES as never)).toEqual([
      { value: "", label: STR5.voiceAutomatic("Zoe") },
      { value: "com.apple.voice.premium.en-US.Zoe", label: `Zoe · ${STR5.voiceQuality.premium}` },
      { value: "com.apple.voice.enhanced.en-US.Samantha", label: `Samantha · ${STR5.voiceQuality.enhanced}` },
      { value: "com.apple.voice.compact.en-US.Samantha", label: `Samantha · ${STR5.voiceQuality.default}` },
    ]);
  });
});

describe("Settings → Voice: the call voice", () => {
  afterEach(() => cleanup());

  it("lists the installed voices, saves a choice and previews the selected voice", async () => {
    const b = installBridge();
    render(<VoiceSection />);
    const sel = await screen.findByRole("combobox", { name: STR5.callVoice }) as HTMLSelectElement;
    await vi.waitFor(() => expect(sel.options).toHaveLength(4));
    fireEvent.change(sel, { target: { value: "com.apple.voice.enhanced.en-US.Samantha" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.voice.set", { voice: "com.apple.voice.enhanced.en-US.Samantha" }]));
    fireEvent.click(screen.getByRole("button", { name: STR5.previewVoice }));
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.testSpeaker", { voice: "com.apple.voice.enhanced.en-US.Samantha" }]));
    fireEvent.change(sel, { target: { value: "" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.voice.set", { voice: null }]));
  });

  it("says when only basic voices are installed, and links to download better ones", async () => {
    const b = installBridge(null, [VOICES[2]!]);
    render(<VoiceSection />);
    expect(await screen.findByText(STR5.onlyBasicVoices)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR5.downloadVoices }));
    await vi.waitFor(() => expect(b.invoked.some(([n]) => n === "audio.voices.openDownloads")).toBe(true));
  });
});
