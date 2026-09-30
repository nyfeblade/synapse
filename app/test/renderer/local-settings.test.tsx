// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalToolCardView } from "@synapse/shared";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";

const calls: [string, unknown][] = [];
const computer = { computerId: "mac", label: "Alex's MacBook", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/alex" };
beforeEach(() => {
  calls.length = 0;
  const results: Record<string, unknown> = { getLocalComputer: { computer }, setLocalComputer: { computer: { ...computer, label: "Studio" } }, getNetworkStats: { routedThisSession: 10 }, resolveLocalToolPermission: { status: "allowed" }, getPhase5Settings: { memoryMode: "standard", useHardwareSecurityKeys: false, hasSeenOnboarding: true, advancedEnabled: false }, setHardwareSecurityKeys: { memoryMode: "standard", useHardwareSecurityKeys: true, hasSeenOnboarding: true, advancedEnabled: false } };
  (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async (c: string, a: unknown) => { calls.push([c, a]); return { ok: true, result: results[c] ?? {} }; }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} } };
});
afterEach(cleanup);

const card: LocalToolCardView = { kind: "local-tool-permission", askId: "k1", action: "run-command", target: "brew upgrade", description: null, status: "pending", createdAt: 1, expiresAt: 2 };

describe("local card (LOC-04)", () => {
  it("shows the product-named question and four buttons", async () => {
    render(<LocalToolCard botId="b" entryId="t1s1" card={card} />);
    // P5 review minor: "Always" covers this Bot and this kind of action only, never the whole Mac.
    expect(screen.getByText("Allow this Bot to run this on your local computer?")).toBeTruthy();
    expect(screen.getByText("“Always allow” covers only this Bot and this kind of action. You can change it in Settings → Computer.")).toBeTruthy();
    expect(screen.getByText("brew upgrade")).toBeTruthy();
    for (const n of ["Always allow", "Allow once", "Never", "Deny once"]) expect(screen.getByRole("button", { name: n })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["resolveLocalToolPermission", { id: "b", askId: "k1", choice: "once", action: "run-command", target: expect.any(String) }]));
  });

  it("Esc on the focused card denies once; settled cards show the outcome line", async () => {
    const { rerender } = render(<LocalToolCard botId="b" entryId="t1s1" card={card} />);
    fireEvent.keyDown(screen.getByRole("region", { name: "Local computer request" }), { key: "Escape" });
    await vi.waitFor(() => expect(calls).toContainEqual(["resolveLocalToolPermission", { id: "b", askId: "k1", choice: "deny", action: "run-command", target: expect.any(String) }]));
    rerender(<LocalToolCard botId="b" entryId="t1s1" card={{ ...card, status: "always" }} />);
    expect(screen.getByText("Always allowed for this Bot and this kind of action.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
});

describe("Settings → Computer (Settings.dc.html)", () => {
  it("edits the computer name (Save disabled until changed) and the execution policy", async () => {
    render(<ComputerSection />);
    const name = await screen.findByLabelText("Computer name");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Studio" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(calls).toContainEqual(["setLocalComputer", { label: "Studio" }]));
    fireEvent.change(screen.getByRole("combobox", { name: "Commands on this computer" }), { target: { value: "always" } });
    await vi.waitFor(() => expect(calls).toContainEqual(["setLocalComputer", { executionPolicy: "always" }]));
  });

  it("ruling A: Auto-run folders — empty by default, Add folder picks a folder, each has a Remove button", async () => {
    const withRoot = { ...computer, autoRunRoots: ["/Users/alex/Projects"] };
    const invoke = vi.fn(async (n: string) => ({ ok: true, result: n === "pickFolder" ? { path: "/Users/alex/Projects" } : {} }));
    const w = window as unknown as { synapse: { call: ReturnType<typeof vi.fn>; native: { invoke: unknown } } };
    w.synapse.native.invoke = invoke;
    w.synapse.call = vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      const r: Record<string, unknown> = { getLocalComputer: { computer }, setLocalComputer: { computer: (a as { removeAutoRunRoot?: string }).removeAutoRunRoot ? computer : withRoot }, getNetworkStats: { routedThisSession: 0 } };
      return { ok: true, result: r[c] ?? {} };
    });
    render(<ComputerSection />);
    expect(await screen.findByText("Auto-run folders")).toBeTruthy();
    expect(screen.getByText("No folders yet, so every request asks first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setLocalComputer", { addAutoRunRoot: "/Users/alex/Projects" }]));
    expect(invoke).toHaveBeenCalledWith("pickFolder", {});
    expect(await screen.findByText("/Users/alex/Projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove /Users/alex/Projects" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setLocalComputer", { removeAutoRunRoot: "/Users/alex/Projects" }]));
    await vi.waitFor(() => expect(screen.queryByText("/Users/alex/Projects")).toBeNull());
  });

  it("Keep Bots running when the app quits is on by default and persists off through native settings", async () => {
    const invoke = vi.fn(async (n: string, a: unknown) => {
      calls.push([`native:${n}`, a]);
      if (n === "keepBoxOnQuit.get") return { ok: true, result: { on: true } };
      if (n === "keepBoxOnQuit.set") return { ok: true, result: a };
      return { ok: true, result: {} };
    });
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = invoke;
    render(<ComputerSection />);
    const sw = await screen.findByRole("switch", { name: "Keep Bots running when the app quits" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("keepBoxOnQuit.set", { on: false }));
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  // 0.1.4: Local network, off by default; turning it on asks once (Allow / Cancel); turning it off doesn't ask.
  it("Local network: off by default, one confirmation to turn on, none to turn off", async () => {
    let on = false;
    const invoke = vi.fn(async (n: string, a: { on?: boolean }) => {
      if (n === "localNetwork.get") return { ok: true, result: { on } };
      if (n === "localNetwork.set") { on = a.on === true; return { ok: true, result: { on } }; }
      return { ok: true, result: {} };
    });
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = invoke;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ComputerSection />);
    const sw = await screen.findByRole("switch", { name: "Local network" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw); // Cancel
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("Let Bots reach your local network?");
    expect(invoke).not.toHaveBeenCalledWith("localNetwork.set", expect.anything());
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw); // Allow
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("localNetwork.set", { on: true }));
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(sw); // off: no question
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("localNetwork.set", { on: false }));
    expect(confirm).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    confirm.mockRestore();
  });

  it("Local network: a turn-on the box refused reads back off, with the not-saved line", async () => {
    const invoke = vi.fn(async (n: string) => {
      if (n === "localNetwork.get") return { ok: true, result: { on: false } };
      if (n === "localNetwork.set") return { ok: true, result: { on: false } };
      return { ok: true, result: {} };
    });
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = invoke;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ComputerSection />);
    const sw = await screen.findByRole("switch", { name: "Local network" });
    fireEvent.click(sw);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("localNetwork.set", { on: true }));
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    confirm.mockRestore();
  });

  it("Network: locked state shown as status, not a dead switch; honest copy, live counter (LOC-09, C7)", async () => {
    render(<ComputerSection />);
    // This was never a real control (box/route.env only pins bind addresses to 127.0.0.1), so it must not
    // expose role="switch" — that reads to a screen reader (and to a sighted user) as something you can flip.
    expect(screen.queryByRole("switch", { name: "Route traffic through this computer" })).toBeNull();
    // The locked state is still announced — just as status, not as a control.
    const status = await screen.findByRole("status", { name: "Route traffic through this computer: On" });
    expect(status.tagName).not.toBe("BUTTON");
    expect(await screen.findByText(/Bots' computer runs on this Mac.*10 routed this session\./)).toBeTruthy();
  });
});

