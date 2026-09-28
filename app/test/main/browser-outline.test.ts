import { describe, expect, it } from "vitest";
import { OUTLINE_MAX_CHARS, diffOutline, estTokens, lineOf, pruneNodes, renderOutline, type PageNode, type PageState } from "../../src/main/browser/outline";

const n = (ref: string, role: string, name: string, o: Partial<PageNode> = {}): PageNode => ({ ref, role, name, depth: 0, y: 100, h: 20, interactive: ["button", "link", "textbox", "checkbox", "combobox", "searchbox", "radio"].includes(role), ...o });
const page = (nodes: PageNode[], o: Partial<PageState> = {}): PageState => ({ url: "http://127.0.0.1/a", title: "A", doc: "d1", vh: 800, nodes, ...o });

describe("outline lines", () => {
  it("renders interactive nodes with their ref and plain text without one", () => {
    expect(lineOf(n("e12", "button", "Sign in"))).toBe('[e12] button "Sign in"');
    expect(lineOf(n("e31", "textbox", "Email", { value: "a@b.c" }))).toBe('[e31] textbox "Email" value="a@b.c"');
    expect(lineOf(n("e4", "text", "Hello world"))).toBe('"Hello world"');
    expect(lineOf(n("e5", "heading", "Results", { level: 2 }))).toBe('h2 "Results"');
    expect(lineOf(n("e6", "checkbox", "Remember me", { checked: true }))).toBe('[e6] checkbox "Remember me" checked');
    expect(lineOf(n("e7", "button", "Go", { disabled: true, depth: 2 }))).toBe('    [e7] button "Go" disabled');
  });

  it("never renders a password or card field's value", () => {
    expect(lineOf(n("e9", "textbox", "Password", { value: "hunter2", sensitive: "password" }))).toBe('[e9] textbox "Password" value="•••" (password)');
    expect(lineOf(n("e10", "textbox", "Card number", { value: "", sensitive: "card" }))).toBe('[e10] textbox "Card number" (card)');
  });
});

describe("pruning", () => {
  it("drops decorative nodes (nameless images, nameless generic text), repeated text and text echoing the next link", () => {
    const kept = pruneNodes(page([
      n("e1", "img", ""), n("e2", "text", "   "), n("e3", "text", "Docs"), n("e4", "link", "Docs"),
      n("e5", "text", "Same"), n("e6", "text", "Same"), n("e7", "button", ""),
    ])).nodes.map((x) => x.ref);
    // a nameless button is still actionable, so it stays
    expect(kept).toEqual(["e4", "e5", "e7"]);
  });

  it("drops nodes far off-screen and says how many are below", () => {
    const r = pruneNodes(page([n("e1", "link", "Top", { y: 10 }), n("e2", "link", "Near", { y: 1500 }), n("e3", "link", "Far", { y: 5000 }), n("e4", "link", "Farther", { y: 9000 })]));
    expect(r.nodes.map((x) => x.ref)).toEqual(["e1", "e2"]);
    expect(r.below).toBe(2);
    const text = renderOutline(page([n("e1", "link", "Top", { y: 10 }), n("e3", "link", "Far", { y: 5000 })])).text;
    expect(text).toContain("1 more below");
  });
});

describe("size cap and paging", () => {
  it("caps one outline at ~4k tokens and pages the rest with 'more'", () => {
    const many = Array.from({ length: 900 }, (_, i) => n(`e${i + 1}`, "link", `Result number ${i + 1} with a longish title`, { y: 50 + (i % 30) }));
    const r = renderOutline(page(many));
    expect(r.text.length).toBeLessThanOrEqual(OUTLINE_MAX_CHARS + 200);
    expect(estTokens(r.text)).toBeLessThanOrEqual(4_200);
    expect(r.rest.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/action "more"/);
    const all = [r.text, ...r.rest].join("\n");
    expect(all).toContain("[e1] link");
    expect(all).toContain("[e900] link");
  });

  it("puts the URL and title on top of every outline", () => {
    const t = renderOutline(page([n("e1", "button", "Go")], { url: "http://x.test/p", title: "Shop" })).text;
    expect(t.split("\n")[0]).toBe("Page: Shop — http://x.test/p");
  });
});

describe("diffs after an action", () => {
  it("returns only what changed, with the URL and title", () => {
    const before = page([n("e1", "textbox", "Email", { value: "" }), n("e2", "button", "Next"), n("e3", "text", "Welcome")]);
    const after = page([n("e1", "textbox", "Email", { value: "a@b.c" }), n("e3", "text", "Welcome"), n("e4", "alert", "Saved")]);
    const d = diffOutline(before, after);
    expect(d.split("\n")[0]).toBe("Page: A — http://127.0.0.1/a");
    expect(d).toContain('~ [e1] textbox "Email" value="a@b.c"');
    expect(d).toContain('+ alert "Saved"');
    expect(d).toContain('- [e2] button "Next"');
    expect(d).not.toContain("Welcome");
  });

  it("says so when nothing visible changed", () => {
    const p = page([n("e1", "button", "Go")]);
    expect(diffOutline(p, p)).toContain("No visible change.");
  });

  it("returns the new page's outline after a navigation", () => {
    const d = diffOutline(page([n("e1", "button", "Go")]), page([n("e2", "heading", "Thanks", { level: 1 })], { doc: "d2", url: "http://127.0.0.1/b", title: "B" }));
    expect(d).toContain("(new page)");
    expect(d).toContain('h1 "Thanks"');
  });

  it("is never longer than the full outline", () => {
    const before = page(Array.from({ length: 50 }, (_, i) => n(`e${i + 1}`, "link", `Old ${i}`)));
    const after = page(Array.from({ length: 50 }, (_, i) => n(`e${i + 100}`, "link", `New ${i}`)));
    const d = diffOutline(before, after);
    expect(d.length).toBeLessThanOrEqual(renderOutline(after).text.length + 40);
  });

  it("is much smaller than the page for a one-field change", () => {
    const base = Array.from({ length: 200 }, (_, i) => n(`e${i + 1}`, "link", `Item ${i + 1} of the catalogue`, { y: 20 + i }));
    const before = page([...base, n("e999", "textbox", "Qty", { value: "1" })]);
    const after = page([...base, n("e999", "textbox", "Qty", { value: "2" })]);
    expect(diffOutline(before, after).length * 10).toBeLessThan(renderOutline(after).text.length);
  });
});

describe("found on the fixture site", () => {
  it("drops a heading that only repeats the link inside it", () => {
    const kept = pruneNodes(page([n("e1", "heading", "Story A", { level: 3 }), n("e2", "link", "Story A"), n("e3", "heading", "Section", { level: 2 })])).nodes.map((x) => x.ref);
    expect(kept).toEqual(["e2", "e3"]);
  });

  it("collapses a navigation block already shown on an earlier page of this window", () => {
    const nav = (base: number) => [n(`e${base}`, "navigation", "Footer"), ...["Terms", "Privacy", "Cookies", "Help"].map((x, i) => n(`e${base + 1 + i}`, "link", x, { depth: 1 }))];
    const seen = new Set<string>();
    const first = renderOutline(page(nav(10)), { seenNavs: seen }).text;
    expect(first).toContain('[e11] link "Terms"');
    const second = renderOutline(page([...nav(40), n("e50", "button", "Buy")], { doc: "d2" }), { seenNavs: seen }).text;
    expect(second).toContain('navigation "Footer": the same 4 links as before, now e41–e44 in the same order');
    expect(second).not.toContain('link "Terms"');
    expect(second).toContain('[e50] button "Buy"');
    // a changed navigation is listed in full
    const changed = [n("e60", "navigation", "Footer"), ...["Terms", "Jobs"].map((x, i) => n(`e${61 + i}`, "link", x, { depth: 1 }))];
    expect(renderOutline(page(changed, { doc: "d3" }), { seenNavs: seen }).text).toContain('[e62] link "Jobs"');
  });
});
