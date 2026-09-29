// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR_SETUP } from "@synapse/shared";
import { SetupScreen } from "../../src/renderer/firstrun/SetupScreen";
import { useSetupGate } from "../../src/renderer/firstrun/store";

// Portable install: the first-run setup screen. Each step shows done / working / needs you; OrbStack's button
// is Get or Start; the Bots' computer starts on its own once OrbStack runs; Finish waits for the required steps.
type Status = Record<string, unknown>;
const box = (o: Partial<Record<string, unknown>> = {}) => ({ phase: "idle", progress: 0, error: null, step: null, logTail: [], ...o });
const status = (o: Partial<Status> = {}): Status => ({
  done: false, machine: "synapse-box", connected: false, mac: { arm64: true, freeBytes: 100e9 },
  orb: { app: false, cli: false, status: "unknown", version: null }, box: box(), ...o,
});

let current: Status = status();
let invoked: Array<[string, unknown]> = [];
beforeEach(() => {
  invoked = [];
  current = status();
  useSetupGate.setState({ gate: "setup", reopened: false });
  (window as unknown as { synapse: unknown }).synapse = {
    call: async () => ({ ok: true, result: { tokenConfigured: false, hasSeenOnboarding: false } }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: unknown) => {
        invoked.push([n, a]);
        if (n === "setup.status") return { ok: true, result: current };
        if (n === "voicePacks.list") return { ok: true, result: [{ id: "qwen", label: "Natural voices", bytes: 2.4e9, state: "available", progress: 0 }] };
        if (n === "kokoro.status") return { ok: true, result: { state: "ready" } };
        if (n === "whisper.status.get") return { ok: true, result: { state: "no-model", size: "0 MB" } };
        if (n === "updates.source") return { ok: true, result: { feed: null, hasToken: false } };
        return { ok: true, result: {} };
      }),
      on: () => () => {},
    },
  };
});
afterEach(cleanup);

const step = (name: string) => screen.getByRole("listitem", { name });

describe("the setup screen", () => {
  it("OrbStack missing: Get OrbStack opens the download page; nothing else runs", async () => {
    render(<SetupScreen />);
    const orb = await screen.findByRole("listitem", { name: "OrbStack" });
    expect(within(orb).getByText("Needs you")).toBeTruthy();
    expect(within(step("Bots' computer")).getByText("Waiting")).toBeTruthy();
    fireEvent.click(within(orb).getByRole("button", { name: "Get OrbStack" }));
    await vi.waitFor(() => expect(invoked.map((c) => c[0])).toContain("setup.orb.download"));
    expect(invoked.map((c) => c[0])).not.toContain("setup.box.start");
    expect((screen.getByRole("button", { name: "Start using Synapse" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("installed but stopped: Start OrbStack", async () => {
    current = status({ orb: { app: true, cli: true, status: "stopped", version: null } });
    render(<SetupScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Start OrbStack" }));
    await vi.waitFor(() => expect(invoked.map((c) => c[0])).toContain("setup.orb.start"));
  });

  it("OrbStack running: the Bots' computer starts on its own, with a progress bar", async () => {
    current = status({ orb: { app: true, cli: true, status: "running", version: "2.2.3" } });
    render(<SetupScreen />);
    await vi.waitFor(() => expect(invoked.filter((c) => c[0] === "setup.box.start")).toHaveLength(1));
    expect(within(step("Bots' computer")).getByRole("progressbar", { name: "Bots' computer" })).toBeTruthy();
  });

  it("a failed setup shows the plain error and a Retry that resumes", async () => {
    current = status({ orb: { app: true, cli: true, status: "running", version: "2.2.3" }, box: box({ phase: "failed", progress: 0.4, error: "No internet connection reached the Bots' computer. Check your connection and retry." }) });
    render(<SetupScreen />);
    expect(await screen.findByText(/No internet connection/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(invoked.map((c) => c[0])).toContain("setup.box.start"));
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await vi.waitFor(() => expect(invoked.map((c) => c[0])).toContain("setup.box.log"));
  });

  it("connected, but the sign-in check is refused: the Claude step says why instead of spinning forever", async () => {
    current = status({ connected: true, orb: { app: true, cli: true, status: "running", version: "2.2.3" }, box: box({ phase: "ready", progress: 1 }) });
    (window as unknown as { synapse: { call: unknown } }).synapse.call = async () => ({ ok: false, error: { code: "WRONG_HOST", message: "Synapse is running in another account on this Mac and is using this account's connection. Quit Synapse there, then retry." } });
    render(<SetupScreen />);
    const claude = await screen.findByRole("listitem", { name: STR_SETUP.claude });
    expect(await within(claude).findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/^Synapse is running in another account on this Mac/));
  });

  it("offers the optional voices with their size, and the GitHub updates row with a token link", async () => {
    render(<SetupScreen />);
    expect(await screen.findByText("Natural voices")).toBeTruthy();
    expect(screen.getByText("2.4 GB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download Natural voices" }));
    await vi.waitFor(() => expect(invoked).toContainEqual(["voicePacks.install", { id: "qwen" }]));
    fireEvent.click(screen.getByText("Create a token"));
    await vi.waitFor(() => expect(invoked).toContainEqual(["openExternal", { url: "https://github.com/settings/personal-access-tokens/new" }]));
  });

  it("everything required done: Start using Synapse finishes setup", async () => {
    current = status({ orb: { app: true, cli: true, status: "running", version: "2.2.3" }, box: box({ phase: "ready", progress: 1 }), connected: true });
    (window as unknown as { synapse: { call: unknown } }).synapse.call = async () => ({ ok: true, result: { tokenConfigured: true, hasSeenOnboarding: false } });
    render(<SetupScreen />);
    const finish = await screen.findByRole("button", { name: "Start using Synapse" });
    await vi.waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(finish);
    await vi.waitFor(() => expect(invoked.map((c) => c[0])).toContain("setup.finish"));
    await vi.waitFor(() => expect(useSetupGate.getState().gate).toBe("app"));
  });
});

describe("the Sign in step: the Anthropic API key is the only choice (synapse-public)", () => {
  const KEY = "sk-ant-api03-" + "S".repeat(80) + "st01";
  it("shows only the API key field (no subscription, no Connect Claude); saving a key completes the step", async () => {
    current = status({ orb: { app: true, cli: true, status: "running", version: "2.2.3" }, box: box({ phase: "ready", progress: 1 }), connected: true });
    let auth = { apiKey: null as null | { masked: string; savedAt: number }, boxPublicKey: "PK" };
    const calls: string[] = [];
    const w = window as unknown as { synapse: { call: unknown; auth: unknown } };
    w.synapse.call = async (c: string) => {
      calls.push(c);
      if (c === "getOnboarding") return { ok: true, result: { tokenConfigured: !!auth.apiKey, hasSeenOnboarding: false } };
      return { ok: true, result: auth };
    };
    w.synapse.auth = { saveKey: vi.fn(async () => { auth = { ...auth, apiKey: { masked: "sk-ant-…st01", savedAt: 1 } }; return auth; }), testKey: vi.fn(), removeKey: vi.fn(), hasMacKey: vi.fn(async () => true) };
    render(<SetupScreen />);
    const signIn = await screen.findByRole("listitem", { name: "Sign in" });
    const input = await within(signIn).findByLabelText("Anthropic API key");
    expect(within(signIn).queryAllByRole("radio")).toHaveLength(0);
    expect(signIn.textContent).not.toMatch(/subscription|Connect Claude/i);
    fireEvent.change(input, { target: { value: KEY } });
    await vi.waitFor(() => expect((within(signIn).getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(signIn).getByRole("button", { name: "Save key" }));
    await vi.waitFor(() => expect((w.synapse.auth as { saveKey: ReturnType<typeof vi.fn> }).saveKey).toHaveBeenCalledWith(KEY));
    await vi.waitFor(() => expect(step("Sign in").getAttribute("data-state")).toBe("done"));
    expect(calls).not.toContain("setAuthMode");
  });
});
