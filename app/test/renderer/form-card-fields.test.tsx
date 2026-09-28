// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { CardView } from "../../src/renderer/components/Cards";

// Defect 6 — the app has TWO form cards and only one of them was designed.
//
// components/FormCard.tsx (the SEC-04 page-fill form) draws its fields with `.field-input`: a 34px
// bar, an 8px radius, a --line-button border, the app's own font. Cards.tsx's CHAT-16 form card —
// the one that appears IN THE TRANSCRIPT, where it is seen most — rendered bare <input>, <textarea>
// and <select> with no class at all: Arial instead of --font, border-radius 0, native borders, a
// MEASURED 15.5px input height, a monospace textarea with a native resize grabber, and
// `appearance: auto` on the select. Same card kind, twice, once designed and once not.
//
// The fields now take the same `.field-input` the other card uses, with two element-scoped variants
// for the two elements a 34px single-line bar cannot describe. Those are separate selectors, not a
// second `.field-input` definition — duplicate-selectors.test.ts is the reason that matters.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const ruleBody = (sel: string) => stripComments(read("app.css")).match(new RegExp("(?:^|\\n)\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^{}]*)\\}"))?.[1] ?? null;

const entry = {
  kind: "send-message", id: "t1s3", requestId: "r", createdAt: 1,
  message: { type: "card", card: {
    kind: "form", title: "Where should I ship it?", status: "pending", submitLabel: "Send",
    fields: [
      { name: "addr", label: "Street address", kind: "text", required: true, value: "" },
      { name: "note", label: "Delivery note", kind: "textarea", required: false, value: "" },
      { name: "speed", label: "Shipping speed", kind: "select", required: true, value: "", options: ["Standard", "Express"] },
    ],
  } },
} as unknown as SendMessageEntry;

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async () => ({ ok: true, result: {} })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {} };
});
afterEach(cleanup);

describe("the transcript form card uses the app's fields, not the browser's", () => {
  it("every control in the card carries .field-input", () => {
    const { container } = render(<CardView botId="b" entry={entry} />);
    const controls = [...container.querySelectorAll("input, textarea, select")];
    expect(controls.length, "the card did not render its three fields").toBe(3);
    for (const el of controls) {
      expect(el.className, `<${el.tagName.toLowerCase()}> is still a raw browser control`).toContain("field-input");
    }
  });
});

describe("app.css describes the two elements a 34px single-line bar cannot", () => {
  it("textarea.field-input is its own selector with its own height and no native grabber", () => {
    const body = ruleBody("textarea.field-input");
    expect(body, "no textarea.field-input rule in app.css").not.toBeNull();
    expect(body!).toMatch(/min-height:\s*\d+px/);
    expect(body!, "the native resize grabber is the browser's design, not ours").toMatch(/resize:\s*none/);
    expect(body!, "a 34px bar cannot describe a textarea").toMatch(/height:\s*auto/);
  });

  it("select.field-input drops the native chrome and draws its own caret from a token", () => {
    const body = ruleBody("select.field-input");
    expect(body, "no select.field-input rule in app.css").not.toBeNull();
    expect(body!).toMatch(/appearance:\s*none/);
    expect(body!, "the caret colour must come from a token like everything else").toMatch(/var\(--ink-icon\)/);
  });

  it(".field-input itself still inherits the app font, which is what made the raw controls Arial", () => {
    expect(ruleBody(".field-input")!).toMatch(/font:\s*inherit/);
  });
});
