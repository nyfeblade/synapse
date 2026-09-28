// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { VoiceSection } from "../../src/renderer/components/settings/VoiceSection";
import { VoiceSettings } from "../../src/renderer/voice/VoiceSettings";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Bug 107: Settings → Voice shows whether the natural (Kokoro) voices are available, lists them
// above the Apple voices with Preview, and makes Kokoro the default when it is Ready.

const APPLE = [{ id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", lang: "en-US", quality: "premium", siri: false, personal: false }];
const NATURAL = [
  { id: "af_heart", name: "Heart", accent: "American", gender: "female" },
  { id: "bm_george", name: "George", accent: "British", gender: "male" },
];

function installBridge(kokoro: Record<string, unknown>, chosen: string | null = null) {
  const invoked: [string, Record<string, unknown>][] = [];
  const results: Record<string, unknown> = {
    "audio.devices.list": { devices: [], prefs: { input: null, output: null } }, "audio.voices.list": { voices: APPLE, chosen },
    "audio.testSpeaker": { ok: true }, "kokoro.status": kokoro,
    // Bug 164: this suite is about Kokoro, so Qwen3 is absent and the mode changes nothing.
    "qwen.status": { state: "missing", voices: [] }, "voiceMode.get": { mode: "full", memoryMb: 0, machineDefault: "full" },
  };
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

describe("Settings → Voice: natural voices (bug 107)", () => {
  afterEach(() => cleanup());

  it("Ready: says so, lists the Kokoro voices above the Apple ones, and saves / previews one", async () => {
    const b = installBridge({ state: "ready", voices: NATURAL });
    render(<VoiceSection />);
    await screen.findByText(STR5.naturalStatus.ready);
    expect(screen.getByText(STR5.naturalStatusLabel)).toBeTruthy();
    const sel = await screen.findByRole("combobox", { name: STR5.callVoice }) as HTMLSelectElement;
    await vi.waitFor(() => expect(sel.querySelectorAll("optgroup")).toHaveLength(2));
    const groups = [...sel.querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual([STR5.naturalVoices, STR5.appleVoices]);
    expect(within(groups[0] as HTMLElement).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["kokoro:af_heart", "kokoro:bm_george"]);
    expect(within(groups[0] as HTMLElement).getByText(STR5.naturalVoiceLabel("George", "British"))).toBeTruthy();
    // Automatic means Kokoro while it is Ready.
    expect(sel.options[0]!.textContent).toBe(STR5.naturalAutomatic);
    fireEvent.change(sel, { target: { value: "kokoro:bm_george" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.voice.set", { voice: "kokoro:bm_george" }]));
    fireEvent.click(screen.getByRole("button", { name: STR5.previewVoice }));
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.testSpeaker", { voice: "kokoro:bm_george" }]));
  });

  it("Bot settings: a Bot's voice can be a natural one (its override), above the Apple voices", async () => {
    installBridge({ state: "ready", voices: NATURAL });
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [{ name: "Samantha", lang: "en-US" }], addEventListener: () => {}, removeEventListener: () => {} };
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner" }, settings: { voice: "kokoro:bm_george", speechRate: 1, spokenLanguage: null } } } as never });
    render(<VoiceSettings botId="a" />);
    const sel = screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
    await vi.waitFor(() => expect(sel.querySelectorAll("optgroup")).toHaveLength(2));
    expect([...sel.querySelectorAll("optgroup")].map((g) => g.label)).toEqual([STR5.naturalVoices, STR5.appleVoices]);
    expect(sel.value).toBe("kokoro:bm_george");
    fireEvent.change(sel, { target: { value: "kokoro:af_heart" } });
    await vi.waitFor(() => expect(window.synapse.call).toHaveBeenCalledWith("setAgentVoice", { id: "a", voice: "kokoro:af_heart" }));
  });

  it("Not found: says so, and only the Apple voices are offered", async () => {
    installBridge({ state: "missing", voices: NATURAL, reason: "No Kokoro Python and model were found." });
    render(<VoiceSection />);
    await screen.findByText(STR5.naturalStatus.missing);
    const sel = await screen.findByRole("combobox", { name: STR5.callVoice }) as HTMLSelectElement;
    await vi.waitFor(() => expect(sel.options).toHaveLength(2));
    expect(sel.querySelector("optgroup")).toBeNull();
    expect(sel.options[0]!.textContent).toBe(STR5.voiceAutomatic("Zoe"));
  });
});
