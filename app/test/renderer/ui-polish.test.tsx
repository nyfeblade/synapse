// @vitest-environment jsdom
// The UI polish pass (2026-09-24): the design critique's top 10 and the second brief, pinned.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRC } from "@synapse/shared";
import { initials } from "../../src/renderer/components/Sidebar";
import { EmptyView } from "../../src/renderer/components/EmptyView";
import { ConfirmHost, askConfirm } from "../../src/renderer/components/ConfirmDialog";
import { ScreenAbsenceNote, SHOW_ELAPSED_AFTER_S } from "../../src/renderer/components/ScreenAbsenceNote";
import { contrast, resolve, themeBlocks } from "./contrast-kit";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "styles");
const read = (f: string) => readFileSync(path.join(stylesDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("app.css");
const tokens = read("tokens.css");
/** Every declaration body whose selector list contains `sel` exactly. */
const bodies = (src: string, sel: string) => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(",").some((s) => s.trim() === sel)).map((m) => m[2]!).join(";");

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the chat-pane grid", () => {
  it("defines the four grid tokens once, in :root", () => {
    for (const [t, v] of [["--chat-inset", "56px"], ["--bot-indent", "32px"], ["--bot-col", "680px"], ["--bar-h", "56px"]]) {
      expect(tokens).toMatch(new RegExp(`${t}:\\s*${v};`));
    }
  });
  it("puts the transcript, the composer and every Bot-side block on those tokens", () => {
    expect(bodies(app, ".transcript")).toMatch(/padding-inline:\s*var\(--chat-inset\)/);
    expect(bodies(app, ".composer-wrap")).toMatch(/var\(--chat-inset\)/);
    expect(bodies(app, ".composer")).toMatch(/padding:[^;]*var\(--bot-indent\)/);
    for (const sel of [".card", ".activity"]) {
      expect(bodies(app, sel), sel).toMatch(/max-width:\s*var\(--bot-col\)/);
      expect(bodies(app, sel), sel).toMatch(/margin-left:\s*var\(--bot-indent\)/);
    }
    expect(bodies(app, ".bubble.bot")).toMatch(/max-width:\s*var\(--bot-col\)/);
    expect(bodies(app, ".msg.bot > .msg-line")).toMatch(/width:\s*100%/);
  });
  it("gives the panel and Computer bars the header's height; the header keeps its own 56", () => {
    for (const sel of [".chat-header", ".panel-bar", ".panel-head", ".panel-tools", ".cv-titlebar"]) {
      expect(bodies(app, sel), sel).toMatch(/height:\s*var\(--bar-h\)/);
    }
  });
});

describe("hover, selected and group are three different fills, in both themes", () => {
  const blocks = themeBlocks();
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: distinct, and visible against the page`, () => {
      const bg = resolve(blocks, theme, "--bg");
      const [hover, selected, group] = ["--fill-hover", "--fill-selected", "--fill-group"].map((n) => resolve(blocks, theme, n));
      expect(new Set([hover, selected, group]).size).toBe(3);
      expect(contrast(selected!, bg), `selected ${selected} on ${bg}`).toBeGreaterThanOrEqual(1.15);
      expect(contrast(hover!, bg), `hover ${hover} on ${bg}`).toBeGreaterThanOrEqual(1.1);
      expect(contrast(selected!, hover!), "selected must read as a step past hover").toBeGreaterThanOrEqual(1.05);
    });
  }
});

describe("the default arrow cursor", () => {
  it("no stylesheet asks for the pointing hand except on the two true links", () => {
    const sheets = ["app.css", "palette.css", "skills.css", "code-block.css", "voice-calls.css", "files.css", "widgets.css", "message-actions.css"];
    const offenders = sheets.flatMap((f) => [...read(f).matchAll(/([^{}]+)\{([^{}]*cursor:\s*pointer[^{}]*)\}/g)].map((m) => `${f}: ${m[1]!.trim()}`));
    expect(offenders).toEqual([".inline-link", ".crash-toast-view"].map((s) => `app.css: ${s}`));
  });
});

describe("hit targets of at least 28px", () => {
  it("grows the short controls' hit area with an invisible ::before", () => {
    const grows = (sel: string, inset: RegExp) => expect(bodies(app, `${sel}::before`), sel).toMatch(inset);
    for (const sel of [".btn-compact", ".btn-outline.small", ".pill", ".cv-monitor", ".segment", '.panel-tabs [role="tab"]']) grows(sel, /inset:\s*-2px 0/); // 24 -> 28
    grows(".switch", /inset:\s*-5px -2px/); // 18 -> 28
    grows(".reaction", /inset:\s*-3px/); // 22 -> 28
    expect(bodies(app, ".row-call")).toMatch(/width:\s*28px/);
    expect(bodies(app, ".row-call")).toMatch(/height:\s*28px/);
  });
});

describe("the account monogram", () => {
  it("takes the first and last initials", () => {
    expect(initials("Alex Rivera")).toBe("AR");
    expect(initials("  ada  lovelace byron ")).toBe("AB");
    expect(initials("Cher")).toBe("CH");
    expect(initials("")).toBe("");
  });
});

describe("EmptyView", () => {
  it("is an icon, a title, one line and one action", () => {
    const onClick = vi.fn();
    render(<EmptyView icon={<svg />} title="No matching settings" line="Try another word." action={{ label: "Clear", onClick }} />);
    const view = screen.getByRole("status");
    expect(view.querySelectorAll(".empty-view-title")).toHaveLength(1);
    expect(view.querySelectorAll(".empty-view-line")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClick).toHaveBeenCalled();
  });
  it("never shows empty while loading (the mutex)", () => {
    render(<EmptyView title="Nothing here" loading />);
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });
});

describe("the destructive confirm", () => {
  it("names its act, and Cancel changes nothing", async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean>;
    act(() => { answer = askConfirm({ title: "Delete Scout?", verb: "Delete" }); });
    const dialog = screen.getByRole("dialog", { name: "Delete Scout?" });
    expect(dialog.querySelector(".btn-danger")?.textContent).toBe("Delete");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer!).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { answer = askConfirm({ title: "Remove Linear?", verb: "Remove" }); });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await expect(answer!).resolves.toBe(true);
  });
});

describe("the Computer stage", () => {
  it("a slow connection shows how long it has been trying once it passes ten seconds", () => {
    vi.useFakeTimers();
    render(<ScreenAbsenceNote absence={{ kind: "connecting" }} botName="Scout" variant="stage" />);
    expect(screen.queryByText(/Still trying/)).toBeNull();
    act(() => { vi.advanceTimersByTime((SHOW_ELAPSED_AFTER_S + 2) * 1000); });
    expect(screen.getByText(STRC.stillConnecting(SHOW_ELAPSED_AFTER_S + 2))).toBeTruthy();
  });
  it("an error is a title, one plain line and one Retry", () => {
    const onRetry = vi.fn();
    render(<ScreenAbsenceNote absence={{ kind: "dial-failed" }} botName="Scout" variant="stage" onRetry={onRetry} />);
    expect(screen.getByText(STRC.cantReach)).toBeTruthy();
    expect(screen.getByText(STRC.dialFailedHelp)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("the Bot's cursor tag is black with a white outline, not violet", () => {
    expect(bodies(app, ".cursor-label")).toMatch(/background:\s*var\(--cursor-tag\)/);
    expect(bodies(app, ".cursor-label")).toMatch(/box-shadow:\s*0 0 0 1px var\(--cursor-tag-ink\)/);
    expect(tokens).not.toMatch(/--glyph-active/);
    expect(tokens).toMatch(/--cursor-tag:\s*#0C0C0C;/);
    expect(tokens).toMatch(/--cursor-tag-ink:\s*#FFFFFF;/);
  });
});
