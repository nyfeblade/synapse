// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupsSection } from "../../src/renderer/components/settings/BackupsSection";

const calls: { name: string; args: unknown }[] = [];
let responses: Record<string, unknown> = {};
const status = (over: Record<string, unknown> = {}) => ({
  settings: { auto: true, keep: 7, dir: "/Users/u/Library/Application Support/Synapse/backups" }, defaultDir: "/Users/u/Library/Application Support/Synapse/backups",
  lastAt: null, lastError: null, running: null, recoveryPending: false,
  archives: [{ file: "/b/Synapse-2026-09-20-101010.synbak", name: "Synapse-2026-09-20-101010.synbak", createdAt: Date.parse("2026-09-20T10:10:10Z"), bytes: 2_500_000, reason: "manual" }], ...over,
});

beforeEach(() => {
  calls.length = 0;
  responses = { "backups.status": status(), "backups.recoveryCode": { code: null } };
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (name: string, args: unknown) => {
        calls.push({ name, args });
        const r = responses[name];
        if (r instanceof Error) return { ok: false, error: { code: "NATIVE_ERROR", message: r.message } };
        return { ok: true, result: r ?? {} };
      }),
      on: () => () => {},
    },
  };
});
afterEach(cleanup);

describe("Settings → Backups", () => {
  it("backs up now, shows the daily switch on by default, and lists archives", async () => {
    render(<BackupsSection />);
    expect(await screen.findByText("No backup yet")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Back up automatically every day" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Synapse-2026-09-20-101010.synbak")).toBeTruthy();
    responses["backups.backupNow"] = { file: "/b/x.synbak" };
    responses["backups.recoveryCode"] = { code: "SYN-AAAA-BBBB" };
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("SYN-AAAA-BBBB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain("backups.ackRecoveryCode"));
  });

  it("previews, asks for the recovery code when needed, confirms, then restores", async () => {
    render(<BackupsSection />);
    await screen.findByText("Synapse-2026-09-20-101010.synbak");
    responses["backups.preview"] = new Error("This backup was made on another Mac or with another key. Enter its recovery code.");
    fireEvent.click(screen.getByRole("button", { name: "Restore…" }));
    const code = await screen.findByLabelText("Recovery code");
    responses["backups.preview"] = { file: "/b/Synapse-2026-09-20-101010.synbak", createdAt: Date.parse("2026-09-20T10:10:10Z"), bytes: 2_500_000, bots: [{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }], appVersion: "0.1.0", hostVersion: "0.1.0", sessions: true, macFiles: [], reason: "manual" };
    fireEvent.change(code, { target: { value: "SYN-CODE" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Nova, Orbit")).toBeTruthy();
    expect(calls.find((c) => c.name === "backups.preview" && (c.args as { code?: string }).code === "SYN-CODE")).toBeTruthy();
    responses["backups.restore"] = { ok: true, bots: 2, verified: true, macSecretsSkipped: false, hostSealed: "applied" };
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(/Restored 2 Bots\. Checked/)).toBeTruthy();
  });
});
