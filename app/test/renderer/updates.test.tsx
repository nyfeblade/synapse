// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputer } from "../../src/renderer/computer-state";
import { BoxBanner } from "../../src/renderer/components/BoxBanner";
import { ConnectionScreen } from "../../src/renderer/components/ConnectionScreen";
import { DiskBanner } from "../../src/renderer/components/DiskBanner";
import { UpdatesSection } from "../../src/renderer/components/UpdatesSection";
import { ConfirmHost } from "../../src/renderer/components/ConfirmDialog";

const box = { update: vi.fn(), recover: vi.fn(async () => {}), reset: vi.fn(async () => {}), info: vi.fn(async () => ({ bundledImageVersion: "v2" })), onLifecycle: vi.fn(() => () => {}) };
const status = (imageVersion: string) => ({ phase: "ready" as const, step: null, imageVersion, latestVersion: true, backupReady: true, lastSnapshotAt: 1, busyBotIds: [], doctor: { ranAt: null, failed: [] }, error: null });
const calls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = { box, call: async (cmd: string) => { calls.push(cmd); return { ok: true, result: cmd === "openDiskSaver" ? { id: "ds" } : status("v2") }; } };
  useComputer.setState({ box: status("v2"), disk: null, lifecycle: null });
});
afterEach(cleanup);

describe("Settings → Updates (SET-13, CMP-11)", () => {
  // Portable install, fix round 1: a named confirm says what is kept and what is rebuilt; Cancel rebuilds nothing.
  it("Update asks 'Rebuild the Bots' computer?' first, and Cancel rebuilds nothing", async () => {
    useComputer.setState({ box: status("v1") });
    render(<><UpdatesSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    expect(await screen.findByText("Rebuild the Bots' computer?")).toBeTruthy();
    expect(screen.getByText(/Kept: your Bots, chats, files and settings/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Rebuild the Bots' computer?")).toBeNull());
    expect(box.update).not.toHaveBeenCalled();
  });


  it("a failing box:info shows an error instead of an unhandled rejection (Task 30 fuzz, critical)", async () => {
    box.info.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, scandir '/x/box/files'"));
    render(<UpdatesSection />);
    expect(await screen.findByText(/ENOENT/)).toBeTruthy();
  });

  it("shows the latest-version box when the box image matches the bundled one", async () => {
    render(<UpdatesSection />);
    expect(screen.getByRole("heading", { name: "Update Bots' Computer" })).toBeTruthy();
    expect(screen.getByText("Brings the shared computer up to date for all your assistants at once. Files and sign-ins are kept; apps and packages you installed are removed.")).toBeTruthy();
    expect(await screen.findByText("The computer is up to date")).toBeTruthy();
  });

  it("offers Update when the versions differ, and the busy choice when Bots are working", async () => {
    useComputer.setState({ box: status("v1") });
    box.update.mockResolvedValueOnce({ status: "busy", busyBotIds: ["bot-a"] }).mockResolvedValueOnce({ status: "done" });
    render(<><UpdatesSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    // Fix round 1: Update rebuilds the machine, so it asks first, by name.
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild the Bots' computer" }));
    expect(await screen.findByRole("button", { name: "Update once agents finish" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(box.update).toHaveBeenLastCalledWith(true));
  });

  it("shows 'Backup not ready' and disables Update/Reset when a fresh box has no snapshot yet, even on the latest image", async () => {
    useComputer.setState({ box: { ...status("v2"), backupReady: false } });
    render(<UpdatesSection />);
    expect(await screen.findByText("Backup not ready")).toBeTruthy();
    expect(screen.queryByText("The computer is up to date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    const resetButton = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(resetButton.disabled).toBe(true);
  });

  it("Reset needs two clicks and passes the 'Also restore Bots and chats' choice (default off)", async () => {
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(box.reset).not.toHaveBeenCalled();
    const tick = screen.getByRole("checkbox", { name: "Also restore Bots and chats" }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    fireEvent.click(screen.getByRole("button", { name: "Reset now" }));
    await waitFor(() => expect(box.reset).toHaveBeenCalledWith(true));
  });
});

describe("banners", () => {
  it("shows the current lifecycle step, then nothing when ready", () => {
    render(<BoxBanner />);
    act(() => useComputer.setState({ lifecycle: { phase: "updating", step: "backing_up", error: null } }));
    expect(screen.getByRole("status").textContent).toContain("Backing up your data");
    act(() => useComputer.setState({ lifecycle: { phase: "ready", step: null, error: null } }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disk banner copy by level and Open Disk Saver", async () => {
    render(<DiskBanner botId="b" />);
    act(() => useComputer.setState({ disk: { level: "hard", freeBytes: 1, totalBytes: 10, freePct: 10, checkedAt: 1, diskSaverBotId: null } }));
    expect(screen.getByText("Computer is critically low on disk space")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Disk Saver" }));
    await waitFor(() => expect(calls).toContain("openDiskSaver"));
  });

  it("the reconnect screen offers Recover", async () => {
    render(<ConnectionScreen state={{ kind: "unreachable", error: "timeout" } as never} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    await waitFor(() => expect(box.recover).toHaveBeenCalled());
  });
});
