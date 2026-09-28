import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RoutineDef } from "@synapse/shared";
import { PROBLEM_KEYS, routineProblem, type ProblemKey } from "../../routines/routine-health";

/**
 * Bug 44, THE CLASS — "a failure that is logged and then represented to someone as success."
 *
 * routine-health.test.ts drives the three shapes we know about and asserts the routine's own row
 * tells the truth. This file guards the MECHANISM that produces a new one, so the next routine the
 * host declines to arm cannot be born silent:
 *
 *   `log.warn("…", { routineId })` — the host deciding, about one named routine, not to do
 *   something it was asked to do.
 *
 * That warn is not the defect. Skipping a routine that cannot be armed is correct; an unparseable
 * query genuinely cannot be subscribed. The defect is what happens next: `email-triggers.ts:59` had
 * already checked `r.def.enabled`, so the routine it skipped goes on being listed as **Active**, and
 * the only trace is a line in a host log the user will never read.
 *
 * THE RULE: a warn about a named routine must name the RoutineHealth problem the user is told
 * through — and the problem key is not a label, it is measured: `routineProblem()` has to actually
 * produce it for a routine in that state (the fixtures below), and routine-health.test.ts proves
 * what the user then sees. A warn that cannot name one is a routine failing in silence.
 *
 * This is the host's version of app/test/renderer/silenced-gateway-calls.test.ts, and deliberately
 * keeps its shape: a declaration with a measured reason, a stale-entry check, self-tests on the
 * scanner, and a smoke test so a broken scan cannot pass vacuously.
 *
 * What this deliberately does NOT flag:
 *   - warns that are not about one routine (a Slack socket retry, an IMAP reconnect). Those are
 *     about a connection that retries itself, and no row claims otherwise.
 *   - a routine run that FAILED. That already lands in run history through the fire consumer; it is
 *     the arming step, which produces no run at all, that had no way to speak.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const HOST = path.join(repoRoot, "host");

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (path.extname(e.name) === ".ts") yield full;
  }
}

const sources = [...walk(HOST)];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Every `log.warn("…", { … routineId … })`: the host, about one named routine, declining to arm it.
 * The message literal is the key — it is what a reader greps for when the log is all they have.
 */
export function routineWarnings(src: string): { message: string; line: number }[] {
  const clean = stripComments(src);
  const out: { message: string; line: number }[] = [];
  for (const m of clean.matchAll(/log\.warn\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/g)) {
    const end = clean.indexOf("});", m.index);
    const payload = clean.slice(m.index, end === -1 ? clean.length : end);
    if (/\broutineId\b/.test(payload)) out.push({ message: m[1]!, line: clean.slice(0, m.index).split("\n").length });
  }
  return out;
}

/**
 * Every warn about a named routine, and the RoutineHealth problem the user hears about it through.
 * `problem` is checked against what `routineProblem()` can actually return, so it cannot become a
 * comforting label over a routine that still fails in silence.
 */
const TOLD_THROUGH: Record<string, { problem: ProblemKey; why: string }> = {
  "email routine has an invalid query": {
    problem: "email-query",
    why: "the query cannot be subscribed at all, so the routine is turned off and its run history carries the filter that could not be read — the row stops saying Active. The save path refuses a new one outright.",
  },
  "email routine names an unknown mailbox": {
    problem: "mailbox",
    why: "recoverable: adding the mailbox arms it again by itself, so the routine stays on and its run history says it is not watching yet and which mailbox is missing — Add mailbox is in the same panel.",
  },
  "email mailbox unreachable after retries": {
    problem: "imap",
    why: "recoverable: the mailbox exists and the watcher keeps retrying, so the routine stays on; after N consecutive connect failures the row says it is not watching because the mailbox cannot be reached.",
  },
  "listener failing after retries": {
    problem: "listener",
    why: "recoverable: the GitHub poller or Slack socket keeps retrying with saved credentials that are refused; after N in a row the routine reads as not connected (Connect listener shows on its row) and its run history says to enter the token again.",
  },
  "calendar trigger poll failed": {
    problem: "calendar",
    why: "bug 115, recoverable: the poller retries every minute, so the routine stays on; after N failed events.list calls in a row its row says it can't read the calendar, listenerConnected turns false, and a tray entry says it is not watching.",
  },
  "mac folder poll failed": {
    problem: "mac-folder",
    why: "bug 115, recoverable: the watcher retries every minute (a Mac that is merely away is not a failure), so the routine stays on; after N failed listings in a row its row says the folder can't be listed and names the fix, with a tray entry.",
  },
  "routine has an unparsable schedule": {
    problem: "schedule",
    why: "the scheduler indexes no next run for it, so it is turned off and its run history quotes the schedule it could not read; a routine whose other triggers still work keeps running and says which one is unusable.",
  },
};

/** A routine in each problem state. The map must cover every key, so a new problem cannot arrive untested. */
const FIXTURES: Record<ProblemKey, { def: RoutineDef; hasMailbox: boolean; mailboxReachable?: boolean; listenerFailing?: boolean; calendarFailing?: boolean; macFolderFailing?: boolean; fatal: boolean; says: string }> = {
  listener: {
    def: { name: "PRs", prompt: "p", trigger: { github: { repo: "a/b", events: ["prOpened"] } }, enabled: true, createdAt: 0 },
    hasMailbox: true, listenerFailing: true, fatal: false, says: "GitHub",
  },
  "email-query": {
    def: { name: "Starred", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true, createdAt: 0 },
    hasMailbox: true, fatal: true, says: "is:starred",
  },
  mailbox: {
    def: { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true, createdAt: 0 },
    hasMailbox: false, fatal: false, says: "work",
  },
  imap: {
    def: { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true, createdAt: 0 },
    hasMailbox: true, mailboxReachable: false, fatal: false, says: "work",
  },
  calendar: {
    def: { name: "Prep", prompt: "p", trigger: { calendar: { minutesBefore: 10, calendarId: "team@x.com" } }, enabled: true, createdAt: 0 },
    hasMailbox: true, calendarFailing: true, fatal: false, says: "team@x.com",
  },
  "mac-folder": {
    def: { name: "Downloads", prompt: "p", trigger: { file: { paths: ["mac:~/Downloads"], events: ["created"] } }, enabled: true, createdAt: 0 },
    hasMailbox: true, macFolderFailing: true, fatal: false, says: "~/Downloads",
  },
  schedule: {
    def: { name: "Whenever", prompt: "p", schedule: "every other tuesday-ish", enabled: true, createdAt: 0 },
    hasMailbox: true, fatal: true, says: "every other tuesday-ish",
  },
};

const problemOf = (k: ProblemKey) => routineProblem(FIXTURES[k].def, {
  tz: "America/New_York",
  hasMailbox: () => FIXTURES[k].hasMailbox,
  mailboxReachable: () => FIXTURES[k].mailboxReachable !== false,
  listenerFailing: () => FIXTURES[k].listenerFailing === true,
  calendarFailing: () => FIXTURES[k].calendarFailing === true,
  macFolderFailing: () => FIXTURES[k].macFolderFailing === true,
});

describe("a routine the host declines to arm must say so on its own row (bug 44)", () => {
  it("finds host sources to check at all (the guard's own smoke test)", () => {
    // A zero from a search is a claim about the pattern, not about the code. If the walk breaks,
    // every assertion below passes vacuously and the guard silently stops guarding.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((f) => f.endsWith(path.join("triggers", "email", "email-triggers.ts")))).toBe(true);
  });

  it("the pattern still finds the warns it is about (the guard's second smoke test)", () => {
    const found = sources.flatMap((f) => routineWarnings(fs.readFileSync(f, "utf8")).map((w) => w.message));
    expect(found, "no routine-scoped warns found — log.warn was renamed or reshaped and this guard is now blind").toHaveLength(Object.keys(TOLD_THROUGH).length);
    expect(new Set(found)).toEqual(new Set(Object.keys(TOLD_THROUGH)));
  });

  it("every warn about a named routine is told to the user through a RoutineHealth problem", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const { message, line } of routineWarnings(fs.readFileSync(file, "utf8"))) {
        if (!TOLD_THROUGH[message]) offenders.push(`${path.relative(repoRoot, file)}:${line} — log.warn("${message}")`);
      }
    }
    expect(
      offenders,
      `A routine the host skips goes on being listed as Active — bug 44a. Give routineProblem() a case for it (host/routines/routine-health.ts) so the routine's own row says why, then declare the warn here:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("holds no stale entries — a warn nobody raises any more is deleted, not kept", () => {
    const live = new Set(sources.flatMap((f) => routineWarnings(fs.readFileSync(f, "utf8")).map((w) => w.message)));
    expect(Object.keys(TOLD_THROUGH).filter((m) => !live.has(m))).toEqual([]);
  });

  it("every declared problem is one routineProblem() really produces, and every problem has a fixture", () => {
    // The declaration is measured, not taken on trust: a key nothing can produce is a promise the
    // user never collects on.
    for (const [message, { problem }] of Object.entries(TOLD_THROUGH)) {
      expect(PROBLEM_KEYS, `${message} names a problem that does not exist`).toContain(problem);
      expect(problemOf(problem)?.key, `${message}: routineProblem() does not produce "${problem}" for a routine in that state`).toBe(problem);
    }
    expect(Object.keys(FIXTURES).sort(), "a new problem key needs a fixture here").toEqual([...PROBLEM_KEYS].sort());
    expect(new Set(Object.values(TOLD_THROUGH).map((v) => v.problem)), "a problem nothing warns about").toEqual(new Set(PROBLEM_KEYS));
  });

  it("each problem turns the row honest: the right routines are turned off, and every one of them says why", () => {
    for (const key of PROBLEM_KEYS) {
      const p = problemOf(key)!;
      expect(p.fatal, `${key}: turning the routine off is only right when nothing about it can fire`).toBe(FIXTURES[key].fatal);
      expect(p.detail, `${key} does not tell the user what went wrong`).toContain(FIXTURES[key].says);
      expect(p.detail.length).toBeGreaterThan(40);
    }
  });

  it("every reason is a sentence, not a shrug (self-test on the list itself)", () => {
    for (const [message, { why }] of Object.entries(TOLD_THROUGH)) expect(why.length, `${message}'s reason is too thin`).toBeGreaterThan(60);
  });

  it("catches the exact line that was bug 44a, verbatim (self-test)", () => {
    const bug44 = `        try { query = parseMailQuery(e.query); } catch (err) { log.warn("email routine has an invalid query", { routineId: r.id, error: String(err) }); continue; }`;
    expect(routineWarnings(bug44)).toEqual([{ message: "email routine has an invalid query", line: 1 }]);
  });

  it("catches a call broken across lines (self-test)", () => {
    expect(routineWarnings('log.warn("something skipped", {\n  botId,\n  routineId: rec.id,\n});')[0]?.message).toBe("something skipped");
  });

  it("does not fire on a warn that is not about one routine (self-test, must not fire)", () => {
    // Real lines from this repo. A socket that retries itself is not a row claiming to be Active.
    expect(routineWarnings('log.warn("slack socket failed to start", { error: String(e) });')).toEqual([]);
    expect(routineWarnings('log.warn("github poll failed", { repo: this.d.repo, error: String(e) });')).toEqual([]);
    expect(routineWarnings('log.warn("imap connection lost; reconnecting", { folder: this.d.folder, delayMs: delay });')).toEqual([]);
  });

  it("does not fire on a commented-out example (self-test, must not fire)", () => {
    // This file's own header quotes the defect. Guarding prose would force the next author to
    // delete the explanation to get a green suite.
    expect(routineWarnings('//   log.warn("email routine has an invalid query", { routineId: r.id });')).toEqual([]);
    expect(routineWarnings('/* log.warn("x", { routineId }); */')).toEqual([]);
  });

  it("a healthy routine has no problem at all (self-test, must not fire)", () => {
    const def: RoutineDef = { name: "Morning", prompt: "p", schedule: "0 8 * * *", enabled: true, createdAt: 0 };
    expect(routineProblem(def, { tz: "America/New_York", hasMailbox: () => true })).toBeNull();
  });
});
