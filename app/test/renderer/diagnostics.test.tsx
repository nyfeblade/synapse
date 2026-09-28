// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSection } from "../../src/renderer/components/settings/DiagnosticsSection";
import { installRendererErrorReporting, showRecoveredToast } from "../../src/renderer/crash-reporting";

const calls: { name: string; args: unknown }[] = [];
let listeners: Record<string, (p: unknown) => void> = {};
const reports = [{ id: "crash-1", at: Date.parse("2026-09-21T10:00:00Z"), kind: "host-crash", message: "The host stopped unexpectedly", appVersion: "0.3.0", hostVersion: "0.1.0", count: 2, seen: false }];
beforeEach(() => {
  calls.length = 0;
  listeners = {};
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (name: string, args: unknown) => { calls.push({ name, args }); return { ok: true, result: name === "crashes.list" ? { reports, unseen: 1 } : name === "crashes.unseen" ? { unseen: 1 } : {} }; }),
      on: (ch: string, cb: (p: unknown) => void) => { listeners[ch] = cb; return () => {}; },
    },
  };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("Settings → Diagnostics", () => {
  it("lists recent problems and makes a redacted report on Copy report / Show in Finder; opening it marks them seen", async () => {
    render(<DiagnosticsSection />);
    expect(await screen.findByText("Host crashed ×2")).toBeTruthy();
    expect(screen.getByText(/The host stopped unexpectedly/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(expect.arrayContaining(["crashes.markSeen", "crashes.copy", "crashes.reveal"])));
    expect(calls.find((c) => c.name === "crashes.copy")!.args).toEqual({ id: "crash-1" });
  });
});

describe("Settings → Diagnostics · Storage (bug-log 128)", () => {
  it("shows the free space on this Mac and on Synapse's computer", async () => {
    const inv = (window as unknown as { synapse: { native: { invoke: ReturnType<typeof vi.fn> } } }).synapse.native;
    inv.invoke = vi.fn(async (name: string) => ({
      ok: true,
      result: name === "crashes.list" ? { reports: [], unseen: 0 } : name === "macDisk.status" ? { level: "low", freeBytes: 12.3e9, totalBytes: 500e9, boxFreeBytes: 40e9, checkedAt: 1 } : {},
    }));
    render(<DiagnosticsSection />);
    expect(await screen.findByText("Storage")).toBeTruthy();
    expect(screen.getByText("This Mac").parentElement!.textContent).toContain("12.3 GB free");
    expect(screen.getByText("Synapse's computer").parentElement!.textContent).toContain("40.0 GB free");
    act(() => listeners["mac-disk"]!({ level: "ok", freeBytes: 90e9, totalBytes: 500e9, boxFreeBytes: null, checkedAt: 2 }));
    expect(screen.getByText("This Mac").parentElement!.textContent).toContain("90.0 GB free");
    expect(screen.getByText("Synapse's computer").parentElement!.textContent).toContain("Not known yet");
  });
});

describe("crash toast and renderer error capture", () => {
  it("shows 'Synapse recovered from a problem · View', and View opens Diagnostics", () => {
    const open = vi.fn();
    showRecoveredToast(open);
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Synapse recovered from a problem");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports window errors and unhandled rejections to the local crash store (never the network)", async () => {
    const stop = installRendererErrorReporting(() => {});
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    const ev = new Event("unhandledrejection") as Event & { reason?: unknown };
    ev.reason = new Error("nope");
    window.dispatchEvent(ev);
    await vi.waitFor(() => expect(calls.filter((c) => c.name === "crashes.reportRenderer").map((c) => (c.args as { message: string }).message)).toEqual(["boom", "nope"]));
    stop();
  });
});
