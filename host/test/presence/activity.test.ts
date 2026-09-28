import { describe, expect, it } from "vitest";
import { bodyFor, describeCall, diffLines, extractPartialContent, iconFor, metricFor, stepText } from "../../presence/activity";
import { EMPTY_FILE_OUTPUT, REAL_OFFSET_SAMPLE_FIRST_LINE, REAL_OFFSET_SAMPLE_LAST_LINE, TRUNCATED_VIEW_FOOTER } from "./read-tool-fixtures";

describe("activity metrics (CHAT-22, ORIG-18 §18.1)", () => {
  it("counts connector items from results and arguments", () => {
    const out = JSON.stringify({ messages: Array.from({ length: 48 }, (_, i) => ({ id: `m${i}` })) });
    expect(metricFor("mcp__claude_ai_Gmail__search_threads", {}, out)).toMatchObject({ verb: "Read", noun: "email", nounPlural: "emails", count: 48 });
    expect(metricFor("mcp__claude_ai_Gmail__archive", { ids: ["a", "b", "c"] }, "ok")).toMatchObject({ verb: "Archived", count: 3 });
    expect(metricFor("mcp__claude_ai_Gmail__send_message", { to: "a@x.com" }, "ok")).toMatchObject({ verb: "Sent", count: 1 });
    expect(metricFor("mcp__claude_ai_Google_Calendar__delete_event", { event_id: "e1" }, "ok")).toMatchObject({ verb: "Deleted", noun: "event", count: 1 });
  });
  it("covers built-ins and hides internal tools", () => {
    expect(metricFor("WebFetch", { url: "https://a.com/x#frag" }, "")).toMatchObject({ verb: "Browsed", noun: "page", itemIds: ["https://a.com/x"] });
    expect(metricFor("Read", { file_path: "/workspace/a.md" }, "")).toMatchObject({ verb: "Read", noun: "file", itemIds: ["/workspace/a.md"] });
    expect(metricFor("Edit", { file_path: "/workspace/a.md" }, "")).toMatchObject({ verb: "Edited", noun: "file" });
    expect(metricFor("Bash", { command: "npm test" }, "212 passed")).toMatchObject({ verb: "Ran", noun: "command", count: 1 });
    expect(metricFor("mcp__claude_ai_Notion__update_page", {}, "")).toMatchObject({ verb: "Used Notion", noun: "time" });
    expect(metricFor("mcp__bot__SendMessage", {}, "")).toBeNull();
    expect(metricFor("TodoWrite", {}, "")).toBeNull();
    expect(describeCall("mcp__claude_ai_Gmail__send_message", {})).toMatchObject({ future: "send", nounPlural: "emails" });
  });
  it("writes CHAT-05 step lines and icons", () => {
    expect(stepText("Bash", { command: "npm test" }, "Tests: 212 passed")).toBe("Ran npm test · 212 passed");
    expect(stepText("Edit", { file_path: "/w/math.ts", old_string: "a\nb", new_string: "a\nb\nc\nd" })).toBe("Edited math.ts +4 −2");
    expect(stepText("Write", { file_path: "/w/notes.md" })).toBe("Created notes.md");
    expect(stepText("Grep", { pattern: "toFixed" })).toBe('Searched code "toFixed"');
    expect(stepText("WebSearch", { query: "standing desks" })).toBe('Searched the web "standing desks"');
    expect(stepText("WebFetch", { url: "https://example.com/a" })).toBe("Read example.com");
    // Gate L-1: a call still running (or parked on an approval card) reads in the present tense.
    expect(stepText("Bash", { command: "rm -rf /workspace/clients/old-acme" }, "", true)).toBe("Running rm -rf /workspace/clients/old-acme");
    expect(stepText("Edit", { file_path: "/w/math.ts", old_string: "a", new_string: "b" }, "", true)).toBe("Editing math.ts");
    expect(stepText("Write", { file_path: "/w/notes.md" }, "", true)).toBe("Creating notes.md");
    expect(stepText("Read", { file_path: "/w/AGENTS.md" }, "", true)).toBe("Reading AGENTS.md");
    expect(stepText("Grep", { pattern: "toFixed" }, "", true)).toBe('Searching code "toFixed"');
    expect(stepText("WebSearch", { query: "standing desks" }, "", true)).toBe('Searching the web "standing desks"');
    expect(stepText("WebFetch", { url: "https://example.com/a" }, "", true)).toBe("Reading example.com");
    expect(stepText("TodoWrite", {}, "", true)).toBe("Updating the plan");
    expect(stepText("mcp__claude_ai_Gmail__send_message", {}, "", true)).toBe("Using Gmail send_message");
    expect(iconFor("mcp__claude_ai_Gmail__search_threads")).toBe("mail");
    expect(iconFor("Bash")).toBe("terminal");
  });
  it("extracts streaming SendMessage content from partial JSON (CHAT-10)", () => {
    expect(extractPartialContent('{"content":"Hel')).toBe("Hel");
    expect(extractPartialContent('{"type":"text","content":"a\\nb\\"c')).toBe('a\nb"c');
    expect(extractPartialContent('{"type":"te')).toBeNull();
  });
});

// bug 198: "like 500 lines of code were not in a box and 30 were" — the 30 were a fenced block in the
// Bot's own reply (bug 193). No stored reply is anywhere near 500 lines, so the unboxed code was a
// step's own content: ActivityGroup.tsx's `ol.steps` only ever had a one-line `step` summary and no
// body at all to give a Read/Write/Edit/Bash step a card. `bodyFor` is that body, built once at
// tool_end and rendered lazily (StepBody.tsx) only once that step row is opened.
//
// Fix round 1 (review of 872df075): the first version re-read a Read step's file straight off disk, as
// the HOST's own uid — an authorization bypass (another Bot's home, a host-private token, a symlink the
// Bot's own sandbox would have refused all still "succeeded" here), could hang the event loop on a
// FIFO, and ignored the Read tool's own offset/limit. `bodyFor` now builds the Read body from the
// tool's own `cat -n`-shaped output only — never the disk — and every body goes through the same
// secret redactor as everything else Bot-visible before it is capped (a cap-then-redact order would
// let a length cut slice a secret in half and dodge the scanner).
const cat = (start: number, lines: string[]): string => lines.map((l, i) => `${start + i}\t${l}`).join("\n");
const shout = (t: string) => t.toUpperCase(); // a stand-in "redactor" simple enough to assert on exactly
// fix round 2, finding 1 (fail closed): most of these tests are about capping/parsing/diffing, not
// redaction, so they pass a no-op stand-in explicitly — `bodyFor` no longer defaults to one itself.
const identity = (t: string): string => t;

describe("bodyFor — step bodies for a code card (bug 198, fix round 1)", () => {
  it("Read builds its body from the tool's own cat -n output, never the disk", () => {
    expect(bodyFor("Read", { file_path: "/w/math.ts" }, cat(1, ["const a = 1;", "const b = 2;"]), false, identity)).toEqual({
      kind: "read", path: "/w/math.ts", language: "ts", content: "const a = 1;\nconst b = 2;", startLine: 1, truncated: false,
    });
  });

  it("offset/limit output is kept correct: the real starting line number is read off the output, never assumed to be 1", () => {
    const body = bodyFor("Read", { file_path: "/w/big.py", offset: 100, limit: 2 }, cat(101, ["foo", "bar"]), false, identity) as { startLine: number; content: string };
    expect(body.startLine).toBe(101);
    expect(body.content).toBe("foo\nbar");
  });

  it("an output that is not cat -n shaped (denied, an image/PDF result, a symlink's own listing) gets no body — never a guess", () => {
    expect(bodyFor("Read", { file_path: "/w/secret" }, "Permission denied", false, identity)).toBeNull();
    expect(bodyFor("Read", { file_path: "/w/photo.png" }, "[image data]", false, identity)).toBeNull();
    expect(bodyFor("Read", { file_path: "/w/link" }, "", false, identity)).toBeNull();
  });

  it("the isError path: a failed Read gets no body even if the output happens to look line-numbered", () => {
    expect(bodyFor("Read", { file_path: "/w/math.ts" }, cat(1, ["const a = 1;"]), true, identity)).toBeNull();
  });

  it("a 500-line Read is a body, not a hole — the renderer decides how to fold it", () => {
    const body = bodyFor("Read", { file_path: "/w/big.py" }, cat(1, Array.from({ length: 500 }, (_, i) => `line ${i}`)), false, identity);
    expect(body?.kind).toBe("read");
    expect((body as { content: string }).content.split("\n").length).toBe(500);
    expect(body?.truncated).toBe(false);
  });

  it("Read is capped at stepBodyMaxChars/stepBodyMaxLines and says so", () => {
    const body = bodyFor("Read", { file_path: "/w/huge.txt" }, cat(1, Array.from({ length: 2000 }, () => "x".repeat(100))), false, identity) as { content: string; truncated: boolean };
    expect(body.content.length).toBeLessThanOrEqual(32_000);
    expect(body.content.split("\n").length).toBeLessThanOrEqual(800);
    expect(body.truncated).toBe(true);
  });

  it("Write carries the content it is about to write, from the call's own input", () => {
    expect(bodyFor("Write", { file_path: "/w/notes.md", content: "# Notes\nhi\n" }, "", false, identity)).toEqual({
      kind: "write", path: "/w/notes.md", language: "md", content: "# Notes\nhi\n", truncated: false,
    });
  });

  it("Edit is a diff: common prefix/suffix as context, the changed middle as removed then added", () => {
    const body = bodyFor("Edit", { file_path: "/w/math.ts", old_string: "a\nb\nc", new_string: "a\nX\nY\nc" }, "", false, identity);
    expect(body).toEqual({
      kind: "edit", path: "/w/math.ts", language: "ts", truncated: false,
      diff: [
        { type: "ctx", text: "a" }, { type: "del", text: "b" }, { type: "add", text: "X" }, { type: "add", text: "Y" }, { type: "ctx", text: "c" },
      ],
    });
  });

  it("Edit caps old and new at the SAME point (half the combined budget each), never one side alone", () => {
    // 100 lines, ~500 chars each: well under the 800-line cap, so only the CHAR cap can be at work here.
    const oldStr = Array.from({ length: 100 }, (_, i) => `old${i}:${"x".repeat(500)}`).join("\n");
    const newStr = "a\nb"; // tiny — nowhere near either cap on its own
    const body = bodyFor("Edit", { file_path: "/w/big.ts", old_string: oldStr, new_string: newStr }, "", false, identity) as { diff: { type: string; text: string }[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    const oldChars = body.diff.filter((l) => l.type !== "add").reduce((n, l) => n + l.text.length, 0);
    expect(oldChars).toBeLessThanOrEqual(32_000 / 2); // the old side alone never eats the whole combined budget
  });

  it("a cap never splits a multibyte character (a surrogate pair stays whole or is dropped, never orphaned)", () => {
    const emoji = "🎉"; // a surrogate pair — 2 UTF-16 code units
    const oldStr = "x".repeat(31_999) + emoji; // the pair straddles the exact cap boundary
    const body = bodyFor("Write", { file_path: "/w/e.txt", content: oldStr }, "", false, identity) as { content: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    // A dangling low surrogate (0xDC00–0xDFFF) as the last code unit means the pair was split.
    const last = body.content.charCodeAt(body.content.length - 1);
    expect(last < 0xdc00 || last > 0xdfff).toBe(true);
  });

  it("Bash carries the command and its output as separate cards' worth of content", () => {
    expect(bodyFor("Bash", { command: "npm test" }, "212 passed", false, identity)).toEqual({ kind: "command", command: "npm test", output: "212 passed", truncated: false });
    expect(bodyFor("Bash", { command: "npm test" }, "", false, identity)).toEqual({ kind: "command", command: "npm test", output: null, truncated: false });
  });

  it("Bash output over shellEnrichLines/Chars is capped and marked truncated", () => {
    const body = bodyFor("Bash", { command: "cat big.log" }, Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), false, identity) as { output: string; truncated: boolean };
    expect(body.output.split("\n").length).toBe(200);
    expect(body.truncated).toBe(true);
  });

  it("a tool with no code-like content gets no body (WebSearch, Grep, mac-apps, …)", () => {
    expect(bodyFor("Grep", { pattern: "toFixed" }, "3 matches", false, identity)).toBeNull();
    expect(bodyFor("WebSearch", { query: "x" }, "", false, identity)).toBeNull();
    expect(bodyFor("mcp__bot__MacApp", { action: "open", app: "Mail" }, "", false, identity)).toBeNull();
  });

  // Fix round 1, finding 3: a step's body is stored and streamed exactly like every other Bot-visible
  // string, so it goes through the same redactor. `redact` here stands in for the real secret scanner
  // (host/secrets/scanner.ts's ScannerRegistry.redact) — the wiring that calls it with the REAL one is
  // covered separately, in host/test/runner/turn-runner.test.ts.
  it("redacts a secret in Bash output before it is stored", () => {
    const body = bodyFor("Bash", { command: "cat token.txt" }, "token: sk-live-abc123", false, shout) as { output: string };
    expect(body.output).toBe("TOKEN: SK-LIVE-ABC123");
  });

  it("redacts a secret in Write content before it is stored", () => {
    const body = bodyFor("Write", { file_path: "/w/.env", content: "API_KEY=sk-live-abc123" }, "", false, shout) as { content: string };
    expect(body.content).toBe("API_KEY=SK-LIVE-ABC123");
  });

  it("redacts a secret in a Read body and in an Edit's old/new before diffing", () => {
    const read = bodyFor("Read", { file_path: "/w/.env" }, cat(1, ["API_KEY=sk-live-abc123"]), false, shout) as { content: string };
    expect(read.content).toBe("API_KEY=SK-LIVE-ABC123");
    const edit = bodyFor("Edit", { file_path: "/w/.env", old_string: "sk-live-old", new_string: "sk-live-new" }, "", false, shout) as { diff: { type: string; text: string }[] };
    expect(edit.diff).toEqual([{ type: "del", text: "SK-LIVE-OLD" }, { type: "add", text: "SK-LIVE-NEW" }]);
  });

  it("redacts the command itself, not just its output", () => {
    const body = bodyFor("Bash", { command: "curl -H 'Authorization: sk-live-abc123'" }, "", false, shout) as { command: string };
    expect(body.command).toBe("CURL -H 'AUTHORIZATION: SK-LIVE-ABC123'");
  });

  // Fix round 2 (re-check of 9bb055e6), finding 1: FAIL CLOSED. Every call site's own `?? t` /
  // `: text` fallback used to quietly store raw text whenever the real scanner wasn't wired up yet;
  // `bodyFor` itself is the one place that has to refuse, since it is the last stop before the body
  // becomes a stored, streamed `StepBody`.
  describe("fails closed with no redactor, rather than storing anything unredacted", () => {
    it("no redactor at all (undefined) — no body, for every tool family that would otherwise have one", () => {
      expect(bodyFor("Read", { file_path: "/w/math.ts" }, cat(1, ["const a = 1;"]), false)).toBeNull();
      expect(bodyFor("Write", { file_path: "/w/notes.md", content: "hi" }, "", false)).toBeNull();
      expect(bodyFor("Edit", { file_path: "/w/math.ts", old_string: "a", new_string: "b" }, "", false)).toBeNull();
      expect(bodyFor("Bash", { command: "npm test" }, "212 passed", false)).toBeNull();
    });

    it("the redactor answering null (host/history/archive.ts's Redactor: \"cannot redact yet\") also means no body", () => {
      const notReady = () => null;
      expect(bodyFor("Read", { file_path: "/w/math.ts" }, cat(1, ["const a = 1;"]), false, notReady)).toBeNull();
      expect(bodyFor("Write", { file_path: "/w/notes.md", content: "hi" }, "", false, notReady)).toBeNull();
      expect(bodyFor("Edit", { file_path: "/w/math.ts", old_string: "a", new_string: "b" }, "", false, notReady)).toBeNull();
      expect(bodyFor("Bash", { command: "npm test" }, "212 passed", false, notReady)).toBeNull();
    });

    it("a Bash command that redacts fine but whose OUTPUT the redactor refuses still gets no body — not a half-redacted one", () => {
      const commandOnly = (t: string) => (t === "npm test" ? t : null);
      expect(bodyFor("Bash", { command: "npm test" }, "212 passed", false, commandOnly)).toBeNull();
    });

    it("an Edit where the redactor refuses only the NEW string still gets no body — not a half-redacted diff", () => {
      const oldOnly = (t: string) => (t === "a" ? t : null);
      expect(bodyFor("Edit", { file_path: "/w/math.ts", old_string: "a", new_string: "b" }, "", false, oldOnly)).toBeNull();
    });
  });
});

// Fix round 2, finding 2 (MUST VERIFY): checked against REAL Read tool_results — see
// host/test/presence/read-tool-fixtures.ts's header for exactly where each fixture came from
// (genuine stored transcripts under this repo's own ~/.claude/projects/, plus three live probes).
describe("parseReadOutput (via bodyFor) — checked against real Read tool_results, not invented", () => {
  it("a real captured empty-file notice has no numbered line at all, so it is no body — not a guess", () => {
    expect(bodyFor("Read", { file_path: "/w/empty.txt" }, EMPTY_FILE_OUTPUT, false, identity)).toBeNull();
  });

  it("a real trailing footer (this harness's own view-budget notice) gets stripped, not dropping the body it follows", () => {
    const output = `${cat(1, ["line a", "line b", "line c"])}\n${TRUNCATED_VIEW_FOOTER}`;
    const body = bodyFor("Read", { file_path: "/w/big.log" }, output, false, identity) as { content: string; startLine: number } | null;
    expect(body, "an unknown trailing block must not drop the whole body").not.toBeNull();
    expect(body!.startLine).toBe(1);
    expect(body!.content).toBe("line a\nline b\nline c"); // the footer itself never appears in the body
    expect(body!.content).not.toContain("Truncated");
  });

  it("the real captured shape (no padding, no arrow — bare number + tab) parses cleanly at both ends of a real sample", () => {
    const output = [REAL_OFFSET_SAMPLE_FIRST_LINE, "101\t  /** …a real middle line… */", REAL_OFFSET_SAMPLE_LAST_LINE].join("\n");
    const body = bodyFor("Read", { file_path: "/w/qwen.ts" }, output, false, identity) as { content: string; startLine: number };
    expect(body.startLine).toBe(100); // the real sample's own offset, never assumed to be 1
    expect(body.content.split("\n")[0]).toBe("  text: string;");
    expect(body.content.split("\n").at(-1)).toBe("    return checked;");
  });

  it("also tolerates leading-space padding and a → separator (defensive against a pinned-CLI version drift), even though the real capture uses neither", () => {
    const padded = "   1 → const a = 1;\n   2 → const b = 2;";
    const body = bodyFor("Read", { file_path: "/w/math.ts" }, padded, false, identity) as { content: string; startLine: number };
    expect(body.startLine).toBe(1);
    expect(body.content).toBe("const a = 1;\nconst b = 2;");
  });
});

describe("diffLines — a single contiguous replacement, trimmed to its common edges", () => {
  it("no change at all is all context", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ type: "ctx", text: "a" }, { type: "ctx", text: "b" }]);
  });
  it("a pure addition has no removals", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([{ type: "ctx", text: "a" }, { type: "add", text: "b" }, { type: "ctx", text: "c" }]);
  });
  it("a pure removal has no additions", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([{ type: "ctx", text: "a" }, { type: "del", text: "b" }, { type: "ctx", text: "c" }]);
  });
});

describe("Phase 3 bot tools show as activity (T29 box finding, ORIG-18 §18.1)", () => {
  it("Shell is 'Ran' a command, Task is 'Ran a task', Screenshot is 'Took a screenshot'; messaging and bookkeeping stay hidden", async () => {
    const { isHiddenActivity } = await import("../../presence/activity");
    for (const n of ["mcp__bot__Shell", "mcp__bot__Task", "mcp__bot__Screenshot"]) expect(isHiddenActivity(n), n).toBe(false);
    for (const n of ["mcp__bot__SendMessage", "mcp__bot__update_state", "mcp__bot__AwaitShell", "mcp__bot__CheckSubagent", "mcp__bot__request_box_help", "TodoWrite", "ToolSearch"]) expect(isHiddenActivity(n), n).toBe(true);
    expect(metricFor("mcp__bot__Shell", { command: "npm test" }, "12 passed")).toMatchObject({ verb: "Ran", noun: "command", count: 1 });
    expect(stepText("mcp__bot__Shell", { command: "npm test" }, "12 passed")).toBe("Ran npm test · 12 passed");
    expect(stepText("mcp__bot__Shell", { command: "npm test" }, "", true)).toBe("Running npm test");
    expect(stepText("mcp__bot__Task", { description: "Check the fare" })).toBe("Ran a task: Check the fare");
    expect(stepText("mcp__bot__Screenshot", {})).toBe("Took a screenshot");
    expect(iconFor("mcp__bot__Shell")).toBe("terminal");
  });
});
