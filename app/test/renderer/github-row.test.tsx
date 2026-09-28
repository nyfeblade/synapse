// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_DEVICE_URL, GITHUB_SCOPES, STRGH, type SseEvent } from "@synapse/shared";
import { GitHubRow } from "../../src/renderer/github/GitHubRow";

// Bug-log 195: Bot settings → GitHub. Signed out → code shown → signed in → signed out, with Copy and Open GitHub.

let calls: [string, unknown][] = [];
let native: [string, unknown][] = [];
let listeners: ((e: SseEvent) => void)[] = [];
let answers: Record<string, unknown> = {};
const writeText = vi.fn(async (_t: string) => {});

const emit = (payload: unknown) => act(() => { for (const l of listeners) l({ channel: "github", payload } as SseEvent); });

beforeEach(() => {
  calls = []; native = []; listeners = [];
  writeText.mockClear();
  answers = {
    getGitHubStatus: { signedIn: false, login: null, pending: null },
    startGitHubSignIn: { code: "1A2B-3C4D", url: GITHUB_DEVICE_URL },
    signOutGitHub: { signedIn: false, login: null, pending: null },
  };
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: answers[cmd] }; }),
    onEvent: (l: (e: SseEvent) => void) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; },
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("Bot settings → GitHub", () => {
  it("signed out → code shown → signed in → sign out", async () => {
    render(<GitHubRow botId="b" />);
    const signIn = await screen.findByRole("button", { name: STRGH.signIn });
    expect(calls).toContainEqual(["getGitHubStatus", { id: "b" }]);
    fireEvent.click(signIn);
    expect(await screen.findByText("1A2B-3C4D")).toBeTruthy();
    expect(calls).toContainEqual(["startGitHubSignIn", { id: "b" }]);
    expect(screen.getByText(STRGH.waiting)).toBeTruthy();
    expect(screen.getByRole("button", { name: STRGH.copy })).toBeTruthy();
    expect(screen.getByRole("button", { name: STRGH.openGitHub })).toBeTruthy();
    expect(screen.getByText("Access: repo, read:org, gist")).toBeTruthy();
    expect(STRGH.access(GITHUB_SCOPES)).toBe("Access: repo, read:org, gist");

    emit({ botId: "b", state: "signed-in", login: "octocat" });
    expect(await screen.findByText(STRGH.signedInAs("octocat"))).toBeTruthy();
    expect(screen.getByText("Signed in as octocat · push from ~/code")).toBeTruthy();
    expect(screen.queryByText("1A2B-3C4D")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: STRGH.signOut }));
    expect(await screen.findByRole("button", { name: STRGH.signIn })).toBeTruthy();
    expect(calls).toContainEqual(["signOutGitHub", { id: "b" }]);
  });

  it("shows who is signed in on open", async () => {
    answers.getGitHubStatus = { signedIn: true, login: "hubot", pending: null };
    render(<GitHubRow botId="b" />);
    expect(await screen.findByText(STRGH.signedInAs("hubot"))).toBeTruthy();
  });

  it("a waiting sign-in survives reopening the panel", async () => {
    answers.getGitHubStatus = { signedIn: false, login: null, pending: { code: "WXYZ-2345", url: GITHUB_DEVICE_URL } };
    render(<GitHubRow botId="b" />);
    expect(await screen.findByText("WXYZ-2345")).toBeTruthy();
  });

  it("Copy copies the code; Open GitHub copies it too and opens the device page in the system browser", async () => {
    render(<GitHubRow botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: STRGH.signIn }));
    await screen.findByText("1A2B-3C4D");
    fireEvent.click(screen.getByRole("button", { name: STRGH.copy }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("1A2B-3C4D"));
    writeText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: STRGH.openGitHub }));
    await vi.waitFor(() => expect(native).toContainEqual(["openExternal", { url: GITHUB_DEVICE_URL }]));
    expect(writeText).toHaveBeenCalledWith("1A2B-3C4D");
  });

  it("Open GitHub always opens GitHub's own device page, whatever URL an event carried", async () => {
    render(<GitHubRow botId="b" />);
    await screen.findByRole("button", { name: STRGH.signIn });
    emit({ botId: "b", state: "waiting", code: "1A2B-3C4D", url: "https://evil.example/login/device" });
    fireEvent.click(await screen.findByRole("button", { name: STRGH.openGitHub }));
    await vi.waitFor(() => expect(native).toContainEqual(["openExternal", { url: GITHUB_DEVICE_URL }]));
    expect(native.some(([, a]) => JSON.stringify(a).includes("evil"))).toBe(false);
  });

  it("events for another Bot are ignored", async () => {
    render(<GitHubRow botId="b" />);
    await screen.findByRole("button", { name: STRGH.signIn });
    emit({ botId: "other", state: "signed-in", login: "x" });
    expect(screen.queryByText(STRGH.signedInAs("x"))).toBeNull();
  });

  it("a failure says what happened and offers Try again", async () => {
    render(<GitHubRow botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: STRGH.signIn }));
    await screen.findByText("1A2B-3C4D");
    emit({ botId: "b", state: "failed", reason: "access_denied" });
    expect(await screen.findByText(STRGH.failed("access_denied"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STRGH.tryAgain }));
    await vi.waitFor(() => expect(calls.filter((c) => c[0] === "startGitHubSignIn")).toHaveLength(2));
  });

  it("an expired code says so", async () => {
    render(<GitHubRow botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: STRGH.signIn }));
    await screen.findByText("1A2B-3C4D");
    emit({ botId: "b", state: "expired", reason: STRGH.expired });
    expect(await screen.findByText(STRGH.expired)).toBeTruthy();
    expect(screen.getByRole("button", { name: STRGH.tryAgain })).toBeTruthy();
  });

  it("a start the host refuses shows its message", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string) => cmd === "startGitHubSignIn"
      ? { ok: false, error: { code: "GITHUB_NO_ACCOUNT", message: STRGH.needsOwnAccount } }
      : { ok: true, result: answers[cmd] });
    render(<GitHubRow botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: STRGH.signIn }));
    expect(await screen.findByText(STRGH.needsOwnAccount)).toBeTruthy();
    expect(screen.getByRole("button", { name: STRGH.tryAgain })).toBeTruthy();
  });
});
