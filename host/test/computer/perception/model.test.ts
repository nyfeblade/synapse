import { describe, expect, it } from "vitest";
import { IdRegistry, clampBox, diffScreens, elLine, parseRegion, parseTarget, renderScreen, signature, withIds, type RawEl, type RawScreen, type Win } from "../../../computer/perception/model";

const win = (over: Partial<Win> = {}): Win => ({ key: "w1", title: "Login", role: "frame", app: "chromium", active: true, b: { x: 0, y: 0, w: 1280, h: 800 }, src: "web", ...over });
const el = (key: string, over: Partial<RawEl> = {}): RawEl => ({ key, role: "button", name: key, states: [], b: { x: 100, y: 100, w: 80, h: 30 }, win: "w1", ...over });
const raw = (els: RawEl[], over: Partial<RawScreen> = {}): RawScreen => ({ at: 1, windows: [win()], els, page: { url: "http://127.0.0.1:8080/login", title: "Login", loading: false }, ...over });

describe("perception model", () => {
  it("assigns stable ids: the same key keeps its id across reads, new keys get new ids", () => {
    const reg = new IdRegistry();
    const a = withIds(raw([el("save"), el("cancel")]), reg);
    const b = withIds(raw([el("cancel"), el("new"), el("save")]), reg);
    expect(a.els.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(Object.fromEntries(b.els.map((e) => [e.key, e.id]))).toEqual({ cancel: "e2", new: "e3", save: "e1" });
  });

  it("renders one compact line per element with states, tiny and offscreen marks, never coordinates", () => {
    const reg = new IdRegistry();
    const s = withIds(raw([
      el("email", { role: "textbox", name: "Email", value: "bob@example.test", states: ["focused", "required"] }),
      el("x", { role: "button", name: "Close", b: { x: 5, y: 5, w: 8, h: 8 } }),
      el("more", { role: "link", name: "More", b: { x: 10, y: 1400, w: 40, h: 12 } }),
    ]), reg);
    expect(renderScreen(s, { maxLines: 50 })).toBe([
      '# page "Login" http://127.0.0.1:8080/login [active]',
      'e1 textbox "Email" ="bob@example.test" focused,required',
      'e2 button "Close" tiny',
      'e3 link "More" offscreen',
    ].join("\n"));
    expect(s.focus).toBe("e1");
  });

  it("lists background windows as headers only, popups first, and caps the element lines", () => {
    const reg = new IdRegistry();
    const s = withIds(raw(
      [el("a"), el("b"), el("c"), el("m1", { win: "menu", role: "menuitem", name: "Rename" }), el("bg", { win: "w2" })],
      { windows: [win(), win({ key: "w2", title: "Files", active: false, src: "desk", app: "thunar" }), win({ key: "menu", title: "", app: "thunar", role: "menu", active: false, popup: true, src: "desk" })] },
    ), reg);
    const out = renderScreen(s, { maxLines: 3 }).split("\n");
    expect(out[0]).toBe('# window "thunar" [menu,popup]');
    expect(out[1]).toBe('e4 menuitem "Rename"');
    expect(out).toContain('# window "Files"');
    expect(out.some((l) => l.includes('"bg"'))).toBe(false);
    expect(out.at(-1)).toBe("… 1 more; Look with a query to narrow it");
  });

  it("diffs: appeared, gone, value/state change, focus, page loaded, dialog and error text marked important", () => {
    const reg = new IdRegistry();
    const a = withIds(raw([el("email", { role: "textbox", name: "Email", states: ["focused"] }), el("go", { name: "Sign in" })], { page: { url: "http://h/login", title: "Login", loading: true } }), reg);
    const b = withIds(raw([
      el("email", { role: "textbox", name: "Email", value: "bob" }),
      el("err", { role: "text", name: "Invalid password" }),
      el("dlg", { role: "dialog", name: "Cookies" }),
      el("ok", { name: "Accept all", states: ["focused"] }),
    ], { page: { url: "http://h/login", title: "Login", loading: false } }), reg);
    const d = diffScreens(a, b, { maxAdded: 10, maxRemoved: 10 });
    expect(d.lines).toEqual([
      'page loaded: "Login" http://h/login',
      '! error text: "Invalid password"',
      '+ dialog "Cookies" appeared (e4)',
      '+ e3 text "Invalid password"',
      '+ e5 button "Accept all" focused',
      '- e2 button "Sign in"',
      '~ e1 textbox "Email": value "" → "bob"',
      'focus → e5 button "Accept all"',
    ]);
    expect(d.important).toEqual(['page loaded: "Login" http://h/login', '! error text: "Invalid password"', '+ dialog "Cookies" appeared (e4)']);
  });

  it("a new desktop dialog window is important; an unchanged screen diffs to nothing", () => {
    const reg = new IdRegistry();
    const base = raw([el("a")], { windows: [win({ src: "desk", title: "Untitled - Mousepad" })], page: undefined });
    const a = withIds(base, reg);
    const b = withIds({ ...base, windows: [...base.windows.map((w) => ({ ...w, active: false })), win({ key: "w9", title: "Save As", role: "dialog", src: "desk" })] }, reg);
    expect(diffScreens(a, b, { maxAdded: 5, maxRemoved: 5 }).important).toEqual(['+ dialog "Save As" opened']);
    expect(diffScreens(a, withIds(base, reg), { maxAdded: 5, maxRemoved: 5 })).toEqual({ lines: [], important: [], changed: false });
  });

  it("caps added and removed lists", () => {
    const reg = new IdRegistry();
    const a = withIds(raw(Array.from({ length: 5 }, (_, i) => el(`old${i}`))), reg);
    const b = withIds(raw(Array.from({ length: 5 }, (_, i) => el(`new${i}`))), reg);
    const d = diffScreens(a, b, { maxAdded: 2, maxRemoved: 1 });
    expect(d.lines.filter((l) => l.startsWith("+"))).toHaveLength(3);
    expect(d.lines).toContain("+ … 3 more new elements; Look to see them");
    expect(d.lines).toContain("- … 4 more gone");
  });

  it("the signature ignores sub-4px jitter but sees text, state and structure changes", () => {
    const s1 = raw([el("a")]);
    expect(signature(raw([el("a", { b: { x: 101, y: 100, w: 80, h: 30 } })]))).toBe(signature(s1));
    expect(signature(raw([el("a", { name: "b" })]))).not.toBe(signature(s1));
    expect(signature(raw([el("a", { states: ["checked"] })]))).not.toBe(signature(s1));
    expect(signature(raw([el("a")], { page: { url: "http://h/login", title: "Login", loading: true } }))).not.toBe(signature(s1));
  });

  it("parses targets and regions", () => {
    expect(parseTarget("e12")).toEqual({ id: "e12" });
    expect(parseTarget(" 640, 400 ")).toEqual({ x: 640, y: 400 });
    expect(parseTarget("Save")).toBeNull();
    expect(parseRegion("10,20,300,200")).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(parseRegion("1200,700,300,300")).toEqual({ x: 1200, y: 700, w: 80, h: 100 });
    expect(parseRegion("nope")).toBeNull();
    expect(clampBox({ x: -50, y: 10, w: 100, h: 20 })).toEqual({ x: 0, y: 10, w: 50, h: 20 });
  });

  it("elLine hides a value equal to the name", () => {
    const [e] = withIds(raw([el("s", { role: "combobox", name: "Blue", value: "Blue" })]), new IdRegistry()).els;
    expect(elLine(e!)).toBe('e1 combobox "Blue"');
  });
});
