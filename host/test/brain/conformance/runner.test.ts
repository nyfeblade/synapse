import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ensureConformance, loadConformance, mergeFlags, resolveRunAsAndCliVersion, runConformance, saveConformance } from "../../../brain/conformance/runner";
import type { ConformanceCheck, ConformanceContext } from "../../../brain/conformance/types";
import { log } from "../../../util/log";

const ctx = {} as ConformanceContext;
const check = (id: string, run: ConformanceCheck["run"], extra: Partial<ConformanceCheck> = {}): ConformanceCheck => ({ id: id as never, title: id, onThrow: {}, run, ...extra });

describe("conformance runner (ORIG-13 §13.1)", () => {
  it("merges fallback flags from failing checks, later checks winning, extraDisallowed unioned", () => {
    const f = mergeFlags([
      { status: "fail", detail: "", flags: { approvalPath: "hook", extraDisallowed: ["A"] } },
      { status: "pass", detail: "" },
      { status: "fail", detail: "", flags: { approvalPath: "defer", extraDisallowed: ["B", "A"] } },
    ]);
    expect(f).toEqual({ ...DEFAULT_FLAGS, approvalPath: "defer", extraDisallowed: ["A", "B"] });
  });

  it("runs checks, turns throws into fails with the check's fallback, and reuses skipped slow results on the same CLI", async () => {
    const checks = [
      check("CT-01", async () => ({ status: "pass", detail: "ok" })),
      check("CT-13", async () => { throw new Error("boom"); }, { onThrow: { warmSessions: false } }),
      check("CT-14", async () => ({ status: "pass", detail: "fresh" }), { slow: true }),
    ];
    const previous = { cliVersion: "2.1.277", ranAt: 1, flags: DEFAULT_FLAGS, results: { "CT-14": { status: "fail" as const, detail: "slow run", flags: { rolloverBytes: 8 } } } };
    const r = await runConformance(checks, ctx, { includeSlow: false, previous, cliVersion: "2.1.277", now: () => 5 });
    expect(r.results["CT-01"]!.status).toBe("pass");
    expect(r.results["CT-13"]).toMatchObject({ status: "fail", detail: "threw: boom" });
    expect(r.results["CT-14"]!.detail).toBe("slow run");
    expect(r.flags).toMatchObject({ warmSessions: false, rolloverBytes: 8 });
    const changed = await runConformance(checks, ctx, { includeSlow: false, previous, cliVersion: "2.2.0", now: () => 5 });
    expect(changed.results["CT-14"]).toBeUndefined();
  });

  it("round-trips the results file in host-private storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    expect(loadConformance(dir)).toBeNull();
    saveConformance(dir, { cliVersion: "2.1.277", ranAt: 1, results: {}, flags: DEFAULT_FLAGS });
    expect(loadConformance(dir)!.cliVersion).toBe("2.1.277");
    expect(fs.statSync(path.join(dir, "brain-conformance.json")).mode & 0o777).toBe(0o600);
  });

  it("resolves runAs and CLI version, defaulting to setpriv when no previous results", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    const mockDetectCliVersion = vi.fn().mockResolvedValue("2.1.277");
    const mockCfg = { hostPrivate: dir, executables: { setpriv: "/usr/bin/claude", bwrap: "/usr/bin/claude-bwrap" } };
    const { runAs, cliVersion, prev } = await resolveRunAsAndCliVersion(mockCfg as any, mockDetectCliVersion);
    expect(runAs).toBe("setpriv");
    expect(cliVersion).toBe("2.1.277");
    expect(prev).toBeNull();
  });

  it("resolves runAs from previous results when available", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    const flagsWithBwrap = { ...DEFAULT_FLAGS, runAs: "bwrap" as const };
    saveConformance(dir, { cliVersion: "2.1.277", ranAt: 1, results: {}, flags: flagsWithBwrap });
    const mockDetectCliVersion = vi.fn().mockResolvedValue("2.1.277");
    const mockCfg = { hostPrivate: dir, executables: { setpriv: "/usr/bin/claude", bwrap: "/usr/bin/claude-bwrap" } };
    const { runAs, cliVersion, prev } = await resolveRunAsAndCliVersion(mockCfg as any, mockDetectCliVersion);
    expect(runAs).toBe("bwrap");
    expect(cliVersion).toBe("2.1.277");
    expect(prev?.flags.runAs).toBe("bwrap");
  });
});

describe("ensureConformance (H-2: a failed boot --version probe must not degrade saved flags)", () => {
  beforeEach(() => { vi.spyOn(log, "warn").mockImplementation(() => {}); vi.spyOn(log, "info").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  const cfgIn = (dir: string) => ({ brain: "claude", hostPrivate: dir, tokenFile: path.join(dir, "no-token"), workspace: dir, executables: { setpriv: "/x", bwrap: "/y" } }) as never;
  const degrading = [check("CT-01", async () => ({ status: "fail", detail: "killed", flags: { sendStreaming: false } }))];
  const known = { cliVersion: "2.1.277", ranAt: 1, results: { "CT-14": { status: "pass" as const, detail: "slow ok", flags: {} } }, flags: { ...DEFAULT_FLAGS, rolloverBytes: 123 } };

  it("keeps the saved flags and file when the version probe fails even after a retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    saveConformance(dir, known);
    const detect = vi.fn().mockResolvedValue(null);
    const run = vi.fn(degrading[0]!.run);
    const f = await ensureConformance(cfgIn(dir), { checks: [{ ...degrading[0]!, run }], detectCliVersion: detect });
    expect(detect).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(f).toEqual(known.flags);
    expect(loadConformance(dir)).toEqual(known);
  });

  it("retries a one-off failed probe (e.g. killed by the boot reap) and reuses saved flags on a match", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    saveConformance(dir, known);
    const detect = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("2.1.277");
    const run = vi.fn(degrading[0]!.run);
    const f = await ensureConformance(cfgIn(dir), { checks: [{ ...degrading[0]!, run }], detectCliVersion: detect });
    expect(run).not.toHaveBeenCalled();
    expect(f).toEqual(known.flags);
  });

  it("still runs and saves on first boot, and on a real version change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    await ensureConformance(cfgIn(dir), { checks: degrading, detectCliVersion: async () => "2.1.277", now: () => 9 });
    expect(loadConformance(dir)).toMatchObject({ cliVersion: "2.1.277", ranAt: 9, flags: { sendStreaming: false } });
    await ensureConformance(cfgIn(dir), { checks: [check("CT-01", async () => ({ status: "pass", detail: "ok" }))], detectCliVersion: async () => "2.2.0", now: () => 10 });
    expect(loadConformance(dir)).toMatchObject({ cliVersion: "2.2.0", ranAt: 10, flags: { sendStreaming: true } });
  });
});

describe("saveConformance (H-2: never persist cliVersion:null over a known version)", () => {
  beforeEach(() => { vi.spyOn(log, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("refuses a null-version write over a known version, and allows it when nothing is known yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
    expect(saveConformance(dir, { cliVersion: null, ranAt: 1, results: {}, flags: DEFAULT_FLAGS })).toBe(true);
    expect(saveConformance(dir, { cliVersion: "2.1.277", ranAt: 2, results: {}, flags: DEFAULT_FLAGS })).toBe(true);
    expect(saveConformance(dir, { cliVersion: null, ranAt: 3, results: {}, flags: { ...DEFAULT_FLAGS, stopNudge: false } })).toBe(false);
    expect(loadConformance(dir)).toMatchObject({ cliVersion: "2.1.277", ranAt: 2, flags: { stopNudge: true } });
  });
});
