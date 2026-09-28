// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { VoiceSettings } from "../../src/renderer/voice/VoiceSettings";

// Bug 157: the engine a Bot speaks with is picked per Bot in Settings → Voice, and the Apple half of
// that picker is the HELPER's own voice list (ids, every quality, Siri bundles) — not the page's
// speechSynthesis list, which has no Siri voices and one entry per name. What is picked is what a
// CALL speaks: the helper gets that exact identifier, Kokoro Ready or not.

const AARON = "com.apple.ttsbundle.siri_Aaron_en-US_premium";
const AVA_P = "com.apple.voice.premium.en-US.Ava";
const AVA_E = "com.apple.voice.enhanced.en-US.Ava";
const APPLE = [
  { id: AARON, name: "Aaron", lang: "en-US", quality: "premium", siri: true, personal: false },
  { id: AVA_P, name: "Ava", lang: "en-US", quality: "premium", siri: false, personal: false },
  { id: AVA_E, name: "Ava", lang: "en-US", quality: "enhanced", siri: false, personal: false },
  { id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", lang: "en-US", quality: "default", siri: false, personal: false },
];
const NATURAL = [{ id: "af_heart", name: "Heart", accent: "American" }, { id: "bm_george", name: "George", accent: "British" }];

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];

function installBridge(kokoro: Record<string, unknown> = { state: "ready", voices: NATURAL }, voices: unknown[] = APPLE) {
  subs.clear(); invoked.length = 0;
  // The page's own voices are deliberately a different, smaller list: nothing may come from here.
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    getVoices: () => [{ name: "Samantha", lang: "en-US" }], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t1u", agent: {} } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        const r: Record<string, unknown> = { "dictation.speak": { spoken: true }, "audio.voices.list": { voices, chosen: null }, "kokoro.status": kokoro,
          // Bug 164: Qwen3 absent, and the voice mode that blocks nothing.
          "qwen.status": { state: "missing", voices: [] }, "voiceMode.get": { mode: "full", memoryMb: 0, machineDefault: "full" } };
        return { ok: true, result: r[n] ?? {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
}

const setBots = (bots: Record<string, unknown>) => useUi.setState({ ...initialState(), bots } as never);
const bot = (id: string, name: string, settings: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings, ...over });

describe("Settings → Voice: the per-Bot engine choice (bug 157)", () => {
  beforeEach(() => installBridge());
  afterEach(() => cleanup());

  const picker = async () => {
    const sel = screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
    await vi.waitFor(() => expect(sel.querySelectorAll("optgroup")).toHaveLength(2));
    return sel;
  };

  it("offers the natural voices and the HELPER's Apple voices — ids, each quality, Siri included", async () => {
    setBots({ a: bot("a", "Planner", { voice: null, speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    const groups = [...sel.querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual([STR5.naturalVoices, STR5.appleVoices]);
    const apple = within(groups[1] as HTMLElement).getAllByRole("option") as HTMLOptionElement[];
    expect(apple.map((o) => o.value)).toEqual(APPLE.map((v) => v.id));
    expect(apple.map((o) => o.textContent)).toEqual([
      `Aaron (Siri) · ${STR5.voiceQuality.premium}`, `Ava · ${STR5.voiceQuality.premium}`,
      `Ava · ${STR5.voiceQuality.enhanced}`, `Samantha · ${STR5.voiceQuality.default}`,
    ]);
    expect(sel.options[0]!.textContent).toBe(STR5.notSet);
    // The page's own voice list (one bare "Samantha") never reaches the picker.
    expect(apple.some((o) => o.value === "Samantha")).toBe(false);
  });

  it("saves the helper's identifier, so Premium Ava can't be confused with Enhanced Ava", async () => {
    setBots({ a: bot("a", "Planner", { voice: null, speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    fireEvent.change(sel, { target: { value: AVA_P } });
    await vi.waitFor(() => expect(window.synapse.call).toHaveBeenCalledWith("setAgentVoice", { id: "a", voice: AVA_P }));
    fireEvent.change(sel, { target: { value: AARON } });
    await vi.waitFor(() => expect(window.synapse.call).toHaveBeenCalledWith("setAgentVoice", { id: "a", voice: AARON }));
  });

  it("an older saved value (a bare name) still resolves — to the best voice of that name", async () => {
    setBots({
      a: bot("a", "Planner", { voice: "Ava", speechRate: 1, spokenLanguage: null }),
      b: bot("b", "Courier", { voice: AARON, speechRate: 1, spokenLanguage: null }),
    });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    expect(sel.value).toBe(AVA_P);
    expect([...sel.options].find((o) => o.value === AARON)!.title).toBe(STR5.usedBy("Courier"));
  });

  it("Apple voices are Premium first, then Enhanced, then the rest, however they arrive", async () => {
    installBridge({ state: "ready", voices: NATURAL }, [APPLE[3], APPLE[2], APPLE[1], APPLE[0]]);
    setBots({ a: bot("a", "Planner", { voice: null, speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    const groups = [...sel.querySelectorAll("optgroup")];
    expect((within(groups[1] as HTMLElement).getAllByRole("option") as HTMLOptionElement[]).map((o) => o.value))
      .toEqual([AVA_P, AARON, AVA_E, "com.apple.voice.compact.en-US.Samantha"]);
    // Every curated Kokoro voice is offered too — one picker, both engines.
    expect((within(groups[0] as HTMLElement).getAllByRole("option") as HTMLOptionElement[]).map((o) => o.value))
      .toEqual(NATURAL.map((v) => `kokoro:${v.id}`));
  });

  it("Preview plays the same line through the engine the chosen voice belongs to", async () => {
    setBots({ a: bot("a", "Planner", { voice: "kokoro:bm_george", speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    const play = async () => fireEvent.click(await screen.findByRole("button", { name: STR5.previewVoice }));
    await play();
    await vi.waitFor(() => expect(invoked).toContainEqual(["audio.testSpeaker", { voice: "kokoro:bm_george" }]));
    fireEvent.change(sel, { target: { value: AVA_P } });
    act(() => useUi.setState({ bots: { a: bot("a", "Planner", { voice: AVA_P, speechRate: 1, spokenLanguage: null }) } } as never));
    await play();
    await vi.waitFor(() => expect(invoked).toContainEqual(["audio.testSpeaker", { voice: AVA_P }]));
  });

  it("nothing chosen: Preview plays what a call would actually give this Bot — a natural voice", async () => {
    setBots({ a: bot("a", "Planner", { voice: null, speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    await picker();
    fireEvent.click(screen.getByRole("button", { name: STR5.previewVoice }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.testSpeaker")).toBe(true));
    const played = invoked.find(([n]) => n === "audio.testSpeaker")![1].voice;
    expect(NATURAL.map((v) => `kokoro:${v.id}`)).toContain(played);
  });

  it("says what each engine costs, and links to macOS's own voice downloads", async () => {
    setBots({ a: bot("a", "Planner", { voice: null, speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    await picker();
    // UI polish pass (brief 2): a labelled group of label + value rows, not a paragraph.
    const group = screen.getByRole("group", { name: STR5.voiceMemory });
    expect(group.textContent).toContain(STR5.memoryNatural);
    expect(group.textContent).toContain(STR5.memoryApple);
    expect(screen.getByRole("button", { name: STR5.downloadVoices })).toBeTruthy();
    // The Voice row itself stays exactly the shape of the Speed and Language rows below it: a label
    // and the dropdown, nothing else (defect 2 — a select plus a button doesn't fit a 320px panel).
    const row = screen.getByRole("combobox", { name: "Voice" }).closest(".settings-row")!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.children).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: STR5.downloadVoices }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.openDownloads")).toBe(true));
  });

  it("a saved voice this Mac no longer has says so, instead of quietly reading Not set", async () => {
    setBots({ a: bot("a", "Planner", { voice: "com.apple.voice.premium.en-US.Gone", speechRate: 1, spokenLanguage: null }) });
    render(<VoiceSettings botId="a" />);
    const sel = await picker();
    expect(sel.value).toBe("com.apple.voice.premium.en-US.Gone");
    expect(sel.selectedOptions[0]!.textContent).toBe(STR5.savedVoiceNotInstalled);
  });
});

describe("a call speaks with the voice that was picked (bug 157)", () => {
  afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

  const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
  const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
  const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);

  async function callAndSay(saved: string | null, kokoro: Record<string, unknown>) {
    installBridge(kokoro);
    setBots({ a: bot("a", "Planner", { voice: saved, speechRate: 1, spokenLanguage: null }) });
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    await act(async () => {}); // the voice lists land
    fire({ type: "final", text: "hello" });
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t2a", createdAt: 3, message: { type: "text", content: "All set." } }] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    return spoken()[0]!;
  }

  it("an Apple Premium voice reaches the helper as that exact identifier, Kokoro Ready or not", async () => {
    expect(await callAndSay(AVA_P, { state: "ready", voices: NATURAL })).toMatchObject({ text: "All set.", voice: AVA_P });
    cleanup(); act(() => useVoice.getState().close());
    expect(await callAndSay(AARON, { state: "missing", voices: [] })).toMatchObject({ voice: AARON });
  });

  it("a Kokoro choice still reaches the helper as its Kokoro voice", async () => {
    expect(await callAndSay("kokoro:bm_george", { state: "ready", voices: NATURAL })).toMatchObject({ voice: "kokoro:bm_george" });
  });

  it("an older saved bare name is still sent (the helper resolves it to that name's best voice)", async () => {
    expect(await callAndSay("Ava", { state: "ready", voices: NATURAL })).toMatchObject({ voice: "Ava" });
  });

  it("a group call can mix the engines: each Bot speaks in its own voice, in its own seat", async () => {
    installBridge();
    setBots({
      g: bot("g", "Team", {}, { group: { memberIds: ["n", "l"] } }),
      n: bot("n", "Nova", { voice: "kokoro:bm_george", speechRate: 1, spokenLanguage: null }),
      l: bot("l", "Ledger", { voice: AVA_P, speechRate: 1, spokenLanguage: null }),
    });
    useVoice.getState().open("g");
    render(<VoiceOverlay botId="g" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    await act(async () => {});
    fire({ type: "final", text: "hi all" });
    act(() => useUi.setState({ transcripts: { g: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "n" }, message: { type: "text", content: "Nova here." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "l" }, message: { type: "text", content: "Ledger here." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    fire({ type: "speak-end", id: spoken()[0]!.id, interrupted: false });
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[0]).toMatchObject({ voice: "kokoro:bm_george" });
    expect(spoken()[1]).toMatchObject({ voice: AVA_P });
    // Bug 134 / 213: the seats still apply — mixing the engines doesn't flatten the call.
    expect(typeof spoken()[0]!.azimuth).toBe("number");
    expect(spoken()[0]!.azimuth).not.toBe(spoken()[1]!.azimuth);
    expect(spoken().map((s) => s.seat)).toEqual(["n", "l"]);
  });
});
