// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRV } from "@synapse/shared";
import { CallFeelCard, acceleratorFrom, shortcutLabel } from "../../src/renderer/voice/CallFeelCard";

// Bug 134, Settings → Voice: join / leave sounds (item 8's mute option) and the call shortcut (item 9).

const invoked: [string, Record<string, unknown>][] = [];
let taken = false;
let lastMs: number | null = null;
let regressed = false;
beforeEach(() => {
  lastMs = null;
  regressed = false;
  invoked.length = 0;
  taken = false;
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "calls.sounds.get") return { ok: true, result: { on: true } };
        if (n === "voice.latency.last") return { ok: true, result: { firstAudioMs: lastMs, measured: lastMs === null ? 0 : 5, regressed } };
        if (n === "calls.shortcut.get") return { ok: true, result: { accelerator: "Alt+CommandOrControl+C" } };
        if (n === "calls.shortcut.set") return taken ? { ok: false, error: { code: "NATIVE_ERROR", message: STRV.callShortcutTaken } } : { ok: true, result: { accelerator: a.accelerator } };
        return { ok: true, result: {} };
      }),
      on: () => () => {},
    },
  };
});
afterEach(cleanup);

describe("Settings → Voice: call sounds and the call shortcut", () => {
  it("shows ⌥⌘C; the sounds switch mutes join / leave sounds", async () => {
    render(<CallFeelCard />);
    expect(await screen.findByRole("button", { name: STRV.callShortcut })).toHaveProperty("textContent", "⌥⌘C");
    const sw = screen.getByRole("switch", { name: STRV.callSounds });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(invoked).toContainEqual(["calls.sounds.set", { on: false }]);
  });

  it("'Keep voice ready' (about 800 MB) is on by default and can be turned off", async () => {
    render(<CallFeelCard />);
    const sw = await screen.findByRole("switch", { name: STRV.keepVoiceReady });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(STRV.keepVoiceReady).toMatch(/800 MB/);
    fireEvent.click(sw);
    expect(invoked).toContainEqual(["kokoro.keepReady.set", { on: false }]);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("records a new shortcut from a key press; a taken one shows why; it can be turned off", async () => {
    render(<CallFeelCard />);
    const field = await screen.findByRole("button", { name: STRV.callShortcut });
    fireEvent.click(field);
    expect(field.textContent).toBe(STRV.shortcutRecording);
    await act(async () => { fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true, altKey: true }); });
    expect(invoked).toContainEqual(["calls.shortcut.set", { accelerator: "Control+Alt+K" }]);
    expect(field.textContent).toBe("⌃⌥K");
    taken = true;
    fireEvent.click(field);
    await act(async () => { fireEvent.keyDown(field, { key: "x", code: "KeyX", metaKey: true, shiftKey: true }); });
    expect(screen.getByRole("alert").textContent).toBe(STRV.callShortcutTaken);
    taken = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRV.shortcutTurnOff })); });
    expect(invoked).toContainEqual(["calls.shortcut.set", { accelerator: null }]);
    expect(field.textContent).toBe(STRV.shortcutOff);
  });

  it("key → accelerator uses the physical key (⌥ changes the character), and waits past bare modifiers", () => {
    expect(acceleratorFrom({ key: "ç", code: "KeyC", metaKey: true, altKey: true, ctrlKey: false, shiftKey: false })).toBe("Alt+CommandOrControl+C");
    expect(acceleratorFrom({ key: "Meta", code: "MetaLeft", metaKey: true, altKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
    expect(shortcutLabel("Shift+CommandOrControl+9")).toBe("⇧⌘9");
  });
});

describe("5.8 Settings → Voice: the nightly voice check and the last call's reply time", () => {
  it("the nightly check is on by default and can be turned off", async () => {
    render(<CallFeelCard />);
    const sw = await screen.findByRole("switch", { name: STRV.voiceSelfTest });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(invoked).toContainEqual(["voice.selftest.set", { on: false }]);
  });

  it("shows the last call's first audio when a call timed one, and nothing before", async () => {
    render(<CallFeelCard />);
    await screen.findByRole("switch", { name: STRV.voiceSelfTest });
    expect(screen.queryByTestId("last-call-first-audio")).toBeNull();
    cleanup();
    lastMs = 1_840;
    render(<CallFeelCard />);
    const v = await screen.findByTestId("last-call-first-audio");
    expect(v.textContent).toBe("1.8 s");
    expect(v.getAttribute("data-regressed")).toBe("false"); // over the 1.2 s goal, but no alarm
    expect(v.style.color).toBe("var(--ink-muted)");
    expect(screen.getByText(STRV.lastCallFirstAudio)).toBeTruthy();
  });

  it("alarm styling only on a regression against the owner's own calls", async () => {
    lastMs = 2_900;
    regressed = true;
    render(<CallFeelCard />);
    const v = await screen.findByTestId("last-call-first-audio");
    expect(v.getAttribute("data-regressed")).toBe("true");
    expect(v.style.color).toBe("var(--danger-ink)");
  });
});
