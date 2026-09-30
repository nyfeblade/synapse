// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR_ACP, STR_PROVIDER_UI, type SseEvent } from "@synapse/shared";
import { AcpSignInRow } from "../../src/renderer/components/AcpSignInRow";
import { AcpVendorsBlock } from "../../src/renderer/components/settings/AcpVendorsBlock";

// Wave 3: a Bot on a vendor's coding CLI — "Sign in with <vendor>" shows the vendor's link and code; a link off the
// vendor's hosts is never offered. Settings → Account lists the vendors with the one-time consent.
let calls: [string, unknown][] = [];
let native: [string, unknown][] = [];
let answers: Record<string, unknown> = {};

beforeEach(() => {
  calls = []; native = [];
  answers = {
    checkAcpLogin: { signedIn: false, detail: "" },
    startAcpLogin: { kind: "link", url: "https://github.com/login/device", code: "ABCD-1234" },
    getAcpVendors: { vendors: [{ id: "copilot", label: "GitHub Copilot", status: "experimental", consented: false, consentText: "Bots on GitHub Copilot send …", consentVersion: 1, planNote: "Included in your GitHub Copilot plan", loginFlow: "device" }] },
    consentAcpVendor: { vendors: [{ id: "copilot", label: "GitHub Copilot", status: "experimental", consented: true, consentText: "x", consentVersion: 1, planNote: "Included in your GitHub Copilot plan", loginFlow: "device" }] },
  };
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: answers[cmd] }; }),
    onEvent: (_l: (e: SseEvent) => void) => () => {},
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("Sign in with <vendor>", () => {
  it("not signed in → the vendor's link and code → opens only that link", async () => {
    render(<AcpSignInRow botId="b" vendor="copilot" />);
    const btn = await screen.findByRole("button", { name: STR_ACP.signIn("copilot") });
    expect(screen.getByText("Included in your GitHub Copilot plan")).toBeTruthy();
    fireEvent.click(btn);
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(calls).toContainEqual(["startAcpLogin", { id: "b", vendor: "copilot" }]);
    fireEvent.click(screen.getByRole("button", { name: STR_ACP.openLink }));
    expect(native).toContainEqual(["openExternal", { url: "https://github.com/login/device" }]);
  });

  it("a link off the vendor's hosts is never offered", async () => {
    answers.startAcpLogin = { kind: "link", url: "https://evil.example/login", code: "ABCD-1234" };
    render(<AcpSignInRow botId="b" vendor="copilot" />);
    fireEvent.click(await screen.findByRole("button", { name: STR_ACP.signIn("copilot") }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: STR_ACP.openLink })).toBeNull();
  });

  it("signed in shows it", async () => {
    answers.checkAcpLogin = { signedIn: true, detail: "" };
    render(<AcpSignInRow botId="b" vendor="kimi" />);
    expect(await screen.findByText(STR_ACP.signedIn)).toBeTruthy();
  });

  it("a terminal sign-in says what to run", async () => {
    answers.startAcpLogin = { kind: "terminal", command: "vibe --setup" };
    render(<AcpSignInRow botId="b" vendor="vibe" />);
    fireEvent.click(await screen.findByRole("button", { name: STR_ACP.signIn("vibe") }));
    expect(await screen.findByText(STR_ACP.terminalStep("vibe --setup"))).toBeTruthy();
  });
});

describe("Settings → Account → Coding CLIs", () => {
  it("lists each vendor as Experimental with its plan note, and asks consent once", async () => {
    render(<AcpVendorsBlock />);
    expect(await screen.findByText("GitHub Copilot")).toBeTruthy();
    expect(screen.getByText(STR_ACP.experimental)).toBeTruthy();
    expect(screen.getByText("Included in your GitHub Copilot plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR_PROVIDER_UI.allow }));
    fireEvent.click(await screen.findByRole("button", { name: STR_PROVIDER_UI.consentAllow }));
    expect(await screen.findByText(STR_PROVIDER_UI.allowed)).toBeTruthy();
    expect(calls).toContainEqual(["consentAcpVendor", { vendor: "copilot", textVersion: 1 }]);
  });
});

describe("Settings → Account → Coding CLIs → Install (0.1.6)", () => {
  const row = (install: Record<string, unknown>) => ({ id: "copilot", label: "GitHub Copilot", status: "experimental", consented: true, consentText: "x", consentVersion: 1, planNote: "p", loginFlow: "device",
    install: { pinned: "1.0.89", package: "@github/copilot", version: null, error: null, ...install } });
  const cursor = { id: "cursor", label: "Cursor", status: "experimental", consented: false, consentText: "x", consentVersion: 1, planNote: "p", loginFlow: "browser", install: { state: "unavailable", pinned: null, package: null, version: null, error: null } };

  it("Install asks once, then shows Installing… until it's Installed with its version, then Remove", async () => {
    answers.getAcpVendors = { vendors: [row({ state: "not-installed" }), cursor] };
    answers.installAcpVendor = { vendors: [row({ state: "installing" }), cursor] };
    render(<AcpVendorsBlock />);
    expect(await screen.findByText(STR_ACP.noVerifiedPackage)).toBeTruthy(); // Cursor: nothing verified to install
    expect(screen.getAllByRole("button", { name: STR_ACP.install })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: STR_ACP.install }));
    const confirm = screen.getByRole("region", { name: STR_ACP.installTitle("copilot", "1.0.89") });
    expect(confirm.textContent).toContain("@github/copilot 1.0.89 from npm, checks every file against the checksum npm publishes");
    expect(calls.map(([c]) => c)).not.toContain("installAcpVendor");
    fireEvent.click(within(confirm).getByRole("button", { name: STR_ACP.install }));
    expect(await screen.findByText(STR_ACP.installing)).toBeTruthy();
    expect(calls).toContainEqual(["installAcpVendor", { vendor: "copilot" }]);
    // The background install finishes; the block reads the state again.
    answers.getAcpVendors = { vendors: [row({ state: "installed", version: "1.0.89" }), cursor] };
    expect(await screen.findByText(STR_ACP.installed("1.0.89"), {}, { timeout: 3000 })).toBeTruthy();
    answers.removeAcpVendor = { vendors: [row({ state: "not-installed" }), cursor] };
    fireEvent.click(screen.getByRole("button", { name: STR_ACP.remove }));
    expect(await screen.findByText(STR_ACP.notInstalledShort)).toBeTruthy();
    expect(calls).toContainEqual(["removeAcpVendor", { vendor: "copilot" }]);
  });

  it("without per-Bot accounts it says so and how, and Install is off", async () => {
    answers.getAcpVendors = { accountsNeeded: true, vendors: [row({ state: "not-installed" })] };
    render(<AcpVendorsBlock />);
    const note = await screen.findByRole("region", { name: STR_ACP.accountsTitle });
    expect(note.textContent).toContain("box/migrate-per-bot-uid.sh --apply");
    expect((screen.getByRole("button", { name: STR_ACP.install }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed install shows the reason", async () => {
    answers.getAcpVendors = { vendors: [row({ state: "not-installed", error: "GitHub Copilot couldn't be installed. No network." })] };
    render(<AcpVendorsBlock />);
    expect((await screen.findByRole("alert")).textContent).toBe("GitHub Copilot couldn't be installed. No network.");
  });
});
