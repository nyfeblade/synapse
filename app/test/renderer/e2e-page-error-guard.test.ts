import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PageErrors, attachedSinkCount, register, settleAll } from "../../e2e/page-error-sink";

/**
 * Bug 14, guarded as a CLASS.
 *
 * Several e2e specs took an `errors: string[]` out of `launch()` and never looked at it, so a
 * renderer crash mid-journey was collected and thrown away. The specs that did look asserted
 * `expect(errors).toEqual([])` on the LAST line of a 60-step journey — which only runs if the
 * journey reaches the last line, so it caught loud failures and missed exactly the quiet ones.
 *
 * The fix is mechanical (`app/e2e/page-errors.ts`): the verdict happens in fixture teardown, keyed
 * to the window, so forgetting is the safe behaviour. This file is what stops spec number N+1 from
 * rebuilding the old shape — by importing plain `test`, or hand-rolling its own listener array, or
 * excusing an error without saying which error and why. There is no allowlist: every rule below is
 * measured per file against the real tree, and the exemptions are checked for shape rather than
 * listed by name.
 */

const REPO = path.resolve(__dirname, "..", "..", "..");
const E2E = path.join(REPO, "app", "e2e");

/** The one file allowed to attach listeners and to import Playwright's own `test`: the guard itself. */
const GUARD = path.join(E2E, "page-errors.ts");

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

const files = [...walk(E2E)];
const specs = files.filter((f) => f.endsWith(".e2e.ts"));
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(REPO, f);

// ---------------------------------------------------------------------------------------------
// The rules, as functions, so each one can be shown a line it must reject and lines it must not.
// ---------------------------------------------------------------------------------------------

/** A spec that imports Playwright's own `test` runs without the guard fixture. Type-only imports and
 *  the other bindings (`expect`, `_electron`, `type Page`) are none of this rule's business. */
export function importsRawPlaywrightTest(line: string): boolean {
  const m = /^\s*import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@playwright\/test["']/.exec(line);
  if (!m || m[1]) return false;
  return m[2]!
    .split(",")
    .map((b) => b.trim())
    .some((b) => !b.startsWith("type ") && /^test(\s+as\s+\w+)?$/.test(b));
}

/** A hand-rolled page-error/console listener is the old defect: an array nobody has to read. */
const HAND_ROLLED_LISTENER = /\.on\(\s*["'](pageerror|console)["']/;

/** The old shape itself: `const errors: string[] = []`. */
const ERROR_ARRAY = /\b(?:const|let)\s+\w*[Ee]rrors?\w*\s*:\s*string\[\]\s*=\s*\[\]/;

/** An exemption: `<sink>.expect(<pattern>, "<why>")`, pattern either inline or a named const. */
const EXEMPTION = /\.expect\(\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*|[A-Z][A-Z0-9_]*)\s*,\s*("(?:[^"\\]|\\.)*")/g;
/** Any `.expect(` at all, so a malformed exemption is counted rather than skipped. */
const ANY_EXEMPTION_CALL = /\.expect\(/g;
/** Patterns wide enough to excuse anything — the allowlist this guard exists to prevent. */
const BLANKET = new Set(["", ".", ".*", ".+", "[\\s\\S]*", "[\\s\\S]+", "^", "(?:)"]);

function codeLines(src: string): { line: string; n: number }[] {
  return src.split("\n").flatMap((line, i) => {
    const t = line.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? [] : [{ line, n: i + 1 }];
  });
}

describe("bug 14: an e2e page error fails its journey by default", () => {
  it("finds e2e specs to check at all (the guard's own smoke test)", () => {
    // A zero from a search is a claim about the pattern, not about the code. If this walk breaks,
    // every rule below passes vacuously and the guard silently stops guarding.
    expect(files.length).toBeGreaterThan(15);
    expect(specs.length).toBeGreaterThan(11);
    expect(specs.map(rel)).toContain("app/e2e/a11y.e2e.ts");
    expect(specs.map(rel)).toContain("app/e2e/packaged/packaged-smoke.e2e.ts");
    expect(fs.existsSync(GUARD)).toBe(true);
  });

  it("every spec runs under the guarded `test`, not Playwright's", () => {
    const offenders: string[] = [];
    for (const f of specs) {
      const src = read(f);
      for (const { line, n } of codeLines(src)) {
        if (importsRawPlaywrightTest(line)) offenders.push(`${rel(f)}:${n} imports \`test\` from @playwright/test`);
      }
      if (!/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["'](?:\.\.?\/)+page-errors["']/.test(src)) {
        offenders.push(`${rel(f)} does not import { test } from the page-error guard`);
      }
    }
    expect(offenders, `a spec running Playwright's own \`test\` has no page-error teardown:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no spec collects page or console errors by hand", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (path.resolve(f) === GUARD) continue; // the guard IS the listener
      for (const { line, n } of codeLines(read(f))) {
        if (HAND_ROLLED_LISTENER.test(line)) offenders.push(`${rel(f)}:${n} — ${line.trim().slice(0, 100)}`);
        if (ERROR_ARRAY.test(line)) offenders.push(`${rel(f)}:${n} — ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders, `use watchPageErrors(page, label) — a hand-rolled array is one nobody has to read:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("every file that launches an Electron app attaches the guard to its window", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (path.resolve(f) === GUARD) continue;
      const src = read(f);
      if (!/electron\.launch\(/.test(src)) continue;
      if (!/watchPageErrors\(/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, `these open a window nothing is watching:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("every expected-error exemption names one error and says why", () => {
    const offenders: string[] = [];
    for (const f of files) {
      // Code only: the guard's own doc comments spell `.expect(pattern, why)` out in prose.
      const src = codeLines(read(f)).map((l) => l.line).join("\n");
      const declared = new Map<string, string>();
      for (const m of src.matchAll(/^const\s+([A-Z][A-Z0-9_]*)\s*=\s*\/((?:[^/\\\n]|\\.)+)\//gm)) declared.set(m[1]!, m[2]!);
      const calls = [...src.matchAll(ANY_EXEMPTION_CALL)].length;
      const parsed = [...src.matchAll(EXEMPTION)];
      if (parsed.length !== calls) {
        offenders.push(`${rel(f)} — ${calls - parsed.length} exemption call(s) not of the form .expect(/pattern/, "why")`);
      }
      for (const m of parsed) {
        const raw = m[1]!;
        const source = raw.startsWith("/") ? raw.slice(1, raw.lastIndexOf("/")) : declared.get(raw);
        const why = m[2]!.slice(1, -1);
        if (source === undefined) offenders.push(`${rel(f)} — exemption pattern \`${raw}\` is not a regex literal declared in this file`);
        else if (BLANKET.has(source)) offenders.push(`${rel(f)} — exemption /${source}/ excuses every error`);
        if (why.trim().length < 20) offenders.push(`${rel(f)} — exemption reason "${why}" does not say why the error is correct`);
      }
    }
    expect(offenders, `an exemption is a claim about ONE error:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the guard is actually wired as an always-on fixture", () => {
    // Without `auto: true` the fixture is never instantiated and every rule above guards an
    // ornament: specs would import a `test` that does nothing.
    const src = read(GUARD);
    expect(src).toMatch(/base\.extend<\{\s*pageErrorGuard/);
    expect(src).toMatch(/\{\s*auto:\s*true\s*\}/);
    expect(src).toMatch(/await settleAll\(\)/);
    // The verdict must come AFTER the body returns, not inside it, or it dies with the body.
    expect(src.indexOf("await use()")).toBeLessThan(src.indexOf("await settleAll()"));
  });

  // -------------------------------------------------------------------------------------------
  // Self-tests. A rule is only as good as what it refuses AND what it leaves alone; the last guard
  // to land here (file-url-decoding.test.ts) had a first draft that flagged three correct sites.
  // -------------------------------------------------------------------------------------------

  it("rejects the exact shapes bug 14 was made of (self-test)", () => {
    expect(importsRawPlaywrightTest('import { expect, test } from "@playwright/test";')).toBe(true);
    expect(importsRawPlaywrightTest('import { expect, test, type Page } from "@playwright/test";')).toBe(true);
    expect(importsRawPlaywrightTest('import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";')).toBe(true);
    expect(importsRawPlaywrightTest('import { test as base } from "@playwright/test";')).toBe(true);
    expect(HAND_ROLLED_LISTENER.test('  win.on("pageerror", (e) => errors.push(e.message));')).toBe(true);
    expect(HAND_ROLLED_LISTENER.test('  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });')).toBe(true);
    expect(ERROR_ARRAY.test("  const errors: string[] = [];")).toBe(true);
    expect(ERROR_ARRAY.test("const rendererErrors: string[] = [];")).toBe(true);
  });

  it("leaves correct code alone (self-test)", () => {
    // Every line here is a real line from this tree that a wider rule would have flagged. Pinned so
    // a future widening fails loudly instead of quietly sending someone to "fix" working code — a
    // guard that fires on correct code gets an allowlist bolted on, and then it guards nothing.
    expect(importsRawPlaywrightTest('import { expect, type Page } from "@playwright/test";')).toBe(false);
    expect(importsRawPlaywrightTest('import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";')).toBe(false);
    expect(importsRawPlaywrightTest('import type { BotSummary } from "@synapse/shared";')).toBe(false);
    expect(importsRawPlaywrightTest('import { test, watchPageErrors } from "./page-errors";')).toBe(false);
    expect(importsRawPlaywrightTest('import { defineConfig } from "@playwright/test";')).toBe(false);
    expect(HAND_ROLLED_LISTENER.test('  app.process().stderr?.on("data", (d: Buffer) => mainStderr.push(d.toString()));')).toBe(false);
    expect(HAND_ROLLED_LISTENER.test('  const chooser = win.waitForEvent("filechooser");')).toBe(false);
    expect(HAND_ROLLED_LISTENER.test('    const off = bots.native.on("dictation", (p) => { off(); resolve(p); });')).toBe(false);
    expect(HAND_ROLLED_LISTENER.test('  page.on("close", () => { sink.closed = true; });')).toBe(false);
    expect(ERROR_ARRAY.test("const surfaces: string[] = [];")).toBe(false);
    expect(ERROR_ARRAY.test("  const failures: string[] = [];")).toBe(false);
    expect(ERROR_ARRAY.test("  const bad: string[] = [];")).toBe(false);
  });

  it("an exemption is parsed, a bare one is counted as malformed (self-test)", () => {
    const good = `c.errors.expect(/^Blocked script/, "the preview iframe is sandbox=\\"\\" on purpose");`;
    expect([...good.matchAll(EXEMPTION)]).toHaveLength(1);
    expect([...good.matchAll(ANY_EXEMPTION_CALL)]).toHaveLength(1);
    const bare = `errors.expect(somePattern);`;
    expect([...bare.matchAll(EXEMPTION)]).toHaveLength(0);
    expect([...bare.matchAll(ANY_EXEMPTION_CALL)]).toHaveLength(1);
    // Playwright's own assertions must not read as exemptions.
    expect([...`await expect(win.locator(".connection")).toBeVisible();`.matchAll(ANY_EXEMPTION_CALL)]).toHaveLength(0);
    expect([...`await expect.poll(async () => x, { timeout: 5 }).toBe(1);`.matchAll(ANY_EXEMPTION_CALL)]).toHaveLength(0);
  });
});

describe("the sink's verdict", () => {
  const surface = () => Promise.resolve('overlay "Marketplace", focus on button[Close Marketplace]');
  let clock = 0;
  const now = () => clock;

  beforeEach(async () => {
    clock = 0;
    // Retire anything a previous test left attached, so counts below mean what they say.
    await settleAll();
    expect(attachedSinkCount()).toBe(0);
  });

  const sink = (label = "launch(fuzz-b1b4)") => new PageErrors(label, surface, now, 0);

  it("names the step and the surface, not just the journey", async () => {
    const s = sink();
    clock = 4200;
    s.record("pageerror", "Cannot read properties of undefined (reading 'icon')", "open the Marketplace");
    const [problem] = await s.verdict();
    expect(problem).toContain("launch(fuzz-b1b4): unexpected pageerror at +4200ms during open the Marketplace");
    expect(problem).toContain("Cannot read properties of undefined");
    expect(problem).toContain('app was showing: overlay "Marketplace"');
  });

  it("passes when nothing happened, and needs nobody to ask", async () => {
    expect(await sink().verdict()).toEqual([]);
  });

  it("an expected error is excused, and only that error", async () => {
    const s = sink("p2:fz2-previews");
    s.expect(/^Blocked script execution in 'about:srcdoc'/, "the HTML preview is a sandbox=\"\" iframe on purpose");
    s.record("console.error", "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed", "open the HTML preview");
    s.record("pageerror", "TypeError: preview is not a function", "open the HTML preview");
    const problems = await s.verdict();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("TypeError: preview is not a function");
  });

  it("an exemption for an error that never arrives fails too", async () => {
    const s = sink("p2:fz2-previews");
    s.expect(/^Blocked script execution/, "the HTML preview is a sandbox=\"\" iframe on purpose");
    const problems = await s.verdict();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("never occurred");
    // …unless it is declared conditional, in writing.
    const t = sink();
    t.expect(/^Blocked script execution/, "only fires when the preview pane actually renders the HTML", { required: false });
    expect(await t.verdict()).toEqual([]);
  });

  it("stops at the quit, because the shutdown is not part of the journey", async () => {
    // The renderer's gateway client logs `Connection closed (code: 1006)` as its socket dies during a
    // normal `app.close()`. Recording past that point turned p3-disk red on the first real run of
    // this guard — a verdict about the close, not about the journey, and nondeterministic besides.
    // Every assertion this guard replaces ran before `app.close()`, so this is parity, not a hole.
    const s = sink("p3:p3-disk");
    s.record("console.error", "a real error, mid-journey", "open Disk Saver");
    s.closed = true; // what watchPageErrors sets the moment the journey calls app.close()
    s.record("console.error", "Failed when connecting: Connection closed (code: 1006)", "(no step declared)");
    const problems = await s.verdict();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a real error, mid-journey");
  });

  it("refuses a nameless or blanket exemption at the point it is written", () => {
    expect(() => sink().expect(/^x/, "   ")).toThrow(/must say why/);
    expect(() => sink().expect(/.*/, "because the journey is noisy")).toThrow(/excuses every error/);
    expect(() => sink().expect(/[\s\S]*/, "because the journey is noisy")).toThrow(/excuses every error/);
  });

  it("a serial suite is judged per test: closed sinks retire, open ones start clean", async () => {
    const open = sink("packaged smoke");
    const closed = sink("launch(e2e-link-guard)");
    register(open);
    register(closed);
    open.record("pageerror", "first test's error", "a window appears");
    closed.record("pageerror", "the other app's error", "clicked link");
    closed.closed = true; // this journey has quit; it is still judged for the test it belonged to

    const first = await settleAll();
    expect(first).toHaveLength(2);
    expect(attachedSinkCount()).toBe(1); // the closed one is done with

    // The open window keeps its listeners but does not re-report what was already reported.
    expect(await settleAll()).toEqual([]);
    open.record("pageerror", "second test's error", "the bundled host launched");
    const third = await settleAll();
    expect(third).toHaveLength(1);
    expect(third[0]).toContain("second test's error");
    open.closed = true;
    await settleAll();
  });
});
