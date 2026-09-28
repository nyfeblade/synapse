// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesSection } from "../../src/renderer/components/settings/UpdatesSection";
import { accountMenuItems } from "../../src/renderer/components/account-menu";
import { useUpdates } from "../../src/renderer/updates/store";

const invoked: string[] = [];
let state = { version: "0.2.0", track: "stable", auto: false, feed: "alex/bots", status: "none", latest: null, error: null } as Record<string, unknown>;
beforeEach(() => {
  invoked.length = 0;
  useUpdates.setState({ state: null });
  (window as unknown as { synapse: unknown }).synapse = { call: async () => ({ ok: true, result: {} }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string) => { invoked.push(n); return { ok: true, result: state }; }), on: () => () => {} } };
});
afterEach(cleanup);

describe("Settings → Updates (SET-12)", () => {
  it("shows track, automatic updates (off), version and Check for Updates", async () => {
    render(<UpdatesSection />);
    expect(await screen.findByText("Version 0.2.0")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Update Track" }) as HTMLSelectElement).options[0]!.textContent).toBe("Stable");
    expect(screen.getByRole("switch", { name: "Automatic Updates" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
    await vi.waitFor(() => expect(invoked).toContain("updates.check"));
  });

  it("offers Restart to Update when an update is ready", async () => {
    state = { ...state, status: "ready", latest: "0.3.0" };
    render(<UpdatesSection />);
    expect(await screen.findByText("Synapse 0.3.0 is ready. Restart to apply.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart to Update" }));
    await vi.waitFor(() => expect(invoked).toContain("updates.restart"));
  });

  // Fix round 1, finding 2: the account-menu badge must reflect a background auto-check/download
  // (registerUpdater's 6-hour tick) even when the user never mounted Settings → Updates in this
  // session — so setting the shared store directly (no render of UpdatesSection at all) must be
  // enough for the "New update available" item to appear, the same way weekly-usage reads
  // useUsage.getState() live rather than a render-local variable.
  it("shows the account-menu badge from a background update without Settings → Updates ever mounting", () => {
    const labels = () => accountMenuItems().filter((i) => "label" in i).map((i) => i.label);
    expect(labels()).not.toContain("New update available");
    useUpdates.setState({ state: { version: "0.2.0", track: "stable", auto: true, feed: "alex/bots", status: "ready", latest: "0.4.0", error: null } });
    expect(labels()).toContain("New update available");
  });
});

// P5 review I7: the UI stores the update source and token (in the keychain, via the main process).
describe("Settings → Updates: update source (I7)", () => {
  it("saves the feed and token through updates.setSource and clears the token field", async () => {
    const args: unknown[] = [];
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => { invoked.push(n); if (n === "updates.setSource") args.push(a); return { ok: true, result: state }; });
    render(<UpdatesSection />);
    fireEvent.change(await screen.findByLabelText(/Updates from GitHub/), { target: { value: "alex/bots" } });
    fireEvent.change(screen.getByLabelText(/Read-only token/), { target: { value: "ghp_example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(args).toEqual([{ feed: "alex/bots", token: "ghp_example" }]));
    await vi.waitFor(() => expect((screen.getByLabelText(/Read-only token/) as HTMLInputElement).value).toBe(""));
  });

  it("shows 'Updates not configured' when no signing key is pinned", async () => {
    state = { ...state, status: "not-configured", error: "Updates not configured" };
    render(<UpdatesSection />);
    expect(await screen.findByText("Updates not configured")).toBeTruthy();
  });
});
