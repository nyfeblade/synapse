// @vitest-environment jsdom
// Bot sharing, phase 3: the no-app path lands in onboarding's last step. "Paste a Bot link" reads the clipboard
// only when clicked, shows the same confirm sheet, and adding the Bot finishes onboarding with it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { ImportSheet } from "../../src/renderer/templates/ImportSheet";
import { useTemplates } from "../../src/renderer/templates/store";

const calls: [string, unknown][] = [];
let clip: string | null = null;
beforeEach(() => {
  calls.length = 0;
  clip = null;
  const results: Record<string, unknown> = {
    getOnboarding: { hasSeenOnboarding: false, tokenConfigured: true }, listStarterTemplates: { starters: [] },
    previewShareImport: { token: "tok", name: "Scout", description: "x", facts: [], playbooks: [], jobs: [], apps: [], thirdParty: true, share: true, instructions: "Research.", skills: [], flags: [], alreadyAdded: false, face: { shape: "gem", color: "#3674d8" } },
    importTemplate: { id: "scout-id" }, completeOnboarding: {},
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => { calls.push([c, a]); return { ok: true, result: results[c] ?? {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: n === "clipboard.botLink" ? { fragment: clip } : {} }; }), on: () => () => {} },
  };
  useTemplates.setState({ sheet: null, importReady: false, pendingShare: null, afterAdd: null });
});
afterEach(cleanup);

describe("onboarding: Paste a Bot link", () => {
  it("reads the clipboard only on the click, confirms, and finishes onboarding with the new Bot", async () => {
    const onDone = vi.fn();
    render(<><Onboarding initialStep="new-bot" onDone={onDone} /><ImportSheet /></>);
    await screen.findByRole("button", { name: "Get started" });
    expect(calls.some(([c]) => c === "native:clipboard.botLink")).toBe(false);
    clip = "b1.abc";
    fireEvent.click(screen.getByRole("button", { name: "Paste a Bot link" }));
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    expect(calls.filter(([c]) => c === "native:clipboard.botLink")).toHaveLength(1);
    expect(calls.find(([c]) => c === "previewShareImport")![1]).toEqual({ payload: "b1.abc" });
    expect(calls.some(([c]) => c === "importTemplate")).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Bot" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("scout-id"));
    expect(calls.some(([c]) => c === "completeOnboarding")).toBe(true);
  });

  it("says so calmly when there's no Bot link on the clipboard", async () => {
    render(<><Onboarding initialStep="new-bot" onDone={vi.fn()} /><ImportSheet /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Paste a Bot link" }));
    expect(await screen.findByText("No Bot link copied.")).toBeTruthy();
    expect(calls.some(([c]) => c === "previewShareImport")).toBe(false);
  });
});
