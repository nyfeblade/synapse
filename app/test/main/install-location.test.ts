import { describe, expect, it, vi } from "vitest";
import { offerMoveToApplications } from "../../src/main/install-location";

// Portable install: run from the DMG or Downloads, macOS translocates the app to a random read-only path —
// updates can't replace it, synapse:// and .botpack don't find it, and every launch is a "new" app. The first
// launch outside /Applications offers to move it (Electron's own move, which relaunches from there).
// Fix round 1: an existing /Applications/Synapse.app is never replaced silently: a newer one is kept (refused),
// an older or equal one is replaced only when the user says so, and a running one is never touched.
describe("offering to move Synapse to Applications", () => {
  const base = () => ({
    packaged: true, inApplications: false, fuzz: false, alreadyDeclined: false, currentVersion: "0.2.0",
    existing: vi.fn((): { version: string } | null => null),
    ask: vi.fn(async () => "move" as const),
    confirmReplace: vi.fn(async (_v: string) => true),
    move: vi.fn((conflict: (kind: "exists" | "existsAndRunning") => boolean) => { void conflict; return true; }),
    remember: vi.fn(),
  });

  it("asks once, and moves when the user says so", async () => {
    const o = base();
    expect(await offerMoveToApplications(o)).toBe("moved");
    expect(o.ask).toHaveBeenCalledOnce();
    expect(o.move).toHaveBeenCalledOnce();
  });

  it("Not now is remembered and never asked again", async () => {
    const o = { ...base(), ask: vi.fn(async () => "later" as const) };
    expect(await offerMoveToApplications(o)).toBe("declined");
    expect(o.remember).toHaveBeenCalledOnce();
    expect(o.move).not.toHaveBeenCalled();
    expect(await offerMoveToApplications({ ...base(), alreadyDeclined: true })).toBe("skipped");
  });

  it("never asks in /Applications, in a dev run, or under test", async () => {
    for (const o of [{ ...base(), inApplications: true }, { ...base(), packaged: false }, { ...base(), fuzz: true }]) {
      expect(await offerMoveToApplications(o)).toBe("skipped");
      expect(o.ask).not.toHaveBeenCalled();
    }
  });

  it("a move macOS refuses leaves the app running where it is", async () => {
    const o = { ...base(), move: vi.fn(() => { throw new Error("in use"); }) };
    expect(await offerMoveToApplications(o)).toBe("failed");
  });

  it("a NEWER Synapse already in Applications is kept: nothing is moved or replaced", async () => {
    const o = { ...base(), existing: vi.fn(() => ({ version: "0.3.0" })) };
    expect(await offerMoveToApplications(o)).toBe("kept-newer");
    expect(o.move).not.toHaveBeenCalled();
    expect(o.confirmReplace).not.toHaveBeenCalled();
  });

  it("an older one is replaced only after the user says so, by name", async () => {
    const yes = { ...base(), existing: vi.fn(() => ({ version: "0.1.0" })) };
    expect(await offerMoveToApplications(yes)).toBe("moved");
    expect(yes.confirmReplace).toHaveBeenCalledWith("0.1.0");
    const no = { ...base(), existing: vi.fn(() => ({ version: "0.1.0" })), confirmReplace: vi.fn(async () => false) };
    expect(await offerMoveToApplications(no)).toBe("declined");
    expect(no.move).not.toHaveBeenCalled();
  });

  it("the conflict handler Electron calls never replaces a running copy, and replaces a stopped one only as confirmed", async () => {
    let handler!: (kind: "exists" | "existsAndRunning") => boolean;
    const o = { ...base(), existing: vi.fn(() => ({ version: "0.1.0" })), move: vi.fn((c: (kind: "exists" | "existsAndRunning") => boolean) => { handler = c; return true; }) };
    await offerMoveToApplications(o);
    expect(handler("existsAndRunning")).toBe(false);
    expect(handler("exists")).toBe(true);
    // No existing copy was seen before the move: a conflict that appears anyway is refused, not trashed.
    const fresh = { ...base(), move: vi.fn((c: (kind: "exists" | "existsAndRunning") => boolean) => { handler = c; return true; }) };
    await offerMoveToApplications(fresh);
    expect(handler("exists")).toBe(false);
  });
});
