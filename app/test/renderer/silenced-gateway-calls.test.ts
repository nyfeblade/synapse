import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bug 36, THE CLASS — "a surface that renders nothing when its data is absent, without saying why."
 *
 * blank-surfaces.test.tsx drives the surfaces we know about into their failing state and asserts
 * they speak. This file guards the MECHANISM that produces a new one, so the next surface cannot be
 * born silent:
 *
 *   `callQuiet(...)` followed by `.catch(() => {})`.
 *
 * `bridge.ts` is built so that the safe behaviour is the one you get by forgetting: `call()` reports
 * a rejection to the sidebar banner by default, and `callQuiet()` is the one-word, visible opt-out.
 * But `callQuiet` only promises "no BANNER". Pairing it with an empty catch throws the rejection
 * away entirely, and then a surface that renders from that read has no way to tell "the host said
 * no" from "the host never answered". That is exactly what bug 36 was: `getDisplays` was silenced
 * twice over at App.tsx:53, so a failed fetch, a Bot with no display, and a Bot past MAX_SCREENS
 * were one blank rectangle, and bug 3 could not be diagnosed from a user's description of it.
 *
 * THE RULE: a `callQuiet` whose rejection is discarded by an empty catch must be named in
 * SILENT_BY_DESIGN with a reason. Silencing one is not forbidden — it is made deliberate, the way
 * theme-literals.test.ts makes a light-only token deliberate. The reason has to say what the user
 * sees instead, or why there is nothing for them to see.
 *
 * What this deliberately does NOT flag:
 *   - `callQuiet` whose rejection is HANDLED (a try/catch, a `.catch` that records or renders). That
 *     is the fix, not the defect — `loadDisplays()` in computer-state.ts is the model.
 *   - `call(...).catch(() => {})`. `call()` has already reported to the banner by the time that
 *     catch runs; the empty catch there only marks the promise observed.
 *   - Empty catches on things that are not gateway reads (clipboard, Notification.requestPermission).
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const RENDERER = path.join(repoRoot, "app", "src", "renderer");
const EXT = new Set([".ts", ".tsx"]);

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (EXT.has(path.extname(e.name))) yield full;
  }
}

const sources = [...walk(RENDERER)];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** `.catch(() => {})` and its equivalents: a handler that keeps nothing and tells nobody. */
const EMPTY_CATCH = /\.catch\(\s*\(\s*(?:_[A-Za-z0-9_]*)?\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/;

/**
 * Every `callQuiet("cmd", …)` whose own statement discards the rejection. The statement, not the
 * line: a chain broken across lines is the same defect, and a line-by-line scan would miss it.
 */
export function silencedCalls(src: string): { cmd: string; line: number }[] {
  const clean = stripComments(src);
  const out: { cmd: string; line: number }[] = [];
  for (const m of clean.matchAll(/callQuiet\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
    const end = clean.indexOf(";", m.index);
    const statement = clean.slice(m.index, end === -1 ? clean.length : end);
    if (EMPTY_CATCH.test(statement)) out.push({ cmd: m[1]!, line: clean.slice(0, m.index).split("\n").length });
  }
  return out;
}

/**
 * Gateway reads whose rejection may be thrown away, each with the reason. A reason has to answer
 * "and what does the user see instead?".
 */
const SILENT_BY_DESIGN: Record<string, string> = {
  checkApiKey:
    "bug 281: the read of the LAST key check when Settings → Account opens. Without it the panel shows no result, which is also what 'not checked yet' shows, and the Check button right there runs a new check whose failure is shown in the panel's error line.",
  dismissLocalPolicyReset:
    "bug 256: \"Not now\" on the Mac-modes banner hides it at once; if recording the choice fails, the only effect is that the same banner comes back on the next launch, which is still true.",
  answerBotCall:
    "sent when the Mac decides not to ring (quiet hours / Focus) and when the ring card is answered, which removes the card first: there is no surface left for a failure, and an answer that never arrives is recorded by the host's own 30 s ring timeout as a 'Missed call from <Bot>' line the user sees in the chat.",
  endCall:
    "sent as the call screen closes (bug 108): there is no surface left to show a failure on, and the only effect is the 'Voice call ended' marker and the joined-call notes, which the user sees (or not) in the chat itself.",
  wrapUpCall:
    "bug 134: asked as a call closes (the summary is the host's to post in the chat) and at hang-up, where a failure is the same as no line: the call ends with a stock goodbye after 4 s. There is no call screen left to show it on, and the chat still holds the whole call.",
  getForeverBoxStatus:
    "feeds a banner that is absent in the healthy case, so a failed probe shows the user the same thing a healthy box does — and the host's `forever-box` SSE channel replaces it on the next publish.",
  getDiskPressure:
    "same shape: the disk banner is absent unless the disk is low, and the `box-disk-pressure` channel republishes on every poll, so a missed probe self-heals within one interval.",
  voiceSpeculateCancel:
    "bug 142: tells the host to drop a reply it began early because the user kept talking. Nothing is on screen for it (the early reply was never shown), and a lost cancel costs only the tokens of that one dropped reply, which the host counts and logs; the real turn that follows supersedes it either way.",
  getOnboarding:
    "both sites choose between two whole surfaces rather than filling one in: App picks onboarding vs the normal app, Onboarding picks the Sign in button's destination. A failure falls back to the normal path and is re-asked on the next connect; neither leaves a hole on screen.",
};

describe("a silenced gateway read must be a decision, not an accident (bug 36)", () => {
  it("finds renderer sources to check at all (the guard's own smoke test)", () => {
    // A zero from a search is a claim about the pattern, not about the code. If the walk breaks,
    // every assertion below passes vacuously and the guard silently stops guarding.
    expect(sources.length).toBeGreaterThan(60);
    expect(sources.some((f) => f.endsWith(path.join("renderer", "App.tsx")))).toBe(true);
  });

  it("the pattern still finds the callQuiet calls it is about (the guard's second smoke test)", () => {
    const total = sources.reduce((n, f) => n + (fs.readFileSync(f, "utf8").match(/callQuiet\(/g)?.length ?? 0), 0);
    expect(total, "no callQuiet calls found — the bridge API was renamed and this guard is now blind").toBeGreaterThan(5);
  });

  it("every callQuiet with a discarded rejection is named in SILENT_BY_DESIGN, with a reason", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const { cmd, line } of silencedCalls(fs.readFileSync(file, "utf8"))) {
        if (!SILENT_BY_DESIGN[cmd]) offenders.push(`${path.relative(repoRoot, file)}:${line} — callQuiet("${cmd}")`);
      }
    }
    expect(
      offenders,
      `A callQuiet whose rejection is thrown away leaves whatever renders from it unable to tell "the host said no" from "the host never answered" — bug 36.\nRecord the failure (computer-state.ts's loadDisplays is the model) and show it where the data would have been, or add the command to SILENT_BY_DESIGN with a reason:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("SILENT_BY_DESIGN holds no stale entries — a permission nothing uses is deleted, not kept", () => {
    const live = new Set(sources.flatMap((f) => silencedCalls(fs.readFileSync(f, "utf8")).map((s) => s.cmd)));
    expect([...Object.keys(SILENT_BY_DESIGN)].filter((c) => !live.has(c))).toEqual([]);
  });

  it("every reason is a sentence, not a shrug (self-test on the list itself)", () => {
    for (const [cmd, why] of Object.entries(SILENT_BY_DESIGN)) expect(why.length, `${cmd}'s reason is too thin`).toBeGreaterThan(60);
  });

  it("catches the exact line that was bug 36, verbatim (self-test)", () => {
    const bug36 = `    void callQuiet("getDisplays", {}).then((d) => useComputer.getState().apply({ channel: "displays", payload: d })).catch(() => {});`;
    expect(silencedCalls(bug36)).toEqual([{ cmd: "getDisplays", line: 1 }]);
  });

  it("catches a chain broken across lines, and the other empty-handler spellings (self-test)", () => {
    expect(silencedCalls('void callQuiet("getX", {})\n  .then(use)\n  .catch(() => {});')[0]?.cmd).toBe("getX");
    expect(silencedCalls('void callQuiet("getX", {}).catch(() => undefined);')).toHaveLength(1);
    expect(silencedCalls('void callQuiet("getX", {}).catch((_e) => {});')).toHaveLength(1);
  });

  it("does not fire on a callQuiet whose failure is handled (self-test, must not fire)", () => {
    // The fix for bug 36. If the guard flagged this it would be telling people to undo it.
    expect(silencedCalls('const d = await callQuiet("getDisplays", {});')).toEqual([]);
    expect(silencedCalls('void callQuiet("getDisplays", {}).catch((e) => setError(String(e)));')).toEqual([]);
    expect(silencedCalls('useAsync(() => callQuiet("getWorkflows", {}).then((r) => r.workflows), []);')).toEqual([]);
  });

  it("does not fire on call(), which has already reported to the banner (self-test, must not fire)", () => {
    // Real lines from this repo. `call()` reports by default, so the empty catch there only marks
    // the promise observed — flagging them would send someone to "fix" working code.
    expect(silencedCalls('useEffect(() => { void call("listMcpServers", {}).then((r) => setServers(r.servers ?? [])).catch(() => {}); }, []);')).toEqual([]);
    expect(silencedCalls('const poll = () => void call("getNetworkStats", {}).then((r) => setRouted(r.routedThisSession)).catch(() => {});')).toEqual([]);
  });

  it("does not fire on empty catches that are not gateway reads (self-test, must not fire)", () => {
    expect(silencedCalls('void navigator.clipboard?.writeText(text).catch(() => {});')).toEqual([]);
    expect(silencedCalls('void globalThis.Notification?.requestPermission?.().catch(() => {});')).toEqual([]);
  });

  it("does not fire on a commented-out example (self-test, must not fire)", () => {
    // async-resource.ts documents the anti-pattern in its own header comment. Guarding prose would
    // force the next author to delete the explanation to get a green suite.
    expect(silencedCalls('//   useEffect(() => { void callQuiet("getX", {}).then(setV).catch(() => {}); }, []);')).toEqual([]);
    expect(silencedCalls('/* void callQuiet("getX", {}).catch(() => {}); */')).toEqual([]);
  });
});
