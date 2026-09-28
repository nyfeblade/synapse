// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRV } from "@synapse/shared";
import { CallFeelCard } from "../../src/renderer/voice/CallFeelCard";
import { VOICE_PAUSE_MS, pauseMsFor } from "../../src/renderer/voice/sentences";

// Bug 224 (the user's decision, plan item 14): question endings are flat on Kokoro too. The bug-151 ramp (+4 st over
// the last 350 ms) was the DSP behind the question glitches of bugs 161/190, so it is gone for every voice, and a "?"
// is paced like a "." — no switch left that would bring it back.

afterEach(cleanup);

describe("bug 224: flat question endings on every voice", () => {
  it("a question gets the full stop's pause", () => {
    expect(VOICE_PAUSE_MS.question).toBe(VOICE_PAUSE_MS.period);
    expect(pauseMsFor("Shall I deploy it?")).toBe(pauseMsFor("Shall I deploy it."));
  });

  it("Settings → Voice no longer offers 'Natural question intonation'", async () => {
    (window as unknown as { synapse: unknown }).synapse = {
      native: { invoke: vi.fn(async (n: string) => ({ ok: true, result: n === "calls.shortcut.get" ? { accelerator: null } : { on: true } })), on: () => () => {} },
    };
    const r = render(<CallFeelCard />);
    await vi.waitFor(() => expect(r.container.querySelector(".call-feel-card")).not.toBeNull());
    expect(r.queryByText("Natural question intonation")).toBeNull();
  });
});
