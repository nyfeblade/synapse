// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRL } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";
import { useComposer } from "../../src/renderer/composer-store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

// The Carbon look's composer: the model and mode pills, and Send in the live accent.

describe("Composer: Send, and the model / mode pills", () => {
  let calls: [string, unknown][];
  beforeEach(() => {
    calls = installFakeBridge().calls;
    useComposer.setState({ byBot: {} });
    const bot = botFixture("b", "Piper");
    useUi.setState({ ...initialState(), bots: { b: { ...bot, profile: { ...bot.profile, model: "claude-opus-5" }, settings: { ...bot.settings, permMode: "full-auto" } } } } as never);
    try { localStorage.clear(); } catch { /* storage unavailable */ }
  });
  afterEach(cleanup);

  it("Send is inert until there is something to send, then sends the message", async () => {
    render(<Composer botId="b" name="Piper" running={false} />);
    const send = screen.getByRole("button", { name: STRL.send }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Piper" }), { target: { value: "hello" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(calls.some(([cmd, a]) => cmd === "sendPrompt" && (a as { text: string }).text === "hello")).toBe(true));
  });

  it("the pills say what will answer — the Bot's model and permission mode — and open its settings", () => {
    render(<Composer botId="b" name="Piper" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Opus 5" }));
    expect(useUi.getState().panel).toBe("settings");
    expect(screen.getByRole("button", { name: "Full auto" })).toBeTruthy();
  });
});
