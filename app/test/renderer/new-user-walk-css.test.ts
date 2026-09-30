import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Layout rules from the new-user walk (2026-09-29). jsdom can't lay out, so the stylesheet is the contract.
const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const body = (sel: string) => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) if (m[1]!.split(",").some((s) => s.trim() === sel)) return m[2]!;
  return null;
};

describe("new-user walk: layout", () => {
  it("finding 1: the first-run prompts float as a top banner, not a flex column beside the sidebar", () => {
    const b = body(".key-prompts");
    expect(b, ".key-prompts needs its own positioning rule").toBeTruthy();
    expect(b).toMatch(/position:\s*fixed/);
    expect(b).toMatch(/top:\s*\d+px/);
    // Inside a covering surface the strip itself is fixed, so the banner goes back in the flow there.
    expect(body(".surface-announce .key-prompts")).toMatch(/position:\s*static/);
  });
});

describe("new-user walk: onboarding picks", () => {
  it("finding 19: a starter's app chips show their whole name", () => {
    expect(body(".starter-card .chip")).toMatch(/max-width:\s*none/);
  });
});

describe("new-user walk: the key step", () => {
  it("finding 17: the first-run key card has a fixed width", () => {
    expect(body(".account-panel.first-run")).toMatch(/width:\s*520px/);
  });
});

describe("new-user walk: the tools step", () => {
  it("finding 18: tool rows are borderless", () => {
    expect(body(".tool-cell")).toMatch(/border:\s*none/);
  });
});

describe("new-user walk: the chat column", () => {
  it("finding 23: the transcript and the composer keep a ~760px reading width, centred", () => {
    expect(body(".transcript")).toMatch(/padding-inline:\s*max\(var\(--chat-inset\),\s*calc\(\(100% - var\(--read-width\)\) \/ 2\)\)/);
    expect(body(".composer-wrap")).toMatch(/max\(var\(--chat-inset\),\s*calc\(\(100% - var\(--read-width\)\) \/ 2\)\)/);
    expect(css).toMatch(/--read-width:\s*760px/);
  });

  it("finding 24: under 1180px an opened details panel pushes the chat instead of covering it", () => {
    const narrow = /@media \(max-width: 1180px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).not.toMatch(/position:\s*absolute/);
  });
});

describe("review (taste): the approval card's command", () => {
  it("is plain monospace text, with no filled box around it", () => {
    const b = body(".card-command") ?? "";
    expect(b).not.toMatch(/background/);
    expect(b).not.toMatch(/border-radius/);
  });
});
