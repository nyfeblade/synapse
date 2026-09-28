// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRMA, type MacPermission } from "@synapse/shared";
import { MacAppsPanel } from "../../src/renderer/components/settings/MacAppsPanel";

/**
 * mac-apps: Settings → Computer → Apps. A permission the user has to grant OUTSIDE the app is only useful if
 * the panel says where it stands, offers the one prompt macOS will raise on demand, links to the pane for the
 * rest, and notices when they come back having granted it.
 */
const rows: MacPermission[] = [
  { id: "accessibility", label: "Use any app's buttons and menus", state: "unknown", pane: "accessibility" },
  { id: "automation:Messages", label: "Send and read messages (Messages)", state: "denied", pane: "automation", detail: "You said no to this one." },
  { id: "automation:Mail", label: "Write, send and search email (Mail)", state: "granted", pane: "automation" },
];

let calls: { name: string; args: unknown }[];
let answer: MacPermission[];

vi.mock("../../src/renderer/native", () => ({
  nativeCall: (name: string, args: unknown) => {
    calls.push({ name, args });
    if (name === "macapp.permissions") return Promise.resolve({ permissions: answer });
    return Promise.resolve({ state: "unknown" });
  },
  onNative: () => () => {},
}));

beforeEach(() => { calls = []; answer = rows; });
afterEach(cleanup);

const show = async () => {
  render(<MacAppsPanel />);
  await screen.findByText(STRMA.appsSection);
  await waitFor(() => expect(calls.some((c) => c.name === "macapp.permissions")).toBe(true));
};
const rowFor = (label: string) => {
  const el = [...document.querySelectorAll<HTMLElement>(".settings-row")].find((r) => r.textContent?.includes(label));
  if (!el) throw new Error(`no row for ${label}`);
  return el;
};

describe("the Apps panel", () => {
  it("shows every capability with its status in plain words", async () => {
    await show();
    await waitFor(() => expect(rowFor("buttons and menus").textContent).toContain(STRMA.stateLabel.unknown));
    expect(rowFor("(Messages)").textContent).toContain(STRMA.stateLabel.denied);
    expect(rowFor("(Mail)").textContent).toContain(STRMA.stateLabel.granted);
  });

  it("offers the prompt for one not yet asked, and the System Settings pane for one refused", async () => {
    await show();
    await waitFor(() => expect(within(rowFor("buttons and menus")).getByText(STRMA.turnOn)).toBeTruthy());
    expect(within(rowFor("(Messages)")).getByText(STRMA.openSettings)).toBeTruthy();
    // Nothing to do for one already granted.
    expect(rowFor("(Mail)").textContent).not.toContain(STRMA.turnOn);
    expect(rowFor("(Mail)").textContent).not.toContain(STRMA.openSettings);
  });

  it("a denial is a plain line under the row, not a crash", async () => {
    await show();
    await waitFor(() => expect(rowFor("(Messages)").textContent).toContain("You said no to this one."));
  });

  it("asking for one re-reads the status afterwards", async () => {
    await show();
    await waitFor(() => expect(within(rowFor("buttons and menus")).getByText(STRMA.turnOn)).toBeTruthy());
    calls.length = 0;
    answer = rows.map((r) => (r.id === "accessibility" ? { ...r, state: "granted" as const } : r));
    await act(async () => { fireEvent.click(within(rowFor("buttons and menus")).getByText(STRMA.turnOn)); });
    await waitFor(() => expect(calls.map((c) => c.name)).toEqual(["macapp.request", "macapp.permissions"]));
    expect(calls[0]!.args).toEqual({ id: "accessibility" });
    await waitFor(() => expect(rowFor("buttons and menus").textContent).toContain(STRMA.stateLabel.granted));
  });

  it("the pane link names a pane, never a URL", async () => {
    await show();
    await waitFor(() => expect(within(rowFor("(Messages)")).getByText(STRMA.openSettings)).toBeTruthy());
    calls.length = 0;
    await act(async () => { fireEvent.click(within(rowFor("(Messages)")).getByText(STRMA.openSettings)); });
    expect(calls).toEqual([{ name: "macapp.openSettings", args: { pane: "automation" } }]);
  });

  it("re-checks when the window comes back into focus (they granted it in System Settings)", async () => {
    await show();
    await waitFor(() => expect(within(rowFor("buttons and menus")).getByText(STRMA.turnOn)).toBeTruthy());
    calls.length = 0;
    answer = rows.map((r) => ({ ...r, state: "granted" as const }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls.map((c) => c.name)).toEqual(["macapp.permissions"]));
    await waitFor(() => expect(document.body.textContent).not.toContain(STRMA.turnOn));
  });

  it("an unreachable Mac says so instead of showing an empty pane", async () => {
    answer = [];
    await show();
    await waitFor(() => expect(screen.getByText(STRMA.appsUnavailable)).toBeTruthy());
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([STRMA.recheck]);
  });
});
