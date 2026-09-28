// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { ONBOARDING_TOOLS } from "../../src/renderer/onboarding/tools";

const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  const results: Record<string, unknown> = {
    getOnboarding: { hasSeenOnboarding: false, tokenConfigured: true },
    listStarterTemplates: { starters: [{ id: "starter:chief-of-staff", name: "Chief of Staff", title: "Your week", blurb: "Runs your week.", avatarShape: "gem", avatarColor: "#3472d9", tools: ["Gmail", "Google Calendar"] }] },
    createAgent: { id: "new-bot" }, previewTemplateImport: { token: "tk" }, importTemplate: { id: "starter-bot" },
  };
  (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async (c: string, a: unknown) => { calls.push([c, a]); return { ok: true, result: results[c] ?? {} }; }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} } };
});
afterEach(cleanup);

describe("onboarding flow (ONB-01…04)", () => {
  it("has 45 tools", () => {
    expect(ONBOARDING_TOOLS).toHaveLength(45);
    expect(new Set(ONBOARDING_TOOLS).size).toBe(45);
  });

  it("splash → tour → tools → create your own Bot with the tools appended to its description", async () => {
    const done = vi.fn();
    render(<Onboarding onDone={done} />);
    expect(screen.getByText(/Your team of always-on Bots that/)).toBeTruthy();
    expect(document.querySelector(".onb-mark")).toBeTruthy();
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("getOnboarding"));
    fireEvent.click(screen.getByRole("button", { name: "Input API Key →" }));
    expect(await screen.findByRole("heading", { name: "Meet Synapse" })).toBeTruthy();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "What do you use every day?" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), { target: { value: "sla" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Slack" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Create your own" })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /shape$/ }).map((r) => r.getAttribute("aria-label"))).toEqual(["Pebble shape", "Orb shape", "Tile shape", "Pill shape", "Dome shape", "Gem shape"]);
    expect(screen.getAllByRole("radio", { name: /^(Brown|Red|Orange|Amber|Green|Teal|Blue|Purple|Pink|Gray)$/ })).toHaveLength(10);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scout" } });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    await vi.waitFor(() => expect(calls.find((c) => c[0] === "createAgent")?.[1]).toMatchObject({ name: "Scout", description: "The user works with Slack, Gmail every day.", isKickstartRequested: true }));
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("completeOnboarding"));
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith("new-bot"));
  });

  it("a suggestion card imports its starter template (ONB-04)", async () => {
    const done = vi.fn();
    render(<Onboarding onDone={done} initialStep="new-bot" />);
    fireEvent.click(await screen.findByRole("button", { name: "Meet Chief of Staff" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["importTemplate", { token: "tk" }]));
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith("starter-bot"));
  });

  it("the tour shows where you are, one dot per page, and its Back and Next line up", async () => {
    render(<Onboarding onDone={vi.fn()} />);
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("getOnboarding"));
    fireEvent.click(screen.getByRole("button", { name: "Input API Key →" }));
    await screen.findByRole("heading", { name: "Meet Synapse" });
    const dots = () => [...document.querySelectorAll(".onb-dots i")];
    expect(dots().length).toBe(3);
    expect(dots().map((d) => d.classList.contains("on"))).toEqual([true, false, false]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dots().map((d) => d.classList.contains("on"))).toEqual([false, true, false]);
    // the demo line is an illustration above the explanation, not an input between it and the buttons
    const main = document.querySelector("main.onb")!;
    const order = [...main.children].map((el) => el.className || el.tagName);
    expect(order.indexOf("fake-composer")).toBeLessThan(order.indexOf("tour-page"));
  });

  it("a missing suggestions list doesn't break Create your own", async () => {
    const w = window as unknown as { synapse: { call: (c: string, a: unknown) => Promise<unknown> } };
    const base = w.synapse.call;
    w.synapse.call = async (c: string, a: unknown) => (c === "listStarterTemplates" ? { ok: true, result: {} } : base(c, a));
    render(<Onboarding onDone={vi.fn()} />);
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("getOnboarding"));
    fireEvent.click(screen.getByRole("button", { name: "Input API Key →" }));
    await screen.findByRole("heading", { name: "Meet Synapse" });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Create your own" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });
});
