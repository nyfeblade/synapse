// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, SendMessageEntry, TranscriptEntry } from "@synapse/shared";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Bug-log row 193 — "code spits into the chat as plain text; give it proper code cards." Root cause
// (see CodeBlock.tsx's own header comment): Transcript.tsx's <Markdown> already parsed fences fine,
// it just gave a fenced block a bare bordered box and nothing at all beyond that — no language, no
// copy, no collapse, no distinct treatment for a whole file. This file is RED-first for the fix.

const bot = (id: string): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, lastBotMessageAt: 0,
  profile: { name: "Scout", title: "", description: "", avatarShape: "pebble", avatarColor: "#3FD08A", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
});

const botMsg = (id: string, content: string): TranscriptEntry => ({
  kind: "send-message", id, requestId: "r", createdAt: 2, message: { type: "text", content },
} satisfies SendMessageEntry);

const show = (entries: TranscriptEntry[]) => {
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { s: bot("s") }, transcripts: { s: entries } });
  render(<Transcript botId="s" />);
};

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(cleanup);

describe("Bot markdown — code cards (bug 193)", () => {
  it("renders a short fenced block as a code card with a sentence-case language label, and copies the exact code", async () => {
    show([botMsg("b1", `Here:\n\n${fence("ts", 'const x = 1;\nconsole.log(x);')}`)]);
    const card = document.querySelector(".code-card");
    expect(card, "no .code-card rendered for a fenced block").not.toBeNull();
    expect(card!.querySelector(".code-card-lang")?.textContent).toBe("TypeScript");
    // Never a raw, unstyled dump of the fence markers themselves.
    expect(document.querySelector(".transcript")!.textContent).not.toContain("```");
    fireEvent.click(card!.querySelector(".code-card-copy")!);
    await act(async () => { await Promise.resolve(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const x = 1;\nconsole.log(x);");
  });

  it("collapses a long block to ~14 lines with a fade + toggle, and expands/collapses on click", () => {
    show([botMsg("b1", fence("", numbered(25)))]);
    const card = document.querySelector(".code-card")!;
    expect(card.textContent).toContain("line 13");
    expect(card.textContent).not.toContain("line 14");
    const toggle = screen.getByRole("button", { name: "Show all 25 lines" });
    fireEvent.click(toggle);
    expect(card.textContent).toContain("line 14");
    expect(card.textContent).toContain("line 24");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(card.textContent).not.toContain("line 14");
  });

  it("renders a filename-labelled block as a file card that expands an inline preview on click", () => {
    show([botMsg("b1", fence("ts title=utils.ts", "export const id = <T>(x: T) => x;"))]);
    expect(document.querySelector(".code-card")).toBeNull();
    const fileCard = document.querySelector(".code-file-card")!;
    expect(fileCard, "no file card for a filename-labelled block").not.toBeNull();
    expect(fileCard.querySelector(".file-name")?.textContent).toBe("utils.ts");
    expect(fileCard.querySelector(".muted.small")?.textContent).toContain("1 line");
    expect(fileCard.querySelector(".code-card")).toBeNull();
    fireEvent.click(fileCard.querySelector(".file-main")!);
    expect(fileCard.querySelector(".code-card")).not.toBeNull();
    expect(fileCard.textContent).toContain("export const id");
  });

  it("renders a block over 120 lines as a file card even with no filename", () => {
    show([botMsg("b1", fence("py", numbered(130)))]);
    expect(document.querySelector(".code-card")).toBeNull();
    const fileCard = document.querySelector(".code-file-card")!;
    expect(fileCard).not.toBeNull();
    expect(fileCard.querySelector(".muted.small")?.textContent).toContain("130 lines");
  });

  it("renders inline `code` as a neutral chip, never a card", () => {
    show([botMsg("b1", "Call `foo()` first.")]);
    const chip = document.querySelector(".inline-code");
    expect(chip?.textContent).toBe("foo()");
    expect(document.querySelector(".code-card")).toBeNull();
    expect(document.querySelector(".transcript")!.textContent).not.toContain("`");
  });

  it("an open fence mid-stream renders progressively as a card, never raw backticks", () => {
    useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { s: bot("s") }, transcripts: { s: [] } });
    render(<Transcript botId="s" />);
    act(() => {
      useUi.setState((st) => ({ typing: { ...st.typing, s: { typing: true, partialText: "One sec —\n\n```js\nfunction hi() {\n  return 1;\n}" } } }));
    });
    expect(document.querySelector(".code-card")).not.toBeNull();
    expect(document.querySelector(".transcript")!.textContent).not.toContain("```");
  });

  it("never renders a Bot's raw HTML as live elements (XSS)", () => {
    show([botMsg("b1", 'before <img src=x onerror="window.__pwned = true"> after, and <script>window.__pwned2 = true</script> done.')]);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect((window as unknown as { __pwned2?: boolean }).__pwned2).toBeUndefined();
    expect(document.querySelector(".transcript img[onerror]")).toBeNull();
    expect(document.querySelector(".transcript script")).toBeNull();
  });

  it("only opens http(s)/mailto/app-scheme links, never javascript:", () => {
    show([botMsg("b1", "[go](javascript:alert(1)) and [mail](mailto:a@b.com) and [site](https://example.com)")]);
    const links = Array.from(document.querySelectorAll(".transcript a")) as HTMLAnchorElement[];
    const bad = links.find((a) => a.textContent === "go");
    const mail = links.find((a) => a.textContent === "mail");
    const site = links.find((a) => a.textContent === "site");
    expect(bad?.getAttribute("href") ?? "").not.toContain("javascript:");
    expect(mail?.getAttribute("href")).toBe("mailto:a@b.com");
    expect(site?.getAttribute("href")).toBe("https://example.com");
  });

  it("wraps a GFM table in its own scroll container", () => {
    show([botMsg("b1", "| a | b |\n| - | - |\n| 1 | 2 |")]);
    const wrap = document.querySelector(".table-scroll");
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector("table")).not.toBeNull();
  });
});
