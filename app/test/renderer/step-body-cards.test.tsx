// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityIcon, DiffLine, StepBody, ToolCallEntry } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import type { TranscriptItem } from "../../src/renderer/transcript-items";

/**
 * Bug 198 — "like 500 lines of code were not in a box and 30 were." The 30 boxed lines were a fenced
 * block in a Bot reply (bug 193's CodeBlock.tsx card). No stored Bot reply is anywhere near 500 lines
 * (largest ~2.7k chars), so the unboxed code came from content the chat shows LIVE: a step's own
 * Read/Write/Edit/Bash content. ActivityGroup.tsx's `ol.steps` only ever rendered a one-line summary —
 * `{icon} {s.step}` — with no body at all, so a step whose content ran long had nowhere to go but a
 * bare text node. RED-first for `ToolCallEntry.body` + StepBody.tsx's cards.
 */

const numbered = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

const step = (id: string, stepText: string, body: StepBody | null): ToolCallEntry => ({
  kind: "tool-call", id, requestId: "r1", segmentId: "s1", hidden: false, name: "Bash",
  step: stepText, icon: "file" as ActivityIcon, metric: null, status: "done", startedAt: 0, body,
});

const item = (steps: ToolCallEntry[]): Extract<TranscriptItem, { kind: "activity" }> => ({
  kind: "activity", key: "act-1", more: 0, running: false,
  rows: [{ verb: "Read", noun: "files", count: steps.length, icon: "file" as ActivityIcon }],
  steps,
});

const openSteps = () => fireEvent.click(screen.getByRole("button", { name: "Show steps" }));

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(cleanup);

describe("ActivityGroup — a step's own body never renders as bare text (bug 198)", () => {
  it("a step with no body renders exactly as before: icon + summary, nothing else, no toggle", () => {
    render(<ActivityGroup item={item([step("t1", "Searched code \"toFixed\"", null)])} />);
    openSteps();
    expect(screen.getByText("Searched code \"toFixed\"")).toBeTruthy();
    expect(document.querySelector(".step-toggle")).toBeNull();
    expect(document.querySelector(".step-body")).toBeNull();
  });

  it("a step WITH a body does nothing until its own row is expanded (lazy, twice over)", () => {
    const body: StepBody = { kind: "read", path: "/w/big.py", language: "py", content: numbered(500), startLine: 1, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Read big.py", body)])} />);
    openSteps();
    // The step row exists (ol.steps is open) but its body must not be in the DOM yet.
    expect(screen.getByRole("button", { name: /Read big.py/ })).toBeTruthy();
    expect(document.querySelector(".step-body")).toBeNull();
    expect(document.body.textContent).not.toContain("line 499");
  });

  it("a 500-line Read step, once expanded, renders inside a card — file-card first (>120 lines), then a folded code card with 'Show all 500 lines'", () => {
    const body: StepBody = { kind: "read", path: "/w/big.py", language: "py", content: numbered(500), startLine: 1, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Read big.py", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Read big.py/ }));
    const fileCard = document.querySelector(".step-body .code-file-card");
    expect(fileCard, "a >120-line body must get the file-card treatment, not a wall of code inline").not.toBeNull();
    expect(document.querySelector(".step-body > .code-card"), "no bare inline code card before the file row is opened").toBeNull();
    fireEvent.click(fileCard!.querySelector(".file-main")!);
    const card = document.querySelector(".step-body .code-card")!;
    expect(card, "no code card after opening the file row").not.toBeNull();
    expect(card.textContent).toContain("line 13");
    expect(card.textContent).not.toContain("line 14");
    expect(screen.getByRole("button", { name: "Show all 500 lines" })).toBeTruthy();
    // Nothing here is a bare text node outside the card: the whole 500-line body lives inside .code-card-pre.
    expect(document.querySelectorAll(".step-body pre").length).toBeGreaterThan(0);
  });

  it("expanding a 500-line card caps the initial render at RENDER_CAP (400) with a further 'Show more'", () => {
    const body: StepBody = { kind: "read", path: "/w/big.py", language: "py", content: numbered(500), startLine: 1, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Read big.py", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Read big.py/ }));
    fireEvent.click(document.querySelector(".step-body .code-file-card .file-main")!);
    fireEvent.click(screen.getByRole("button", { name: "Show all 500 lines" }));
    // 14 (initial head) + 400 (RENDER_CAP) = line 413 shown, line 414 not yet.
    expect(document.body.textContent).toContain("line 413");
    expect(document.body.textContent).not.toContain("line 414");
    const more = screen.getByRole("button", { name: /Show \d+ more lines/ });
    fireEvent.click(more);
    expect(document.body.textContent).toContain("line 499");
  });

  it("a Bash step renders a command card and an output card, not a text dump", () => {
    const body: StepBody = { kind: "command", command: "npm test", output: "212 passed\n0 failed", truncated: false };
    render(<ActivityGroup item={item([step("t1", "Ran npm test", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Ran npm test/ }));
    const cards = document.querySelectorAll(".step-body .code-card");
    expect(cards.length, "expected a command card and an output card").toBe(2);
    expect(cards[0]!.querySelector(".code-card-lang")?.textContent).toBe("Shell");
    expect(cards[0]!.textContent).toContain("npm test");
    expect(cards[1]!.querySelector(".code-card-lang")?.textContent).toBe("Output");
    expect(cards[1]!.textContent).toContain("212 passed");
  });

  it("a Bash step with no output yet renders only the command card", () => {
    const body: StepBody = { kind: "command", command: "npm test", output: null, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Running npm test", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Running npm test/ }));
    expect(document.querySelectorAll(".step-body .code-card").length).toBe(1);
  });

  it("an Edit step renders a diff card with neutral +/- lines, never red/green", () => {
    const diff: DiffLine[] = [
      { type: "ctx", text: "function add(a, b) {" },
      { type: "del", text: "  return a - b;" },
      { type: "add", text: "  return a + b;" },
      { type: "ctx", text: "}" },
    ];
    const body: StepBody = { kind: "edit", path: "/w/math.ts", language: "ts", diff, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Edited math.ts +1 −1", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Edited math.ts/ }));
    const diffCard = document.querySelector(".step-body .diff-card");
    expect(diffCard, "no diff card for an Edit step").not.toBeNull();
    expect(diffCard!.querySelector(".code-card-lang")?.textContent).toBe("Diff");
    const del = diffCard!.querySelector(".diff-del")!;
    const add = diffCard!.querySelector(".diff-add")!;
    expect(del.textContent).toContain("return a - b;");
    expect(add.textContent).toContain("return a + b;");
    // Neutral tones only: no literal colour and no "red"/"green" class anywhere in the diff card.
    expect(diffCard!.innerHTML).not.toMatch(/\bred\b|\bgreen\b/i);
    expect(diffCard!.getAttribute("style") ?? "").not.toMatch(/color/i);
  });

  it("a truncated body says so", () => {
    const body: StepBody = { kind: "command", command: "cat huge.log", output: numbered(200), truncated: true };
    render(<ActivityGroup item={item([step("t1", "Ran cat huge.log", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Ran cat huge.log/ }));
    expect(document.querySelector(".step-body-note")).toBeTruthy();
  });

  // Fix round 1 (review of 872df075), finding 7: collapsing a fully-expanded RENDER_CAP-tiered card
  // must also drop `showAll`, or re-expanding it skips straight past the "Show N more lines" tier —
  // the stale `showAll=true` survives the collapse and silently changes what the next expand shows.
  it("'Show less' resets the RENDER_CAP tier, so re-expanding needs 'Show N more lines' again", () => {
    const body: StepBody = { kind: "read", path: "/w/big.py", language: "py", content: numbered(500), startLine: 1, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Read big.py", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Read big.py/ }));
    fireEvent.click(document.querySelector(".step-body .code-file-card .file-main")!);
    fireEvent.click(screen.getByRole("button", { name: "Show all 500 lines" }));
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more lines/ }));
    expect(document.body.textContent).toContain("line 499"); // fully expanded
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.body.textContent).not.toContain("line 14"); // collapsed back to the 14-line head
    fireEvent.click(screen.getByRole("button", { name: "Show all 500 lines" }));
    expect(document.body.textContent).toContain("line 413");
    expect(document.body.textContent, "re-expanding must go through the RENDER_CAP tier again, not straight to the end").not.toContain("line 414");
    expect(screen.getByRole("button", { name: /Show \d+ more lines/ })).toBeTruthy();
  });

  it("an Edit diff's 'Show less' resets the same way", () => {
    const diff: DiffLine[] = Array.from({ length: 450 }, (_, i) => ({ type: "add" as const, text: `line ${i}` }));
    const body: StepBody = { kind: "edit", path: "/w/big.ts", language: "ts", diff, truncated: false };
    render(<ActivityGroup item={item([step("t1", "Edited big.ts", body)])} />);
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: /Edited big.ts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show all 450 lines" }));
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more lines/ }));
    expect(document.body.textContent).toContain("line 449");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all 450 lines" }));
    expect(document.body.textContent).not.toContain("line 449");
    expect(screen.getByRole("button", { name: /Show \d+ more lines/ })).toBeTruthy();
  });
});

// Fix round 1, finding 4: `.step` is a flex row (icon + one-line summary); a step's own body
// (StepBody.tsx) is a second item in that SAME row and, without an explicit full-width claim, sat
// BESIDE the summary instead of below it. jsdom does not compute real flex layout, so this — like
// theme-literals.test.ts/interaction-states.test.ts elsewhere in this suite — reads the stylesheets
// themselves and asserts the declarations that make it wrap.
describe("layout — a step's body renders below its summary, not beside it (bug 198, fix round 1)", () => {
  it(".step wraps its flex row, and .step-body claims the full row so it drops to its own line", async () => {
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const appCss = read("../../src/renderer/styles/app.css");
    const codeBlockCss = read("../../src/renderer/styles/code-block.css");
    const ruleBody = (src: string, selector: string) => src.match(new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
    const stepRule = ruleBody(appCss, "\\.step");
    expect(stepRule, ".step must be a flex row that WRAPS, so a second item (the body) can drop to a new line").toMatch(/display:\s*flex/);
    expect(stepRule).toMatch(/flex-wrap:\s*wrap/);
    const bodyRule = ruleBody(codeBlockCss, "\\.step-body");
    expect(bodyRule, ".step-body must claim the full row width so it wraps onto its own line, below the toggle").toMatch(/flex-basis:\s*100%|flex:\s*[\d.]+\s+[\d.]+\s+100%/);
  });
});
