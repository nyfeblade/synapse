// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacDiskBanner } from "../../src/renderer/components/MacDiskBanner";

const GB = 1e9;
let status: unknown = { level: "low", freeBytes: 12.3 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 1 };
let listeners: Record<string, (p: unknown) => void> = {};
beforeEach(() => {
  listeners = {};
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (name: string) => ({ ok: true, result: name === "macDisk.status" ? status : {} })),
      on: (ch: string, cb: (p: unknown) => void) => { listeners[ch] = cb; return () => { delete listeners[ch]; }; },
    },
  };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

const MSG = "Your Mac is almost out of space (12.3 GB free). Synapse's backups and Bots may stop working.";

describe("low-disk banner (bug-log 128)", () => {
  it("shows the message under 15 GB, updates live, and goes away when there is room again", async () => {
    render(<MacDiskBanner />);
    expect((await screen.findByRole("status")).textContent).toContain(MSG);
    act(() => listeners["mac-disk"]!({ level: "critical", freeBytes: 3.1 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 2 }));
    expect(screen.getByRole("status").textContent).toContain("(3.1 GB free)");
    act(() => listeners["mac-disk"]!({ level: "ok", freeBytes: 80 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 3 }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is non-intrusive: nothing when the disk is fine, and Dismiss hides it until it gets worse", async () => {
    status = { level: "ok", freeBytes: 80 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 1 };
    render(<MacDiskBanner />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
    act(() => listeners["mac-disk"]!({ level: "low", freeBytes: 12.3 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => listeners["mac-disk"]!({ level: "low", freeBytes: 12.0 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 3 }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => listeners["mac-disk"]!({ level: "critical", freeBytes: 4 * GB, totalBytes: 500 * GB, boxFreeBytes: null, checkedAt: 4 }));
    expect(screen.getByRole("status").textContent).toContain("(4.0 GB free)");
  });
});
