import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, type ActivityIcon, type ActivityMetric, type DiffLine, type StepBody } from "@synapse/shared";

interface Rule { tool: string; past: string; future: string; count: "calls" | "argIds" | "resultIds" }
interface Family { server: string; rules: Rule[]; noun: string; nounPlural: string }

function loadVerbs(): Record<string, Family> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", "ui", "activity-verbs.json"), path.join(here, "activity-verbs.json"), path.join(process.env.PROMPTS_DIR ?? here, "activity-verbs.json")]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, Family>;
  }
  return {};
}
const VERBS = loadVerbs();
const HIDDEN = new Set(["TodoWrite", "Skill", "ToolSearch"]);

/** Phase 3 bot tools that are real work the user should see as steps (§18.1: Shell → Ran; Task; Screenshot).
 *  mac-apps: MacApp joins them because every one of its actions happens in the user's OWN apps, on their own
 *  screen — a message read, a note written, a button pressed. That belongs in the activity log even when it
 *  needed no card, which is most of the time. */
const VISIBLE_BOT_TOOLS = new Set(["mcp__bot__Shell", "mcp__bot__Task", "mcp__bot__Screenshot", "mcp__bot__MacApp"]);

export function isHiddenActivity(name: string): boolean {
  return HIDDEN.has(name) || (name.startsWith("mcp__bot__") && !VISIBLE_BOT_TOOLS.has(name));
}

function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: (parts[1] as string).replace(/^claude_ai_/, ""), tool: parts.slice(2).join("__") };
}

const ID_KEYS = /"(?:id|messageId|message_id|threadId|thread_id|eventId|event_id)"\s*:\s*"([^"]+)"/g;
function idsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ID_KEYS)) out.add(m[1] as string);
  return [...out].slice(0, 200);
}
function argIds(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(input)) {
    if (!/ids?$/i.test(k)) continue;
    if (Array.isArray(v)) v.forEach((x) => out.add(String(x)));
    else if (typeof v === "string") out.add(v);
  }
  return [...out].slice(0, 200);
}

export function describeCall(name: string, _input: Record<string, unknown>): { past: string; future: string; noun: string; nounPlural: string } | null {
  const mcp = mcpParts(name);
  if (mcp) {
    for (const fam of Object.values(VERBS)) {
      if (!new RegExp(fam.server, "i").test(mcp.server)) continue;
      const rule = fam.rules.find((r) => new RegExp(r.tool, "i").test(mcp.tool));
      if (rule) return { past: rule.past, future: rule.future, noun: fam.noun, nounPlural: fam.nounPlural };
    }
    if (name === "mcp__computer__browser_navigate") return { past: "Browsed", future: "browse", noun: "page", nounPlural: "pages" };
    if (name === "mcp__bot__Shell") return { past: "Ran", future: "run", noun: "command", nounPlural: "commands" };
    if (name === "mcp__bot__Task") return { past: "Ran", future: "run", noun: "task", nounPlural: "tasks" };
    if (name === "mcp__bot__Screenshot") return { past: "Took", future: "take", noun: "screenshot", nounPlural: "screenshots" };
    if (name.startsWith("mcp__bot__")) return null;
    return { past: `Used ${mcp.server.replace(/_/g, " ")}`, future: `use ${mcp.server.replace(/_/g, " ")}`, noun: "time", nounPlural: "times" };
  }
  switch (name) {
    case "WebFetch": return { past: "Browsed", future: "browse", noun: "page", nounPlural: "pages" };
    case "WebSearch": return { past: "Searched the web", future: "search the web", noun: "time", nounPlural: "times" };
    case "Read": return { past: "Read", future: "read", noun: "file", nounPlural: "files" };
    case "Edit": case "Write": return { past: "Edited", future: "edit", noun: "file", nounPlural: "files" };
    case "Bash": return { past: "Ran", future: "run", noun: "command", nounPlural: "commands" };
    case "Glob": case "Grep": return { past: "Searched code", future: "search code", noun: "time", nounPlural: "times" };
    default: return null;
  }
}

export function metricFor(name: string, input: Record<string, unknown>, output: string): ActivityMetric | null {
  if (isHiddenActivity(name)) return null;
  const d = describeCall(name, input);
  if (!d) return null;
  const base = { verb: d.past, noun: d.noun, nounPlural: d.nounPlural };
  if (name === "WebFetch" || name === "mcp__computer__browser_navigate") {
    const url = String(input.url ?? "").split("#")[0] as string;
    return { ...base, count: 1, itemIds: [url] };
  }
  const mcp = mcpParts(name);
  if (mcp) {
    for (const fam of Object.values(VERBS)) {
      if (!new RegExp(fam.server, "i").test(mcp.server)) continue;
      const rule = fam.rules.find((r) => new RegExp(r.tool, "i").test(mcp.tool));
      if (!rule) break;
      const ids = rule.count === "argIds" ? argIds(input) : rule.count === "resultIds" ? idsIn(output) : [];
      return { ...base, count: Math.max(ids.length, 1), ...(ids.length ? { itemIds: ids } : {}) };
    }
    return { ...base, count: 1 };
  }

  if (name === "Read" || name === "Edit" || name === "Write") return { ...base, count: 1, itemIds: [String(input.file_path ?? "")] };
  return { ...base, count: 1 };
}

const base = (p: unknown) => path.basename(String(p ?? ""));
const host = (u: unknown) => { try { return new URL(String(u)).hostname; } catch { return String(u ?? ""); } };
const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

/**
 * CHAT-05 step line. `live`: the call hasn't ended (it may be parked on an approval card and not have run at
 * all), so the line reads in the present tense ("Running <cmd>"); it switches to the past tense at tool_end
 * (gate L-1).
 */
export function stepText(name: string, input: Record<string, unknown>, output = "", live = false): string {
  const t = (past: string, present: string) => (live ? present : past);
  switch (name) {
    case "Bash": case "mcp__bot__Shell": {
      const passed = /(\d+) passed/.exec(output);
      return `${t("Ran", "Running")} ${String(input.command ?? "").slice(0, 80)}${passed && !live ? ` · ${passed[1]} passed` : ""}`;
    }
    case "Edit": return live ? `Editing ${base(input.file_path)}` : `Edited ${base(input.file_path)} +${lines(input.new_string)} −${lines(input.old_string)}`;
    case "Write": return `${t("Created", "Creating")} ${base(input.file_path)}`;
    case "Read": return `${t("Read", "Reading")} ${base(input.file_path)}`;
    case "Grep": case "Glob": return `${t("Searched", "Searching")} code "${String(input.pattern ?? "")}"`;
    case "WebSearch": return `${t("Searched", "Searching")} the web "${String(input.query ?? "")}"`;
    case "WebFetch": return `${t("Read", "Reading")} ${host(input.url)}`;
    case "TodoWrite": return t("Updated the plan", "Updating the plan");
    case "mcp__computer__browser_navigate": return `${t("Browsed", "Browsing")} ${host(input.url)}`;
    case "mcp__bot__Task": return `${t("Ran", "Running")} a task: ${String(input.description ?? "").slice(0, 80)}`;
    case "mcp__bot__Screenshot": return t("Took a screenshot", "Taking a screenshot");
    case "mcp__bot__MacApp": return macAppStep(String(input.action ?? ""), input, live);
    default: {
      const mcp = mcpParts(name);
      return mcp ? `${t("Used", "Using")} ${mcp.server.replace(/_/g, " ")} ${mcp.tool}` : name;
    }
  }
}

/**
 * mac-apps: what one MacApp action reads as in the activity log — the app and the person by name, never an
 * internal id and never the body the Bot typed (the card is where the user reads that, before it is sent).
 */
function macAppStep(action: string, input: Record<string, unknown>, live: boolean): string {
  const t = (past: string, present: string) => (live ? present : past);
  const s = (k: string) => String(input[k] ?? "").slice(0, 60);
  const who = s("title") || s("target");
  const app = s("app");
  switch (action) {
    case "open": return `${t("Opened", "Opening")} ${app || s("target")}`;
    case "apps": return t("Looked at what is open", "Looking at what is open");
    case "messages.send": return `${t("Sent", "Sending")} a message to ${who}`;
    case "messages.threads": return t("Read recent messages", "Reading recent messages");
    case "mail.send": return `${t("Sent", "Sending")} an email to ${s("target")}`;
    case "mail.compose": return `${t("Drafted", "Drafting")} an email to ${s("target")}`;
    case "mail.search": return `${t("Searched", "Searching")} email for “${s("query")}”`;
    case "mail.read": return t("Read an email", "Reading an email");
    case "calendar.list": return t("Checked the calendar", "Checking the calendar");
    case "calendar.calendars": return t("Listed the calendars", "Listing the calendars");
    case "calendar.create": return `${t("Added", "Adding")} “${s("title")}” to the calendar`;
    case "calendar.move": return t("Moved a calendar event", "Moving a calendar event");
    case "calendar.cancel": return t("Cancelled a calendar event", "Cancelling a calendar event");
    case "reminders.create": return `${t("Added", "Adding")} a reminder: ${s("title")}`;
    case "reminders.complete": return t("Completed a reminder", "Completing a reminder");
    case "reminders.list": return t("Read the reminders", "Reading the reminders");
    case "notes.create": return `${t("Wrote", "Writing")} a note: ${s("title")}`;
    case "notes.append": return t("Added to a note", "Adding to a note");
    case "notes.search": return `${t("Searched", "Searching")} notes for “${s("query")}”`;
    case "contacts.find": return `${t("Looked up", "Looking up")} ${s("query") || s("target")}`;
    case "music": return t("Used Music", "Using Music");
    case "finder.reveal": return `${t("Showed", "Showing")} ${base(input.target)} in Finder`;
    case "finder.move": return `${t("Moved", "Moving")} ${base(input.target)}`;
    case "finder.tag": return `${t("Tagged", "Tagging")} ${base(input.target)}`;
    case "tabs": return t("Looked at the browser tabs", "Looking at the browser tabs");
    case "shortcut": return `${t("Ran", "Running")} the Shortcut ${s("title")}`;
    case "ui.outline": case "ui.more": return `${t("Read", "Reading")} the ${app || "front"} window`;
    case "ui.press": return `${t("Pressed", "Pressing")} a button in ${app || "the front app"}`;
    case "ui.set": return `${t("Typed", "Typing")} into ${app || "the front app"}`;
    case "ui.menu": return `${t("Chose", "Choosing")} ${s("value")} in ${app || "the front app"}`;
    case "ui.key": return `${t("Pressed", "Pressing")} ${s("value")} in ${app || "the front app"}`;
    case "ui.focus": return `${t("Focused", "Focusing")} a field in ${app || "the front app"}`;
    default: return `${t("Used", "Using")} an app on the Mac`;
  }
}

export function iconFor(name: string): ActivityIcon {
  if (name === "mcp__bot__Shell") return "terminal";
  // mac-apps: one icon for the whole family. iconFor only sees the tool's NAME, not which action ran, so it
  // cannot pick mail vs calendar here; the step's own words carry that.
  if (name === "mcp__bot__MacApp") return "tool";
  const mcp = mcpParts(name);
  if (mcp) {
    if (/gmail|mail|outlook/i.test(mcp.server)) return "mail";
    if (/calendar/i.test(mcp.server)) return "calendar";
    return "tool";
  }
  switch (name) {
    case "Bash": return "terminal";
    case "Read": return "file";
    case "Edit": case "Write": return "edit";
    case "Grep": case "Glob": case "WebSearch": return "search";
    case "WebFetch": return "globe";
    default: return "tool";
  }
}

/**
 * bug 198: "like 500 lines of code were not in a box and 30 were" — the 30 were a fenced block in the
 * Bot's own reply (bug 193's CodeBlock.tsx card); no stored reply is anywhere near 500 lines, so the
 * unboxed code was content the chat shows LIVE — a step's own Read/Write/Edit/Bash body, which
 * ActivityGroup.tsx only ever gave a one-line `step` summary and never a body at all, so a step that
 * needed one had no card to fall into. `bodyFor` builds that body once, at tool_end (never on the
 * "running" entry — same timing as `metricFor`), bounded so a pathological file or command output
 * cannot bloat the transcript store, and REDACTED before any of that — a step's body is stored (SQLite,
 * the SSE wire, the transcript mirror) exactly like every other Bot-visible string, and a secret that
 * never leaks through `stepText`'s 80-char summary must not leak through the full body either.
 */

/** Splits a string at a `maxChars` boundary without landing inside a UTF-16 surrogate pair (fix round 1,
 *  finding 6) — `.slice` alone would silently turn a trailing emoji/astral character into an orphaned
 *  low surrogate, which renders as a replacement glyph. */
function safeSliceChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let end = maxChars;
  if (end > 0 && end < s.length) {
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1; // a high surrogate here would be split from its pair
  }
  return s.slice(0, end);
}

function capText(s: string, maxChars: number, maxLines: number): { text: string; truncated: boolean } {
  let lines = s.split("\n");
  let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); truncated = true; }
  let text = lines.join("\n");
  if (text.length > maxChars) { text = safeSliceChars(text, maxChars); truncated = true; }
  return { text, truncated };
}

/**
 * fix round 1, finding 6: an Edit's old/new sides must be capped at the SAME point, or the diff below
 * (a prefix/suffix trim) reads a cut mid-file as a real edit — one side losing its tail line that the
 * other side still has looks exactly like a removal/addition that was never in the Bot's actual edit.
 * Each side gets half of `maxChars`, so the total (what finding 5 asks for) is still one bounded budget
 * across old+new together, not `maxChars` per side.
 */
function capEditPair(oldStr: string, newStr: string, maxChars: number, maxLines: number): { old: string; new: string; truncated: boolean } {
  let oldLines = oldStr.split("\n");
  let newLines = newStr.split("\n");
  let truncated = false;
  if (oldLines.length > maxLines) { oldLines = oldLines.slice(0, maxLines); truncated = true; }
  if (newLines.length > maxLines) { newLines = newLines.slice(0, maxLines); truncated = true; }
  let oldText = oldLines.join("\n");
  let newText = newLines.join("\n");
  const half = Math.floor(maxChars / 2);
  if (oldText.length > half) { oldText = safeSliceChars(oldText, half); truncated = true; }
  if (newText.length > half) { newText = safeSliceChars(newText, half); truncated = true; }
  return { old: oldText, new: newText, truncated };
}

/** The file extension as a bare token ("ts", "py", "sh") — exactly what CodeBlock.tsx's fenced-block
 *  cards already key their language label off of (speech-text.ts's `languageName`/`LANGUAGES`), so a
 *  Read/Write step's card and a Bot's own ```ts fence land on the same word for the same file type. */
function langFor(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase() || "text";
}

/**
 * fix round 1, findings 1+2: `bodyFor` used to re-read a Read step's file straight off disk, as the
 * HOST's own uid — which runs with more access than the Bot's own tool call just proved it has. A
 * denied Read (another Bot's home, a host-private token file, a symlink the Bot's own sandbox would
 * refuse) still reached the disk here and the bytes it found landed in store.db and went out over SSE:
 * an authorization bypass, not a rendering nicety. A `fs.readSync` on an arbitrary path can also hang
 * the event loop on a FIFO, and it read a fixed byte range with no regard for the Read tool's own
 * `offset`/`limit` — so it happily "succeeded" on the wrong slice of a file the Bot only read part of.
 *
 * The fix re-derives the body from the tool's OWN output — exactly the text (and only the text) the
 * Bot itself was shown — never the disk again.
 *
 * fix round 2 (re-check of 9bb055e6, finding 2 — MUST VERIFY): the ordinary-line shape below was
 * checked against REAL Read tool_results, not invented — genuine stored transcripts under this repo's
 * own `~/.claude/projects/-Users-alex-project/` (e.g. a real result opening "100\t  text: string;")
 * and three live probes (host/test/presence/read-tool-fixtures.ts has the verbatim captures): a normal
 * multi-thousand-line file, a zero-byte file, and a file long enough to trip a trailing, non-numbered
 * footer block. The real shape has NO leading-space padding and NO `→` separator — bare
 * `{lineNumber}\t{content}` — but the regex still tolerates both defensively (a version drift in the
 * pinned CLI is cheap to survive; guessing at content that doesn't match at all is not).
 *
 * The parse takes the longest PREFIX of lines matching that shape and stops at the first one that
 * doesn't — a trailing `<system-reminder>` block, a "(file truncated)"-style footer, a blank separator,
 * anything this build doesn't recognise — rather than requiring every line to match. That prefix-only
 * rule is also what makes an image/PDF result, a denied-Read message and an EMPTY_FILE_OUTPUT-style
 * notice (none of which have even ONE matching line) fall through to "no body" rather than a wrong one,
 * without a separate isError-only special case for "doesn't look like a Read".
 */
const READ_LINE = /^\s*(\d+)(?:\t|\s*→\s?)(.*)$/;
function parseReadOutput(output: string): { startLine: number; text: string } | null {
  const lines = output.replace(/\n$/, "").split("\n");
  const content: string[] = [];
  let startLine: number | null = null;
  for (const line of lines) {
    const m = READ_LINE.exec(line);
    if (!m) break; // the first non-numbered line ends the real content; whatever follows is a trailing block
    if (startLine === null) startLine = Number(m[1]);
    content.push(m[2]!);
  }
  if (startLine === null) return null; // no numbered line at all — not cat -n shaped; never a guess
  return { startLine, text: content.join("\n") };
}

/**
 * An Edit's `old_string`/`new_string` is already a single contiguous replacement (that is what the
 * tool does), so the correct diff is not a general LCS — it is "trim the common prefix and suffix,
 * everything left in the middle is the change": common lines become context, the old middle is every
 * removal, the new middle is every addition. No `diff` package, no red/green — DiffCardBody (StepBody.tsx)
 * paints `add`/`del`/`ctx` in neutral inks only.
 */
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ type: "ctx", text: a[i]! });
  for (let i = start; i < endA; i += 1) out.push({ type: "del", text: a[i]! });
  for (let i = start; i < endB; i += 1) out.push({ type: "add", text: b[i]! });
  for (let i = endA; i < a.length; i += 1) out.push({ type: "ctx", text: a[i]! });
  return out;
}

/**
 * `redact`: the same secret scanner every other Bot-visible string goes through (transcript-mirror.ts's
 * `d.redact` / approval-gate.ts's enriched-card redaction, both `phase3.scanners.redact(botId, text)`)
 * — a step's body is stored and streamed exactly like those, so a secret a Bot `cat`s, writes, or edits
 * must not reach store.db or the SSE wire unredacted just because this path is newer. Applied BEFORE
 * capping: a secret half-sliced off by a length cap would no longer match the scanner at all.
 *
 * fix round 2 (re-check of 9bb055e6, finding 1 — fail closed): `redact` is no longer defaulted to the
 * identity function. Absent entirely (no scanner wired up at all) or answering `null` for a given piece
 * of text (host/history/archive.ts's `Redactor` convention: "cannot redact yet, phase3 isn't up") both
 * mean the same thing here — no body, not an unredacted one. The FIRST fix round's `?? t` fallback at
 * every call site (turn-runner.ts, subagents.ts) and `: text` fallback in the wiring (host/app.ts) all
 * quietly stored raw text whenever the real scanner wasn't available; every one of those now answers
 * `null` instead, and `bodyFor` treats "no redactor" and "redactor said no" identically: no body.
 */
export function bodyFor(name: string, input: Record<string, unknown>, output: string, isError: boolean, redact?: (text: string) => string | null): StepBody | null {
  if (!redact) return null; // no scanner wired at all — never store text unredacted
  switch (name) {
    case "Read": {
      if (isError) return null;
      const filePath = String(input.file_path ?? "");
      if (!filePath) return null;
      const parsed = parseReadOutput(output);
      if (!parsed) return null;
      const redacted = redact(parsed.text);
      if (redacted === null) return null;
      const { text, truncated } = capText(redacted, LIMITS.stepBodyMaxChars, LIMITS.stepBodyMaxLines);
      return { kind: "read", path: filePath, language: langFor(filePath), content: text, startLine: parsed.startLine, truncated };
    }
    case "Write": {
      const filePath = String(input.file_path ?? "");
      const raw = typeof input.content === "string" ? input.content : null;
      if (!filePath || raw === null) return null;
      const redacted = redact(raw);
      if (redacted === null) return null;
      const { text, truncated } = capText(redacted, LIMITS.stepBodyMaxChars, LIMITS.stepBodyMaxLines);
      return { kind: "write", path: filePath, language: langFor(filePath), content: text, truncated };
    }
    case "Edit": {
      const filePath = String(input.file_path ?? "");
      const oldStr = typeof input.old_string === "string" ? input.old_string : null;
      const newStr = typeof input.new_string === "string" ? input.new_string : null;
      if (!filePath || oldStr === null || newStr === null) return null;
      const redactedOld = redact(oldStr);
      const redactedNew = redact(newStr);
      if (redactedOld === null || redactedNew === null) return null;
      const capped = capEditPair(redactedOld, redactedNew, LIMITS.stepBodyMaxChars, LIMITS.stepBodyMaxLines);
      const diff = diffLines(capped.old, capped.new);
      return { kind: "edit", path: filePath, language: langFor(filePath), diff, truncated: capped.truncated };
    }
    case "Bash": case "mcp__bot__Shell": {
      const rawCommand = String(input.command ?? "");
      if (!rawCommand) return null;
      const redactedCommand = redact(rawCommand);
      if (redactedCommand === null) return null;
      const cmd = capText(redactedCommand, LIMITS.shellEnrichChars, LIMITS.shellEnrichLines);
      const hasOutput = output.length > 0;
      let out: { text: string; truncated: boolean } | null = null;
      if (hasOutput) {
        const redactedOutput = redact(output);
        if (redactedOutput === null) return null;
        out = capText(redactedOutput, LIMITS.shellEnrichChars, LIMITS.shellEnrichLines);
      }
      return { kind: "command", command: cmd.text, output: out ? out.text : null, truncated: cmd.truncated || !!out?.truncated };
    }
    default:
      return null;
  }
}

/** CHAT-10: the growing "content" string of a streamed SendMessage input. */
export function extractPartialContent(partialJson: string): string | null {
  const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (!m) return null;
  const raw = (m[1] as string).replace(/\\$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}
