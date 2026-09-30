// @vitest-environment jsdom
// Hand-testing round, Settings → Updates: the computer card and the app card.
// Each test here was written RED against the shipped component before the fix landed.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmHost } from "../../src/renderer/components/ConfirmDialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesSection as BoxUpdatesSection } from "../../src/renderer/components/UpdatesSection";
import { UpdatesSection as AppUpdatesSection } from "../../src/renderer/components/settings/UpdatesSection";
import { useComputer } from "../../src/renderer/computer-state";
import { useUpdates } from "../../src/renderer/updates/store";
import { useUi } from "../../src/renderer/store";
import { COPY, baseUpdate, boxStatus, installBridge } from "./settings-fixtures";

let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useComputer.setState({ box: boxStatus("v2"), disk: null, lifecycle: null });
  useUpdates.setState({ state: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Settings → Updates → the computer card", () => {
  const armBusy = async () => {
    useComputer.setState({ box: boxStatus("v1", ["bot-a"]) });
    h.box.update.mockResolvedValueOnce({ status: "busy", busyBotIds: ["bot-a"] });
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild the Bots' computer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update once agents finish" }));
  };

  it("'Update once agents finish' shows a waiting state that can be cancelled", async () => {
    render(<><BoxUpdatesSection /><ConfirmHost /></>);
    await armBusy();
    expect(await screen.findByText(COPY.waiting)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(COPY.waiting)).toBeNull());
  });

  it("does not update the computer after the Settings modal is closed (leaked interval)", async () => {
    vi.useFakeTimers();
    useComputer.setState({ box: boxStatus("v1", ["bot-a"]) });
    h.box.update.mockResolvedValueOnce({ status: "busy", busyBotIds: ["bot-a"] });
    const view = render(<><BoxUpdatesSection /><ConfirmHost /></>);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Rebuild the Bots' computer" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Update once agents finish" }));
    view.unmount();
    useComputer.setState({ box: boxStatus("v1", []) }); // the agents go idle after Settings was closed
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(h.box.update).toHaveBeenCalledTimes(1);
  });

  it("collapses the Reset confirmation and confirms once the reset succeeds", async () => {
    render(<><BoxUpdatesSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset now" }));
    expect(await screen.findByText(COPY.resetDone)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset now" })).toBeNull();
    expect(h.box.reset).toHaveBeenCalledTimes(1);
  });

  it("disables Reset now while the reset is still running", async () => {
    let release = () => {};
    h.box.reset.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    render(<><BoxUpdatesSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset now" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Reset now" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => { release(); });
  });
});

describe("Settings → Updates → the app card", () => {
  it("explains that no update source is configured instead of silently doing nothing", async () => {
    h.nativeReply = () => ({ ...baseUpdate, status: "no-feed" });
    render(<AppUpdatesSection />);
    expect(await screen.findByText(COPY.noSource)).toBeTruthy();
  });

  it("says Downloading… on the button while the release is downloading", async () => {
    h.nativeReply = () => ({ ...baseUpdate, feed: "alex/bots", status: "downloading" });
    render(<AppUpdatesSection />);
    expect(await screen.findByRole("button", { name: COPY.downloading })).toBeTruthy();
  });

  it("shows the configured update source in the field", async () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never }); // new-user walk finding 8: advanced controls
    h.nativeReply = () => ({ ...baseUpdate, feed: "alex/bots", status: "none" });
    render(<AppUpdatesSection />);
    expect(((await screen.findByLabelText(/Updates from GitHub/)) as HTMLInputElement).value).toBe("alex/bots");
  });

  it("lets a wrong update source be cleared", async () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never }); // new-user walk finding 8: advanced controls
    const sent: unknown[] = [];
    h.nativeReply = (name, args) => { if (name === "updates.setSource") sent.push(args); return { ...baseUpdate, feed: "alex/bots", status: "none" }; };
    render(<AppUpdatesSection />);
    fireEvent.change(await screen.findByLabelText(/Updates from GitHub/), { target: { value: "" } });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(sent).toEqual([{ feed: "" }]));
  });

  it("shows an error and a Retry when the update state cannot be loaded", async () => {
    h.nativeReply = () => new Error("the updater is unreachable");
    render(<AppUpdatesSection />);
    expect(await screen.findByText("the updater is unreachable")).toBeTruthy();
    h.nativeReply = () => ({ ...baseUpdate, feed: "alex/bots", status: "none" });
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByText("Version 0.2.0")).toBeTruthy();
  });
});
