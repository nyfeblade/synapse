// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { VoiceSettings } from "../../src/renderer/voice/VoiceSettings";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Cloned voices (F5) join the one picker as their own section, above the natural and Apple
// ones. A Bot with no cloned voice sees exactly what it saw before.

const APPLE = [{ id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", lang: "en-US", quality: "premium", siri: false, personal: false }];
const NATURAL = [{ id: "af_heart", name: "Heart", accent: "American", gender: "female" }];
const CLONED = [
  { id: "my-voice", name: "My voice", createdAt: "2026-09-20T10:00:00.000Z", scriptId: "asks" },
  { id: "studio", name: "Studio", createdAt: "2026-09-21T10:00:00.000Z", scriptId: "story" },
];

function installBridge(clips: unknown[], saved: string | null = null) {
  const calls: [string, Record<string, unknown>][] = [];
  const results: Record<string, unknown> = {
    "audio.devices.list": { devices: [], prefs: { input: null, output: null } },
    "audio.voices.list": { voices: APPLE, chosen: null },
    "kokoro.status": { state: "ready", voices: NATURAL },
    "voice.clips.list": { voices: clips },
    "audio.testSpeaker": { ok: true },
    // Bug 164: this suite is about the cloned voices, so Qwen3 is absent and the mode changes nothing.
    "qwen.status": { state: "missing", voices: [] },
    "voiceMode.get": { mode: "full", memoryMb: 0, machineDefault: "full" },
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { calls.push([n, a]); return { ok: true, result: results[n] ?? {} }; }),
      on: () => () => {},
    },
  };
  useUi.setState({
    ...initialState,
    bots: { b1: { id: "b1", profile: { name: "Nova" }, settings: saved ? { voice: saved } : {} } },
  } as never);
  return { calls };
}

const options = (sel: HTMLElement) => Array.from(sel.querySelectorAll("option")).map((o) => o.textContent);

describe("the voice picker with cloned voices", () => {
  afterEach(() => cleanup());

  it("lists saved cloned voices in their own section, above the natural ones", async () => {
    installBridge(CLONED);
    render(<VoiceSettings botId="b1" />);
    const sel = await screen.findByLabelText(STR5.voice);
    await waitFor(() => expect(sel.querySelector(`optgroup[label="${STR5.clonedVoices}"]`)).toBeTruthy());
    const group = sel.querySelector(`optgroup[label="${STR5.clonedVoices}"]`)!;
    expect(within(group as HTMLElement).getByText("My voice")).toBeTruthy();
    expect(within(group as HTMLElement).getByText("Studio")).toBeTruthy();
    expect((within(group as HTMLElement).getByText("My voice") as HTMLOptionElement).value).toBe("f5:my-voice");
    // and it comes before the natural section
    const labels = Array.from(sel.querySelectorAll("optgroup")).map((g) => g.getAttribute("label"));
    expect(labels.indexOf(STR5.clonedVoices)).toBeLessThan(labels.indexOf(STR5.naturalVoices));
  });

  it("a Bot with no cloned voice sees the picker exactly as before", async () => {
    installBridge([]);
    render(<VoiceSettings botId="b1" />);
    const sel = await screen.findByLabelText(STR5.voice);
    await waitFor(() => expect(sel.querySelector(`optgroup[label="${STR5.naturalVoices}"]`)).toBeTruthy());
    expect(sel.querySelector(`optgroup[label="${STR5.clonedVoices}"]`)).toBeNull();
    expect(options(sel)).toContain("Heart · American");
  });

  it("keeps a saved cloned voice selected rather than calling it missing", async () => {
    installBridge(CLONED, "f5:studio");
    render(<VoiceSettings botId="b1" />);
    const sel = await screen.findByLabelText(STR5.voice) as HTMLSelectElement;
    await waitFor(() => expect(sel.value).toBe("f5:studio"));
    expect(options(sel)).not.toContain(STR5.savedVoiceNotInstalled);
  });

  it("says a cloned voice has gone when its recording was deleted", async () => {
    installBridge([], "f5:gone");
    render(<VoiceSettings botId="b1" />);
    const sel = await screen.findByLabelText(STR5.voice);
    await waitFor(() => expect(options(sel)).toContain(STR5.savedVoiceNotInstalled));
  });

  it("states what a cloned voice costs, in one plain line", async () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never }); // new-user walk finding 8: advanced controls
    installBridge(CLONED);
    render(<VoiceSettings botId="b1" />);
    // UI polish pass (brief 2): the cost is a value in the "Memory while loaded" group.
    await waitFor(() => expect(screen.getByRole("group", { name: STR5.voiceMemory }).textContent).toContain(STR5.memoryCloned));
    expect(STR5.clonedEngineNote).toMatch(/2 GB/);
    expect(STR5.clonedEngineNote).toMatch(/1\.4 GB/);
  });
});
