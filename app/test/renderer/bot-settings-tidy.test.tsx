// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRB, STRMA, STR5 } from "@synapse/shared";
import { BrowserRow } from "../../src/renderer/components/BrowserRow";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { speechVoices, type VoiceView } from "../../src/renderer/voice/audio-devices";
import { botFixture, installFakeBridge } from "./fake-bridge";

beforeEach(() => {
  installFakeBridge({ getLocalBrowserAllowed: { allowed: false } });
  useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, connection: { kind: "connected" } } as never);
});
afterEach(cleanup);

const v = (id: string, name: string): VoiceView => ({ id, name, lang: "en-US", quality: "default" } as VoiceView);

describe("new-user walk finding 21: Bot settings", () => {
  it("the 'May use … on your Mac' rows are a label and a right-hand switch, no subtitle", async () => {
    render(<BrowserRow botId="a" />);
    await screen.findByRole("switch", { name: STRB.setting });
    expect(document.body.textContent).not.toContain(STRB.settingHelp);
    const row = document.querySelector('[data-setting="mac-browser"]') as HTMLElement;
    expect(row.style.flexWrap).not.toBe("wrap");
    expect(STRMA.settingHelp).toBeTruthy();
  });

  it("the voice list leaves out novelty voices and the Eloquence character voices", () => {
    const list = [v("com.apple.voice.premium.en-US.Ava", "Ava"), v("com.apple.speech.synthesis.voice.Bells", "Bells"), v("com.apple.speech.synthesis.voice.BadNews", "Bad News"), v("com.apple.eloquence.en-US.Grandma", "Grandma"), v("com.apple.speech.synthesis.voice.Zarvox", "Zarvox"), v("com.apple.voice.compact.en-GB.Daniel", "Daniel")];
    expect(speechVoices(list).map((x) => x.name)).toEqual(["Ava", "Daniel"]);
    // the Bot's own saved voice always stays, whatever it is
    expect(speechVoices(list, "com.apple.speech.synthesis.voice.Bells").map((x) => x.name)).toEqual(["Ava", "Bells", "Daniel"]);
  });

  it("Permission mode's explanation is not a visible subtitle", async () => {
    const { BotSettingsPanel } = await import("../../src/renderer/components/BotSettingsPanel");
    render(<BotSettingsPanel botId="a" />);
    await screen.findByRole("combobox", { name: STR5.permMode });
    expect(document.body.textContent).not.toContain(STR5.permModeAskHelp);
  });
});
