// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRAL, type MacActionView } from "@synapse/shared";
import { ActivitySection, shortTarget } from "../../src/renderer/components/settings/ActivitySection";
import { DryRunRow } from "../../src/renderer/components/DryRunRow";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const row = (o: Partial<MacActionView>): MacActionView => ({ id: "x", at: Date.now(), botId: "a", kind: "write", op: "write-file", targets: ["/Users/me/Projects/site/src/index.ts"], outcome: "done", via: "full-auto", undo: "available", ...o });

beforeEach(() => {
  useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, connection: { kind: "connected" }, settingsFocus: "activity" } as never);
});
afterEach(cleanup);

describe("5.6 Settings → Activity", () => {
  it("lists actions quietly: labels, a short target, the outcome and what allowed it; Undo only where it can", async () => {
    installFakeBridge({ listMacActions: { entries: [row({ id: "w" }), row({ id: "c", kind: "command", op: "run-command", targets: ["npm test"], undo: "none", undoNote: STRAL.noUndoCommand, via: "card" })], more: false } });
    render(<ActivitySection />);
    await screen.findByText("…/site/src/index.ts");
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("Done · Full auto")).toBeTruthy();
    expect(screen.getByText("Done · Approved")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Undo / })).toHaveLength(1);
    // Titles and labels only: no explanatory line for "no undo".
    expect(document.body.textContent).not.toContain(STRAL.noUndoCommand);
  });

  it("Undo asks first, then shows a conflict on the row without changing anything else", async () => {
    const f = installFakeBridge({ listMacActions: { entries: [row({ id: "w" })], more: false }, undoMacAction: { ok: false, conflict: true, message: STRAL.conflict } });
    window.confirm = () => true;
    render(<ActivitySection />);
    fireEvent.click(await screen.findByRole("button", { name: /^Undo / }));
    await screen.findByText(STRAL.conflict);
    expect(f.calls.find(([c]) => c === "undoMacAction")?.[1]).toEqual({ id: "w", confirm: true });
  });

  it("filters by kind and Bot, from a Bot's own link", async () => {
    useUi.setState({ settingsFocus: "activity/a" } as never);
    const f = installFakeBridge({ listMacActions: { entries: [], more: false } });
    render(<ActivitySection />);
    await screen.findByText(STRAL.empty);
    expect(f.calls.find(([c]) => c === "listMacActions")?.[1]).toMatchObject({ botId: "a", filter: "all" });
    fireEvent.click(screen.getByRole("radio", { name: STRAL.filters["dry-run"] }));
    await waitFor(() => expect(f.calls.some(([c, a]) => c === "listMacActions" && (a as { filter: string }).filter === "dry-run")).toBe(true));
  });

  it("shortens only long absolute paths", () => {
    expect(shortTarget("/a/b")).toBe("/a/b");
    expect(shortTarget("/Users/x/p/q/r.txt")).toBe("…/p/q/r.txt");
    expect(shortTarget("echo /a/b/c/d")).toBe("echo /a/b/c/d");
  });
});

describe("5.6 Dry run row", () => {
  it("reads the Mac's mode and saves a new one", async () => {
    const f = installFakeBridge({ getLocalDryRun: { mode: "off" }, setLocalDryRun: (a: { mode: string }) => ({ mode: a.mode }) });
    render(<DryRunRow botId="a" />);
    const on = await screen.findByRole("radio", { name: STRAL.dryRunModes.on });
    await waitFor(() => expect(screen.getByRole("radio", { name: STRAL.dryRunModes.off }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(on);
    await waitFor(() => expect(on.getAttribute("aria-checked")).toBe("true"));
    expect(f.calls.find(([c]) => c === "setLocalDryRun")?.[1]).toEqual({ id: "a", mode: "on" });
  });
});

describe("5.6 Undo's confirm", () => {
  it("commits with the neutral primary button, not the danger one", async () => {
    const { ConfirmHost } = await import("../../src/renderer/components/ConfirmDialog");
    installFakeBridge({ listMacActions: { entries: [row({ id: "w" })], more: false }, undoMacAction: { ok: true } });
    render(<><ConfirmHost /><ActivitySection /></>);
    fireEvent.click(await screen.findByRole("button", { name: /^Undo / }));
    const confirm = await screen.findByRole("button", { name: STRAL.undoVerb, exact: true } as never);
    expect(confirm.className).toBe("btn-primary");
    expect(document.querySelector(".confirm-dialog .btn-danger")).toBeNull();
  });
});
