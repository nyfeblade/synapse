// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessageEntry } from "@synapse/shared";
import { call, callQuiet } from "../../src/renderer/bridge";
import { FollowupsToggle } from "../../src/renderer/components/FollowupsToggle";
import { Reactions } from "../../src/renderer/components/Reactions";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";
import { readSrc } from "./read-src";

// PRIMITIVE 2 — a rejected write is reported by DEFAULT, at the call() boundary.
//
// THE DEFECT: `call()` handed back a bare promise, and 19 gateway writes did `void call(...)` with
// no catch. A failed write was an unhandled rejection: the switch did not move, nothing appeared
// anywhere, and the click was indistinguishable from one that worked. Sidebar.tsx already renders
// `actionError` as a role="alert" banner and AdvancedSettingsCard.tsx names the pattern in a
// comment — it was just never applied generally. It is now the default; silence takes callQuiet().


/** A bridge whose `cmd` comes back as a gateway error, like a host that rejected the write. */
function installFailingBridge(cmd: string, message: string) {
  const h = installFakeBridge();
  const real = window.synapse.call;
  (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (c: string, args: unknown) => {
    if (c === cmd) return { ok: false, error: { code: "GATEWAY_ERROR", message } };
    return (real as (c: string, a: unknown) => Promise<unknown>)(c, args);
  });
  return h;
}

beforeEach(() => {
  useUi.setState({ ...initialState(), settings: settingsFixture() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a forgotten write is no longer silent", () => {
  it("FollowupsToggle: a rejected toggle puts the reason in the sidebar's alert banner", async () => {
    installFailingBridge("setAgentFollowups", "Could not reach the computer");
    useUi.setState({
      bots: { a: botFixture("a", "Planner") },
      settings: { ...settingsFixture(), advancedEnabled: true },
    });
    render(<><Sidebar /><FollowupsToggle botId="a" /></>);
    fireEvent.click(screen.getByRole("switch", { name: /follow-ups/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("Reactions: a rejected reaction says so instead of leaving a chip that does nothing", async () => {
    installFailingBridge("reactToMessage", "Reaction rejected by the host");
    const entry = { kind: "message", id: "e1", content: "hi", createdAt: 0, reactions: [{ emoji: "👍", by: "user" }] } as unknown as UserMessageEntry;
    useUi.setState({ bots: { a: botFixture("a", "Planner") } });
    render(<><Sidebar /><Reactions botId="a" entry={entry} /></>);
    fireEvent.click(screen.getByRole("button", { name: /👍/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reaction rejected by the host");
  });
});

describe("call() — the boundary contract", () => {
  it("routes a rejection into the error channel and still rejects, so awaiting callers are unchanged", async () => {
    installFailingBridge("setAgentFollowups", "host said no");
    await expect(call("setAgentFollowups", { id: "a", enabled: true })).rejects.toThrow("host said no");
    expect(useUi.getState().actionError).toBe("host said no");
  });

  it("a fire-and-forget write is observed internally, so it is no longer an unhandled rejection", async () => {
    installFailingBridge("setAgentFollowups", "host said no");
    // The whole point: `void call(...)` must not escape to the platform as an unhandled rejection.
    // If it did, this very test file would be reported by vitest as an unhandled error.
    void call("setAgentFollowups", { id: "a", enabled: true });
    await waitFor(() => expect(useUi.getState().actionError).toBe("host said no"));
  });

  it("leaves the channel alone when the write succeeds", async () => {
    installFakeBridge();
    useUi.setState({ actionError: null });
    await call("setAgentFollowups", { id: "a", enabled: true });
    expect(useUi.getState().actionError).toBeNull();
  });

  it("callQuiet() is the explicit opt-out: it reports nothing and still rejects", async () => {
    installFailingBridge("getOnboarding", "box is still booting");
    await expect(callQuiet("getOnboarding", {})).rejects.toThrow("box is still booting");
    expect(useUi.getState().actionError, "callQuiet must not touch the channel").toBeNull();
  });
});

describe("the channel is actually wired", () => {
  it("store.ts registers the sink that puts a reported failure into actionError", () => {
    const src = readSrc("store.ts");
    expect(src).toMatch(/setErrorSink/);
    expect(src).toMatch(/actionError/);
  });

  it("the boot probes use callQuiet, so a host killed mid-connect raises no banner", () => {
    const app = readSrc("App.tsx");
    for (const cmd of ["getForeverBoxStatus", "getDiskPressure", "getOnboarding"]) {
      expect(app, `${cmd} must opt out explicitly`).toMatch(new RegExp(`callQuiet\\("${cmd}"`));
    }
    // getDisplays moved behind loadDisplays() for bug 36. The claim is unchanged and is still
    // checked — it must be a callQuiet, wherever it now lives — so the banner stays suppressed.
    expect(app, "App.tsx must still fire the displays probe on connect").toMatch(/loadDisplays\(\)/);
    expect(readSrc("computer-state.ts"), "getDisplays must still opt out explicitly").toMatch(/callQuiet\("getDisplays"/);
  });

  it("getDisplays raises no banner but no longer throws the failure away either (bug 36)", () => {
    // The banner was the right thing to suppress; "no feedback anywhere" was not. `callQuiet` is
    // still the call, and the rejection is now RECORDED for the screen surfaces to render in place.
    // Without this, "quiet" silently widens back into "silent" — which is the defect itself.
    const src = readSrc("computer-state.ts");
    expect(src).not.toMatch(/callQuiet\("getDisplays"[\s\S]{0,200}?\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    expect(src, "a failed getDisplays must be recorded").toMatch(/setDisplaysLoad\("failed"/);
  });
});
