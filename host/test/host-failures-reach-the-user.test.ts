import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE CLASS behind bugs 44, 47, 51 and 52: "a host-side failure is logged, and a surface goes on
 * reporting a state with no action for it." Each of them was a `log.warn` / `log.error` in `host/`
 * that nobody reads, while the UI said Active, connected, ON, or "watching and taking notes".
 *
 * `unarmable-routine-warnings.test.ts` guards one shape of it (a warn about a named routine). This
 * guards every shape: EVERY `log.warn(` / `log.error(` under `host/` must be declared here, with a
 * reason the test MEASURES — never a list of names to skip:
 *
 *   - `user`:     the failure reaches the user as a state with an action, and a named test proves
 *                 that user-visible outcome. Measured: the test file exists and has that `it(` title.
 *   - `contained`: nothing the user sees claims success — the failure is retried, falls back to a
 *                 safe reading, is told to the Bot, or is answered with an error the caller shows.
 *                 Measured: the code that does so (`evidence`) is within a few lines of the log call,
 *                 so if that code goes away the declaration goes stale and this test fails.
 *   - `filed`:    a known instance of the class not fixed yet. Measured: the bug-log row exists, is
 *                 not merged, and names this file — so the hole is on the record, not hidden here.
 *
 * A new warn therefore cannot arrive silent: its author has to say, checkably, how the user hears.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const HOST = path.join(repoRoot, "host");
const WINDOW = 6;

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (path.extname(e.name) === ".ts") yield full;
  }
}

/**
 * Comments out, strings and line numbers kept: a quoted example in a comment is prose, not a call.
 * A scanner, not a regex: a line comment that mentions a glob (`~/.claude/projects/**`) opens a
 * "block comment" to a regex and swallowed a real call in bot-service.ts on this guard's first run.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface LogSite { message: string; line: number; window: string }

/** Every `log.warn("…"` / `log.error("…"` call, its message literal, and the lines around it. */
export function logSites(src: string): LogSite[] {
  const clean = stripComments(src);
  const lines = clean.split("\n");
  const out: LogSite[] = [];
  for (const m of clean.matchAll(/\blog\.(?:warn|error)\(\s*(["'`])((?:(?!\1).)*)\1/g)) {
    const line = clean.slice(0, m.index).split("\n").length;
    out.push({ message: m[2]!, line, window: lines.slice(Math.max(0, line - 1 - WINDOW), line + WINDOW).join("\n") });
  }
  return out;
}

type Declaration =
  | { user: { test: string; title: string }; why: string }
  | { contained: string; why: string }
  | { filed: number; why: string };

const DECLARED: Record<string, Declaration> = {
  "host/backup/host-backup.ts|backup restore failed; the previous state was kept": {
    user: { test: "app/test/main/backup-service.test.ts", title: "a restore the host rejects leaves the Mac untouched and says why" },
    why: "bug 109: the failure is written to restore-result.json, /health reports it as lastRestore { ok: false, message }, and the Mac's restore throws that message into Settings → Backups.",
  },
  "host/backup/routes.ts|backup route failed": {
    contained: "res.writeHead(500)",
    why: "bug 109: the route answers 500, so the Mac's Back up now / restore rejects with the host's status and Settings → Backups shows it; nothing is half-written (the snapshot's work folder is removed).",
  },
  "host/github/signin.ts|github sign-in did not start": {
    contained: 'throw new GatewayError("GITHUB_SIGNIN_FAILED"',
    why: "bug 195: the start rejects with gh's own reason, and Bot settings → GitHub shows that message in the row with Try again (app/test/renderer/github-row.test.tsx).",
  },
  "host/github/signin.ts|github sign-in failed": {
    user: { test: "host/test/github/signin.test.ts", title: "a failed sign-in after the code says why" },
    why: "bug 195: the failure goes out as a github event {failed, reason} (or {expired}); Bot settings → GitHub shows the reason with Try again.",
  },
  "host/github/signin.ts|github sign-in had unexpected permissions; logged out": {
    user: { test: "host/test/github/signin.test.ts", title: "is logged out again and reported" },
    why: "bug 195: the token is logged out at once and a github event {failed, reason} says which permissions were unexpected; Bot settings → GitHub shows it with Try again.",
  },
  "host/github/signin.ts|gh auth setup-git failed": {
    contained: 'state: "signed-in"',
    why: "bug 195: gh itself is signed in and works (its token is in the Bot's hosts.yml); only plain git's credential helper is missing, and the git shim pins credential.helper empty for Bots anyway.",
  },
  // ---- the rows this guard was written for ----
  "host/phase4.ts|webhook listener re-bind failed": {
    user: { test: "host/test/triggers/webhook-rebind.test.ts", title: "keeps accepting webhooks from this computer, and the row says why the switch went back off" },
    why: "bug 52: the setting is put back, the old address is bound again, and the switch's own row says why it is off and that turning it on retries.",
  },
  "host/phase4.ts|teach sidecar failed; recording video only": {
    user: { test: "host/test/teach/recorder.test.ts", title: "while recording, the user is told clicks and typing are not being captured" },
    why: "bug 47: the teach status carries videoOnly, the recording bar says only video is captured and names Stop & save / Discard; session.json records sidecarVersion 0.",
  },
  "host/triggers/email/imap-idle.ts|imap connection lost; reconnecting": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "an unreachable mailbox's row names the action that fixes it" },
    why: "bug 51: after N consecutive failures the routine's row says the mailbox cannot be reached and to re-enter it with Add mailbox, which reconnects with the new details.",
  },
  "host/groups/orchestrator.ts|room attachment unreadable": {
    contained: "couldn't be read. Ask them to send it again.",
    why: "bug 126: a room post's attachment that can't be read from the host store is told to the answering Bot in its turn prompt, which asks the user to send it again; the post itself still goes.",
  },
  "host/triggers/email/email-in.ts|email in: message skipped": {
    user: { test: "host/test/triggers/email-in.test.ts", title: "a message routed to a Bot that can't be read is told to the owner, and labelling it again retries" },
    why: "4.3: a Gmail error while reading a routed email-in message raises one tray per Bot (\"Email to <Bot> couldn't be read\"); the message is forgotten as seen, so labelling it again tries again.",
  },
  "host/triggers/email/gmail-history.ts|gmail history poll failed": {
    contained: "this.noteFails(this.fails + 1)",
    why: "schedules-triggers-standup: consecutive failed history polls feed the same health path as IMAP (onFailures), so after N the google-account routine's row says the mailbox cannot be reached.",
  },
  "host/triggers/calendar-triggers.ts|calendar trigger poll failed": {
    user: { test: "host/test/triggers/poll-health.test.ts", title: "a calendar poll that keeps failing: the row says it can't read the calendar" },
    why: "bug 115: a failed events.list is retried next poll; after N in a row RoutineHealth writes the reason on the routine's row, listenerConnected turns false, and a tray entry says the routine is not watching.",
  },
  "host/triggers/calendar-triggers.ts|calendar trigger poll crashed": {
    contained: "this.arm()",
    why: "bug 115: only an unexpected throw outside the per-calendar fetch (whose failures are counted and reach the row) lands here; the poll is re-armed, so the next minute tries again.",
  },
  "host/triggers/mac-folder.ts|mac folder poll failed": {
    user: { test: "host/test/triggers/poll-health.test.ts", title: "a Mac folder whose listing keeps failing: the row says it isn't watching the folder" },
    why: "bug 115: a failed Mac listing keeps the old baseline and retries next minute; after N in a row RoutineHealth writes the reason on the routine's row, listenerConnected turns false, and a tray entry says so.",
  },
  "host/triggers/mac-folder.ts|mac folder poll crashed": {
    contained: "this.arm()",
    why: "bug 115: only an unexpected throw outside the per-folder listing (whose failures are counted and reach the row) lands here; the poll is re-armed, so the next minute tries again.",
  },
  "host/standup/standup-service.ts|standup failed": {
    user: { test: "host/test/standup/standup.test.ts", title: "a scheduled standup that fails leaves a card that says it failed, and tells the user" },
    why: "bug 115: the claimed slot gets a card with an error state (the card says it failed and offers Run now) and a tray entry, instead of yesterday's card standing in for it.",
  },
  "host/voice/call-greetings.ts|call greetings: authoring failed twice; the built-in set stays": {
    contained: "this.failedAt.set(botId",
    why: "bugs 134, 151: the Bot still picks up at once with the built-in greetings (the view never waits on this call); it was asked twice, and authoring is retried after 30 minutes, never on every ring.",
  },
  "host/voice/call-greetings.ts|call greetings: a cached set is not all greetings; dropped, the Bot re-authors": {
    contained: "delete this.saved[botId]",
    why: "bug 151: the user hears the built-in greetings instead of the bad cached ones from the next ring on, and that Bot re-authors its set by itself; nothing is lost and nothing is asked of the user.",
  },
  "host/voice/call-wrapup.ts|call wrap-up failed; the call ends without one": {
    contained: "return { line: null };",
    why: "bug 134: hang-up still ends the call at once (a stock goodbye if the line was awaited); the chat keeps the whole call as messages, only the one-line summary card is missing.",
  },
  "host/standup/standup-service.ts|standup line fell back to the digest": {
    contained: "return fallback();",
    why: "schedules-triggers-standup: the Bot still gets its line, written from its digest in code (what it last said, what it waits on), so the card is complete; only the model's wording is missing.",
  },
  "host/triggers/email/email-triggers.ts|email mailbox unreachable after retries": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "consecutive IMAP connect failures are recoverable" },
    why: "bug 51: the threshold crossing that RoutineHealth turns into the routine's own failed run with the reason; the routine stays on because the mailbox may answer again.",
  },
  "host/triggers/email/email-triggers.ts|email routine has an invalid query": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "an email routine whose filter cannot be read is turned off, and its own row says why" },
    why: "bug 44a: the routine is turned off (it can never fire) and its run history quotes the filter that could not be read.",
  },
  "host/triggers/email/email-triggers.ts|email routine names an unknown mailbox": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "a missing mailbox is recoverable, so the routine stays on but its row says it is not watching" },
    why: "bug 44: the routine's row says it is not watching yet and which mailbox is missing; Add mailbox is on the same panel.",
  },
  "host/routines/engine.ts|routine has an unparsable schedule": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "a routine whose schedule cannot be read is turned off too" },
    why: "bug 44a: the scheduler cannot index it, so it is turned off and its run history quotes the schedule it could not read.",
  },
  "host/app.ts|template fact not saved": {
    user: { test: "host/test/templates/p5-template-security.test.ts", title: "a memory store that refuses the fact falls back to the profile file" },
    why: "bug 44b: remember() returns false, the importer falls back to the profile file, and a fact that fails that too becomes a notification naming the Bot.",
  },
  "host/templates/importer.ts|template fact not saved": {
    user: { test: "host/test/templates/p5-template-security.test.ts", title: "when even that fails, the user is told which Bot started without them" },
    why: "bug 44b: a fact lost even from the profile file raises a tray telling the user to tell the new Bot in chat what it needs to know.",
  },
  // ---- siblings found by this sweep, fixed with it ----
  "host/triggers/github.ts|github poll failed": {
    user: { test: "host/test/triggers/adapters.test.ts", title: "GitHub: after N refused polls the routine offers Connect listener again, and a new token clears it" },
    why: "bug 51's sibling: a revoked token polled forever while listenerConnected stayed true; after N failures Connect listener shows on the row and a new token clears it.",
  },
  "host/triggers/slack.ts|slack socket failed to start": {
    user: { test: "host/test/triggers/adapters.test.ts", title: "Slack: a socket that keeps failing to open stops reading as connected" },
    why: "bug 51's sibling: a revoked app token reconnected forever while the row read connected; after N failures Connect listener shows on the row.",
  },
  "host/triggers/adapters.ts|listener failing after retries": {
    user: { test: "host/test/routines/routine-health.test.ts", title: "a GitHub / Slack listener whose saved token keeps being refused says so and names the action" },
    why: "the threshold crossing RoutineHealth turns into the routine's own failed run: which service refuses the token, and to enter it again and press Connect.",
  },
  "host/store/host-settings.ts|settings.json could not be parsed; starting from the defaults": {
    user: { test: "host/test/store/settings-unreadable.test.ts", title: "says the settings were reset, and where the unreadable file was kept" },
    why: "the user's settings silently became the defaults; a tray now says they were reset, what to set again, and where the unreadable file was kept.",
  },
  "host/secrets/vault.ts|secret left out of the env: its name is no longer allowed": {
    user: { test: "host/test/secrets/vault.test.ts", title: "bug 56: a secret stored under older name rules is reported as unusable, with the reason, never as usable" },
    why: "bug 56: status() marks the name `unusable` with the reason (same validateSecretName, now in @synapse/shared), and the Mac's secrets list shows it on the secret's own row with Rename and Remove (app/test/renderer/secrets-section.test.tsx).",
  },
  "host/brain/spawn-options.ts|secret left out of the env: its name is not allowed": {
    user: { test: "host/test/secrets/vault.test.ts", title: "bug 56: a secret stored under older name rules is reported as unusable, with the reason, never as usable" },
    why: "bug 56: the spawn boundary applies the same validateSecretName as status(), so any name dropped here is already listed as unusable with Rename/Remove.",
  },
  // ---- contained: nothing the user sees claims success ----
  "host/app.ts|auth proxy could not start; Claude processes are refused until it does": { contained: "authProxyUp = false", why: "security review minor 2: fail closed. The \"Couldn't start the key proxy\" tray with Retry goes up (proxyTray) and every spawn throws AuthProxyDownError (requireAuthProxy), so a Bot turn fails visibly instead of running with the key in its env." },
  "host/auth/model-access.ts|model access could not be saved": { contained: "log.warn(\"model access could not be saved\"", why: "review round 2 (P4): the probe result stays in memory for this run and the picker still gets it; only the copy for the next boot is missing, and the next probe (a key save or Check models) writes it again." },
  "host/auth/key-check.ts|key check: spend could not be recorded": { contained: "log.warn(\"key check: spend could not be recorded\"", why: "bug 281: the check's own usage row failed, so nothing is reported on the grant's release and the proxy's onUnreported records the same spend (as proxy-unreported) instead. The answer still reaches Settings → Account." },
  "host/auth/key-check.ts|key check could not be saved": { contained: "log.warn(\"key check could not be saved\"", why: "bug 281: the answer stays in memory for this run and is published to Settings → Account; only the copy for the next boot is missing, and the next Check writes it again." },
  "host/auth/proxy.ts|auth proxy: unreported usage could not be recorded": { contained: "catch (e) { log.warn(\"auth proxy: unreported usage could not be recorded\"", why: "review round 2 (P2): the answer already reached the caller and the proxy's own per-Bot meter counted it; only the usage.db row for unreported spend is missing. The budget check per request still applies." },
  "host/app.ts|conformance after the API key was saved failed": { contained: ".finally(() => { conformanceAfterKey = null; })", why: "synapse-public: conformance after a key is saved is best effort; the saved (or default) flags stay in force and the next boot runs it again, so Bots keep working and nothing is lost." },
  "host/brain/long-context.ts|long-context escalations could not be read; starting empty": { contained: "this.chats = value && typeof value", why: "saving-settings: under Long-context Only when needed, a chat whose context is past the line escalates again on its next turn (escalated() re-reads the context meter); at worst a compacted chat goes back to standard context once, one prompt-cache re-write, never a failed turn." },
  "host/brain/long-context.ts|long-context escalations could not be saved": { contained: "this.chats[botId] = sid;", why: "saving-settings: the escalation stays in memory for this host run; only a restart could forget it, with the same one-re-write effect as above." },
  "host/auth/proxy.ts|auth proxy listener closed; restarting": { contained: "this.start()", why: "bug 117: the listener comes back on the same port with its grants; running CLIs retry the connection meanwhile (proxy.cli.integration.test.ts rides out a restart mid-turn)." },
  "host/auth/proxy.ts|auth proxy restart failed": { contained: "retry(n + 1)", why: "bug 117: the restart is retried with backoff; a Claude call made meanwhile fails to connect and surfaces as that turn's error, never as success." },
  "host/app.ts|conformance failed": { contained: "o.ensure()", why: "boot conformance failing leaves the saved (or default) flags in force; the Bots run on the last flags that were measured, which is what the UI already describes." },
  "host/app.ts|hourly sweep failed": { contained: "% 3600", why: "housekeeping of old attachment parts and old sessions; nothing is shown for it and the same sweep runs again next hour." },
  "host/app.ts|rule compile failed": { contained: "compileAll(", why: "an Auto-review rule that is not compiled is read conservatively (review/rules.ts), so the reviewer asks the user more, never less: fail-safe, not a false success." },
  "host/review/rules.ts|rule compile failed; using the conservative reading": { contained: "breadth: \"broad\"", why: "the uncompiled rule falls back to the broadest, most cautious reading, so the user is asked rather than an action silently allowed." },
  "host/b2b/classifier.ts|b2b gate classifier failed; message goes to the inbox": { contained: "return FALLBACK", why: "a Bot-to-Bot message the gate cannot classify is delivered to the inbox rather than dropped, so nothing is lost and nothing claims it was filtered." },
  "host/bots/bot-service.ts|could not remove real-brain session file (bothost has no write bits there)": { contained: "code !== \"EACCES\"", why: "only a permission refusal on a box-owned session file is tolerated (anything else throws); the Bot's own record is still removed and no surface shows the file." },
  "host/brain/conformance/checks/group-c.ts|could not remove synthesized CT-14 session (bothost has no write bits there)": { contained: "code === \"EACCES\"", why: "cleanup of a conformance probe's scratch session; only a permission refusal is tolerated, and no user surface depends on it." },
  "host/brain/conformance/runner.ts|conformance: CLI version probe failed; keeping the saved flags": { contained: "return prev.flags", why: "without a version the host keeps the flags it last measured rather than guessing; nothing user-facing changes." },
  "host/brain/conformance/runner.ts|conformance: not saving results with an unknown CLI version over a known one": { contained: "return false", why: "refuses to overwrite known-good results with unattributable ones; the previous results stay in force." },
  "host/brain/conformance/session-file.ts|could not delete box session file via bot-claude-delete-session": { contained: "return false", why: "reports the failure to its caller as false instead of success; the caller decides." },
  "host/brain/event-translator.ts|unhandled SDK system subtype": { contained: "msg.subtype", why: "an SDK stream message this host has no rendering for; it carries no state the UI shows, so dropping it claims nothing." },
  "host/computer/displays.ts|busy marker write refused": { contained: "busyWarned", why: "a best-effort hint file for the box's own monitor; warned once per display, no user surface reads it." },
  "host/computer/snapshots.ts|snapshot raw() request failed": { contained: "res.writeHead(500)", why: "the requester gets a 500, so the screen view shows its own failed-load state instead of a stale success." },
  "host/context/rollover.ts|rollover: old session unreadable": { contained: "unreadable = true", why: "the handoff turn tells the Bot its recap is partial (STR.rolloverTailLost), so it says so to the user instead of guessing." },
  "host/context/rollover.ts|rollover: write helper failed; using the handoff turn": { contained: "copied", why: "the tail is carried by the handoff turn instead of the copied session file; the conversation continues either way." },
  "host/context/transcript-mirror.ts|transcript mirror write failed": { contained: "appendFileSync", why: "a secondary copy of the transcript for the Bot's own lookup; the conversation the user sees is stored separately and is unaffected." },
  "host/history/indexer.ts|history archive purge failed": { contained: "archive.removeBot(botId)", why: "the queued work for the deleted Bot is already dropped and no Bot can query a deleted Bot's id, so leftover rows are unreachable; the next delete of that id purges them." },
  "host/history/indexer.ts|history archive index failed": { contained: "return true", why: "the archive misses that one row: SearchHistory is a lookup over a copy, and the transcript the user sees (and the Bot's transcript mirror) is stored separately and intact. A missing redactor is not this path: that job waits and retries." },
  "host/gateway/server.ts|gateway command failed": { contained: "send(res, 500", why: "the renderer's call rejects with an Internal error, which the calling surface shows; nothing is reported as done." },
  "host/gateway/server.ts|gateway raw route failed": { contained: "send(res, 500", why: "the raw route answers 500, so its caller sees the failure rather than an empty success." },
  "host/groups/group-poster.ts|group room turn failed": { contained: ".catch((e) =>", why: "only a host bug reaches here: member turns resolve rather than throw and the floor picker catches its own model errors, so every expected failure is per-member and shown in the room." },
  "host/groups/orchestrator.ts|group room turn failed": { contained: ".catch((e) =>", why: "only a host bug reaches here: member turns resolve rather than throw and the floor picker catches its own model errors, so every expected failure is per-member and shown in the room." },
  "host/groups/orchestrator.ts|group interruptActive failed": { contained: "interruptActive(", why: "superseding an old room turn failed; the member keeps showing as working (true) and its reply still lands in the room." },
  "host/walls/bot-accounts.ts|bot-user ${verb} failed": { contained: 'run("sudo", ["-n", BOT_USER_HELPER, verb, botId])', why: "bug 66: an account that could not be made fails SAFE: bot-claude-as-box refuses to run that Bot as any other account, so its turn fails visibly instead of running unwalled; every host start re-runs ensure. A failed remove leaves an account with no Bot and nothing that runs as it; the next remove (bot-user is idempotent) or a re-run of the migration clears it." },
  "host/walls/migrate.ts|walls: could not re-stage a legacy upload; leaving it in place": { contained: "keep.add(ref.boxPath)", why: "bug 61 migration: the flat file and the Bot's index entry stay exactly as they were (nothing is lost, the Bot's path still works), the tool guard still denies it to other Bots, and the next host start retries." },
  "host/walls/migrate.ts|walls: could not remove a legacy flat upload": { contained: "removeHostOwnedPath(cfg.workspace, f)", why: "bug 61 migration: the Bot already has its re-staged copy (or the file is parked host-private); a leftover flat copy stays tool-guarded and the next host start retries the removal." },
  "host/walls/migrate.ts|walls: could not remove a legacy flat MCP spill": { contained: "removeHostOwnedPath(cfg.workspace, f)", why: "bug 61 migration: the spill is already parked host-private; the leftover stays tool-guarded and the next host start retries the removal." },
  "host/mcp/proxy.ts|mcp spill refused": { contained: "couldn't be written to a file", why: "the Bot is told in the tool result that the output was cut and why, so it can say so rather than present a partial result as whole." },
  "host/memory/dreaming/dreamer.ts|dreaming call failed": { contained: "LIMITS5.dreamRetries", why: "a background memory consolidation call, retried with backoff and reported to its caller as a timeout; no surface claims it ran." },
  "host/memory/engine.ts|memory job failed": { contained: "chains.set", why: "a background memory job; the Bot's memory tool reports its own adds honestly (bug 44 cleared it) and the next job on the chain still runs." },
  "host/runner/hooks.ts|turn hook failed": { contained: "return fallback", why: "a failing hook falls back to the value the turn would have without it; the turn completes normally." },
  "host/runner/observers.ts|turn observer failed": { contained: "o.on", why: "one observer throwing is isolated from the turn and the other observers; the turn's own state is unaffected." },
  "host/usage/usage-store.ts|spend listener failed": { contained: "fn(ev)", why: "the run is already recorded before any listener runs; one listener throwing (a budget tray, a dashboard total) is isolated from the row and from the other listeners." },
  "host/computer/restart.ts|box maintenance: the Mac stopped renewing its hold; letting held turns run": { contained: "o.runner.holdNewTurns(false)", why: "the lease expired because the Mac stopped renewing it (crash or quit mid-update); the host lifts the hold itself so held turns run and the maintenance banner clears, so nothing is left for the user to act on." },
  "host/runner/turn-runner.ts|bot stopped on repeated failure": { contained: "STR_COST.loopStopped(name, trip.step)", why: "5.7: the log line sits beside the tray the user sees (\"Stopped: <Bot> kept failing at <step>\", with Continue and Stop), proven in host/test/runner/loop-stop.test.ts." },
  "host/runner/turn-runner.ts|interrupt failed": { contained: ".interrupt(reason)", why: "Stop did not take: the Bot keeps showing as working (true) with Stop still offered, so nothing claims it stopped." },
  "host/runner/turn-runner.ts|maintenance job failed": { contained: "r.maintenance = null", why: "an idle-time maintenance job (compaction and the like); it is cleared so the next one can run, and no surface shows it." },
  "host/runner/turn-runner.ts|run escaped the watchdog": { contained: "onWatchdogInterrupt", why: "the watchdog has already interrupted the run and the lane moved on; this notes a zombie that settled late." },
  "host/runner/turn-runner.ts|turn failed": { contained: "error: classifyThrown(e)", why: "a thrown turn is turned into a failed result so the normal settle path runs: the failure tray and reply nudge the user sees." },
  "host/search/search-index.ts|search index update failed": { contained: "removeBot", why: "the search index misses one update; search is a lookup over data that is itself intact, and the next update re-indexes." },
  "host/store/host-settings.ts|host settings could not be saved": { contained: "throw new GatewayError", why: "the save throws SETTINGS_NOT_SAVED with the reason, the store keeps its old values, and the renderer shows the error." },
  "host/supervisor/rss.ts|process RSS unavailable; the RSS limits are off": { contained: "return 0;", why: "only where /proc does not exist (a host run on macOS, never the box): the RSS read degrades to 0 and the supervisor tick keeps running; the box always has /proc." },
  "host/supervisor/ledger.ts|bot-reap failed": { contained: "resolve()", why: "a best-effort sweep of stray Bot processes at boot; boot continues and the per-Bot supervisor still owns its own children." },
  "host/teach/recorder.ts|teach auto-stop failed": { contained: "this.stop(", why: "the recording bar still shows the recording with Stop & save and Discard, whose own errors are shown on the bar." },
  "host/teach/recorder.ts|teach pause after viewer gone failed": { contained: "this.pause(", why: "the recording stays in RECORDING, which is what the bar shows, with Stop & save and Discard still offered." },
  "host/teach/recorder.ts|teach sidecar stop failed": { contained: "s.sidecar?.stop()", why: "stopping event capture failed at the end of a recording; session.json records what the sidecar reported at start (bug 47), not this." },
  "host/teach/sidecar.ts|teach sidecar pointer failed": { contained: "pending.push", why: "one pointer event could not be enriched; the event stream continues and the recording's own state is unaffected." },
  "host/transcript/run-scheduler.ts|run task failed": { contained: ".finally(", why: "the lane is released so the next run starts; the run's own failure is reported by the turn runner's failed-result path." },
  "host/triggers/email/imap-idle.ts|imap fetch failed": { contained: "this.lastUid", why: "lastUid is not advanced past mail that was not fetched, so the next pull (on the next new mail or reconnect) picks it up." },
  "host/triggers/file-watcher.ts|file trigger event failed": { contained: "this.onFs(", why: "one file event could not be queued; the watcher stays armed and the next change to the file fires the routine." },
  "host/triggers/slack.ts|slack frame failed": { contained: "onFrame", why: "one Slack frame could not be handled; the socket stays open and later events are delivered." },
  "host/triggers/webhook-server.ts|webhook failed": { contained: "send(res, 500", why: "the sender gets a 500 and retries (GitHub, Slack and the rest redeliver), so the event is not silently accepted and dropped." },
};

const sources = [...walk(HOST)];
const rel = (f: string) => path.relative(repoRoot, f).split(path.sep).join("/");
const allSites = sources.flatMap((f) => logSites(fs.readFileSync(f, "utf8")).map((s) => ({ ...s, file: rel(f), key: `${rel(f)}|${s.message}` })));

function bugRow(n: number): { status: string; where: string } | null {
  const row = fs.readFileSync(path.join(repoRoot, "docs", "bug-log.md"), "utf8").split("\n").find((l) => l.startsWith(`| ${n} |`));
  if (!row) return null;
  const cells = row.split(/(?<!\\)\|/).map((c) => c.trim()); // an escaped \| stays inside its cell
  return { status: cells[4] ?? "", where: cells[5] ?? "" };
}

describe("a host failure that is logged must reach the user, or say checkably why it need not (bugs 44, 47, 51, 52)", () => {
  it("finds host sources and log sites at all (smoke: a zero is a claim about the pattern)", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(allSites.length).toBeGreaterThan(50);
    expect(allSites.some((s) => s.key === "host/phase4.ts|webhook listener re-bind failed"), "the site bug 52 was filed against must be visible to the scan").toBe(true);
  });

  it("every log.warn / log.error under host/ is declared", () => {
    const missing = [...new Set(allSites.filter((s) => !DECLARED[s.key]).map((s) => `${s.file}:${s.line} — "${s.message}"`))];
    expect(missing, `A host failure that only reaches the log is how bugs 44, 47, 51 and 52 happened. Surface it as a state with an action and prove it with a test, then declare it here (or declare how it is contained):\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("holds no stale declarations", () => {
    const live = new Set(allSites.map((s) => s.key));
    expect(Object.keys(DECLARED).filter((k) => !live.has(k))).toEqual([]);
  });

  it("every `user` declaration names a test that exists and asserts it by title", () => {
    for (const [key, d] of Object.entries(DECLARED)) {
      if (!("user" in d)) continue;
      const file = path.join(repoRoot, d.user.test);
      expect(fs.existsSync(file), `${key}: ${d.user.test} does not exist`).toBe(true);
      const titles = [...fs.readFileSync(file, "utf8").matchAll(/\bit\(\s*"([^"]+)"/g)].map((m) => m[1]!);
      expect(titles.some((t) => t.includes(d.user.title)), `${key}: no it("…${d.user.title}…") in ${d.user.test}`).toBe(true);
    }
  });

  it("every `contained` declaration's evidence is next to each of its log calls", () => {
    for (const s of allSites) {
      const d = DECLARED[s.key];
      if (!d || !("contained" in d)) continue;
      expect(s.window.includes(d.contained), `${s.file}:${s.line} — the code that contains "${s.message}" ("${d.contained}") is gone; the declaration no longer holds`).toBe(true);
    }
  });

  it("every `filed` declaration points at an unmerged bug-log row that names the file", () => {
    for (const [key, d] of Object.entries(DECLARED)) {
      if (!("filed" in d)) continue;
      const row = bugRow(d.filed);
      expect(row, `${key}: bug-log row ${d.filed} does not exist`).not.toBeNull();
      expect(row!.status, `${key}: row ${d.filed} is merged — the hole is fixed, so this declaration must change`).not.toBe("merged");
      expect(row!.where, `${key}: row ${d.filed} does not name ${key.split("|")[0]}`).toContain(key.split("|")[0]!.replace(/^host\//, ""));
    }
  });

  it("every reason is a sentence, not a shrug", () => {
    for (const [key, d] of Object.entries(DECLARED)) expect(d.why.length, `${key}'s reason is too thin`).toBeGreaterThan(60);
  });

  it("catches the line bug 52 was filed against, verbatim (self-test)", () => {
    const bug52 = `        void applyWebhookLanRebind({\n          notify: (err) => {\n            log.warn("webhook listener re-bind failed", { error: String(err) });\n          },\n        });`;
    expect(logSites(bug52).map((s) => [s.message, s.line])).toEqual([["webhook listener re-bind failed", 3]]);
  });

  it("catches log.error and a call broken across lines (self-test)", () => {
    expect(logSites('log.error(\n  "something failed",\n  { e },\n);')[0]?.message).toBe("something failed");
    expect(logSites("x.catch((e) => log.warn('single quoted', { e }))")[0]?.message).toBe("single quoted");
  });

  it("does not fire on prose, info logs or another object's warn (self-test, must not fire)", () => {
    // The headers of this file and routine-health.ts quote the defect; guarding prose would force the
    // next author to delete the explanation to get a green suite.
    expect(logSites('// log.warn("email routine has an invalid query", { routineId });')).toEqual([]);
    expect(logSites('/* log.error("x")\n */ const a = 1;')).toEqual([]);
    expect(logSites('log.info("started", {});')).toEqual([]);
    expect(logSites('console.warn("renderer-style");')).toEqual([]);
    expect(logSites('catalog.warn("not the logger");')).toEqual([]);
  });

  it("a line comment mentioning a glob does not hide the call after it (self-test: this guard's own first false zero)", () => {
    const src = '    // lives under ~/.claude/projects/**, which is box-owned\n    log.warn("could not remove", { id });\n    if (x) { /* came and went */ }';
    expect(logSites(src).map((s) => s.message)).toEqual(["could not remove"]);
    expect(logSites('const u = "https://x/*"; log.warn("after a url", {}); // */')[0]?.message).toBe("after a url");
  });

  it("finds as many calls as a plain line count does (the instrument checked against a second one)", () => {
    // Every file here keeps one log call per line, so a line grep is an independent count.
    let lines = 0;
    for (const f of sources) for (const l of fs.readFileSync(f, "utf8").split("\n")) if (/\blog\.(?:warn|error)\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) lines++;
    expect(allSites.length).toBe(lines);
  });

  it("keeps line numbers exact after a block comment (self-test: the evidence window depends on it)", () => {
    const src = '/**\n * a\n * b\n */\nfoo();\nlog.warn("here", {});\nreturn FALLBACK;';
    const [s] = logSites(src);
    expect(s?.line).toBe(6);
    expect(s?.window).toContain("return FALLBACK");
  });
});
