import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUARD_MAX_NEW_ENTRIES, GUARD_MIN_FREE_BYTES, isFullRun, isOurs, leftoverMessage, lowDiskRefusal, ourPatterns, repoRoot, sweep, topPrefixes,
} from "../../../scripts/tmp-hygiene";

// Read at collection time, before any beforeAll: the per-file temp root must already be in place (bug-log 128).
const tmpAtLoad = os.tmpdir();
const GB = 1024 ** 3;

describe("test temp hygiene (bug-log 128)", () => {
  it("a helper called while the file is being collected already lands in the per-file temp root", () => {
    expect(path.basename(tmpAtLoad)).toMatch(/^vt-/);
  });

  it("derives the prefixes from the code's mkdtemp calls, including every one seen filling the disk", () => {
    const p = ourPatterns(repoRoot()).prefixes;
    for (const want of ["bots-app-", "ws-", "locsec-", "lochome-", "ptools-", "upd-sig-", "dream-", "gtools-", "conf-", "mkt-sec-", "mkt-sec-h-", "gate-", "bots-settings-ro-", "vt-"]) {
      expect(p, want).toContain(want);
    }
    // Nothing so short it could catch another program's temp entries.
    for (const x of p) expect(x.length, x).toBeGreaterThanOrEqual(3);
  });

  it("recognises only our names: prefix + mkdtemp's 6-char suffix, and the few fixed test names", () => {
    const pat = ourPatterns(repoRoot());
    const yes = ["bots-app-Pd4JUK", "ws-a1B2c3", "mkt-sec-h-QQvyDr", "upd-sig-YNnob1", "vt-csPoCo", "victim-10542-1789887852770", "notes-1789807340040.md"];
    const no = ["com.apple.foo", "ws-", "ws-a1B2c3-extra", "bots-app", "TemporaryItems", "claude-501", "ws-a1B2c", "python-abc123"];
    for (const n of yes) expect(isOurs(n, pat), n).toBe(true);
    for (const n of no) expect(isOurs(n, pat), n).toBe(false);
  });

  it("sweeps only our entries older than the cutoff, read-only fixtures included, and leaves everything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
    const old = (Date.now() - 2 * 3600_000) / 1000;
    const mk = (name: string, age: "old" | "new") => {
      const p = path.join(dir, name);
      fs.mkdirSync(path.join(p, "inner"), { recursive: true });
      fs.writeFileSync(path.join(p, "inner", "f.txt"), "x");
      if (age === "old") fs.utimesSync(p, old, old);
      return p;
    };
    const oldOurs = mk("bots-app-AAAAAA", "old");
    const readOnly = mk("bots-settings-ro-BBBBBB", "old");
    fs.chmodSync(path.join(readOnly, "inner"), 0o500);
    fs.utimesSync(readOnly, old, old);
    const fresh = mk("ws-CCCCCC", "new");
    const foreign = mk("com.apple.DDDDDD", "old");
    const vitestDir = path.join(dir, "__DjUdBIf2D_xk69ZqWf8");
    fs.mkdirSync(path.join(vitestDir, "ssr"), { recursive: true });
    fs.utimesSync(path.join(vitestDir, "ssr"), old, old);
    fs.utimesSync(vitestDir, old, old);
    const liveVitest = path.join(dir, "ZyUNHfKYNGh1fzuMSwrat"); // an old dir whose ssr cache is still being written (watch mode)
    fs.mkdirSync(path.join(liveVitest, "ssr"), { recursive: true });
    fs.utimesSync(liveVitest, old, old);
    const lookalike = path.join(dir, "_1DOD3muopbJlIVcp9w9D"); // same shape, but not vitest's (has other content)
    fs.mkdirSync(path.join(lookalike, "cache"), { recursive: true });
    fs.utimesSync(lookalike, old, old);

    // macOS's own 21-char dirs, empty or not: never vitest's (the first sweep draft tried to remove these)
    const system = ["AudioConverterService", "diagnosticextensionsd", "mediaanalysisd-access"].map((n) => {
      const p = path.join(dir, n);
      fs.mkdirSync(p);
      fs.utimesSync(p, old, old);
      return p;
    });
    const withSsr = path.join(dir, "AudioConverterServicf"); // same shape, only `ssr` inside, but no digit, _ or -
    fs.mkdirSync(path.join(withSsr, "ssr"), { recursive: true });
    fs.utimesSync(path.join(withSsr, "ssr"), old, old);
    fs.utimesSync(withSsr, old, old);

    const r = sweep({ dir, patterns: ourPatterns(repoRoot()), olderThanMs: 3600_000, now: Date.now(), allowAnyDir: true });

    for (const p of [...system, withSsr]) expect(fs.existsSync(p), p).toBe(true);
    expect(r.failed).toBe(0);

    expect(fs.existsSync(oldOurs)).toBe(false);
    expect(fs.existsSync(readOnly)).toBe(false);
    expect(fs.existsSync(vitestDir)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(liveVitest)).toBe(true);
    expect(r.removed).toBe(3);
    expect(r.keptYoung).toBe(2);
  });

  it("refuses to sweep a folder that is not a temp dir", () => {
    const pat = ourPatterns(repoRoot());
    expect(() => sweep({ dir: "/", patterns: pat, olderThanMs: 3600_000, now: Date.now() })).toThrow(/not a temp dir/);
    expect(() => sweep({ dir: os.homedir(), patterns: pat, olderThanMs: 3600_000, now: Date.now() })).toThrow(/not a temp dir/);
  });

  it("the guard fails a run that left more than the cap, naming the top prefixes", () => {
    const pat = ourPatterns(repoRoot());
    const added = [...Array.from({ length: 20 }, (_, i) => `bots-app-${String(i).padStart(6, "a")}`), ...Array.from({ length: 6 }, (_, i) => `ws-${String(i).padStart(6, "b")}`)];
    expect(added.length).toBeGreaterThan(GUARD_MAX_NEW_ENTRIES);
    expect(topPrefixes(added, pat)[0]).toEqual({ prefix: "bots-app-", count: 20 });
    const msg = leftoverMessage(added, "/tmp/x", pat)!;
    expect(msg).toMatch(/left 26 new entries/);
    expect(msg).toMatch(/bots-app- ×20/);
    expect(msg).toMatch(/ws- ×6/);
    expect(msg).toMatch(/npm run clean:tmp/);
    expect(leftoverMessage(added.slice(0, GUARD_MAX_NEW_ENTRIES), "/tmp/x", pat)).toBeNull();
  });

  it("refuses a full run under 10 GB free and says why; a targeted run or the override still starts", () => {
    expect(GUARD_MIN_FREE_BYTES).toBe(10 * GB);
    const full = ["node", "vitest.mjs", "run"];
    const msg = lowDiskRefusal(3.2 * GB, full, {});
    expect(msg).toMatch(/3\.2 GB free/);
    expect(msg).toMatch(/10 GB/);
    expect(msg).toMatch(/temp/i);
    expect(lowDiskRefusal(12 * GB, full, {})).toBeNull();
    expect(lowDiskRefusal(3 * GB, [...full, "host/test/app.test.ts"], {})).toBeNull();
    expect(lowDiskRefusal(3 * GB, full, { SYNAPSE_ALLOW_LOW_DISK: "1" })).toBeNull();
  });

  it("tells a full run from a targeted one", () => {
    expect(isFullRun(["node", "vitest.mjs", "run"])).toBe(true);
    expect(isFullRun(["node", "vitest.mjs", "run", "--project", "host"])).toBe(true);
    expect(isFullRun(["node", "vitest.mjs", "run", "--reporter", "dot", "--silent=false"])).toBe(true);
    expect(isFullRun(["node", "vitest.mjs", "run", "host/test/app.test.ts"])).toBe(false);
    expect(isFullRun(["node", "vitest.mjs", "run", "-t", "journey", "--project", "host"])).toBe(false);
  });

  it("npm test sweeps at the end and keeps vitest's exit code; every project runs the guard", () => {
    const root = repoRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["clean:tmp"]).toMatch(/scripts\/tmp-hygiene\.ts/);
    expect(pkg.scripts.test).toMatch(/vitest run "\$@"; s=\$\?; .*tmp-hygiene\.ts.*; exit \$s/);
    for (const cfg of ["vitest.config.ts", "host/vitest.config.ts", "app/vitest.config.ts", "shared/vitest.config.ts"]) {
      expect(fs.readFileSync(path.join(root, cfg), "utf8"), cfg).toMatch(/globalSetup:.*scripts\/vitest-disk-guard\.ts/);
    }
  });
});
