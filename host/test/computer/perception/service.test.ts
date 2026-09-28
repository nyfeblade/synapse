import { describe, expect, it } from "vitest";
import type { Box, RawEl, RawScreen, Win } from "../../../computer/perception/model";
import { PerceptionService, type PerceptionIO } from "../../../computer/perception/service";

const W: Win = { key: "web:t1", title: "Shop", role: "frame", app: "chromium", active: true, b: { x: 0, y: 0, w: 1280, h: 800 }, src: "web" };
const D: Win = { key: "d:mousepad:1", title: "Untitled - Mousepad", role: "frame", app: "mousepad", active: true, b: { x: 0, y: 0, w: 1280, h: 800 }, src: "desk" };
const el = (key: string, over: Partial<RawEl> = {}): RawEl => ({ key, role: "button", name: key, states: [], b: { x: 100, y: 100, w: 80, h: 30 }, win: W.key, ...over });
const scr = (els: RawEl[], over: Partial<RawScreen> = {}): RawScreen => ({ at: 0, windows: [W], els, page: { url: "http://127.0.0.1:8080/", title: "Shop", loading: false }, ...over });

function fakeIo(reads: RawScreen[], o: { web?: Partial<NonNullable<PerceptionIO["web"]>> } = {}) {
  const log: string[] = [];
  let i = 0;
  let t = 0;
  const io: PerceptionIO = {
    read: async () => { const s = reads[Math.min(i, reads.length - 1)]!; i += 1; return s; },
    xdotool: async (a) => { log.push(a.join(" ")); },
    sleep: async (ms) => { t += ms; },
    now: () => t,
    crop: {
      rgb: async (b: Box) => { log.push(`rgb ${b.x},${b.y},${b.w},${b.h}`); const buf = Buffer.alloc(b.w * b.h * 3, 255); for (let y = 20; y < 60; y++) for (let x = 40; x < 80; x++) buf.set([230, 20, 20], (y * b.w + x) * 3); return buf; },
      webp: async (b: Box) => { log.push(`webp ${b.x},${b.y},${b.w},${b.h}`); return Buffer.from("RIFF0000WEBP"); },
      ocr: async (b: Box) => { log.push(`ocr ${b.x},${b.y},${b.w},${b.h}`); return ["Sales by month", "Total 27.5M"]; },
    },
    web: {
      scrollIntoView: async (ref) => { log.push(`scroll-into-view ${ref}`); },
      coveredBy: async () => null,
      fileInput: async () => false,
      setFiles: async (ref, files) => { log.push(`set-files ${ref} ${files.join(",")}`); return true; },
      ...o.web,
    },
  };
  return { io, log, reads: () => i };
}
const svc = (io: PerceptionIO) => new PerceptionService({ io, watchMs: 0 });

describe("PerceptionService: Look", () => {
  it("returns the compact view, and important changes that happened between calls", async () => {
    const f = fakeIo([scr([el("buy", { name: "Buy" })]), scr([el("buy", { name: "Buy" }), el("dlg", { role: "dialog", name: "Cookies" })])]);
    const s = svc(f.io);
    expect((await s.look()).text).toBe('# page "Shop" http://127.0.0.1:8080/ [active]\ne1 button "Buy"');
    const r = await s.look();
    expect(r.text.split("\n")[0]).toBe('since your last call: + dialog "Cookies" appeared (e2)');
    expect(r.images).toBeUndefined();
  });

  it("a window with no accessibility info gets a cropped screenshot automatically, and says so", async () => {
    const dlg: Win = { key: "x:77", title: "Open File", role: "dialog", app: "chromium", active: true, b: { x: 340, y: 150, w: 600, h: 450 }, src: "desk" };
    const f = fakeIo([scr([], { windows: [{ ...W, active: false }, dlg], noA11y: dlg })]);
    const r = await svc(f.io).look();
    expect(r.text).toContain("(this window exposes no accessibility info");
    expect(r.text).toContain('Window "Open File" exposes no accessibility info: attached a cropped screenshot (600×450 at 340,150).');
    expect(r.images).toHaveLength(1);
    expect(f.log).toContain("webp 340,150,600,450");
  });

  it("answers a colour query from local blob analysis, with the nearest element and a point to act on", async () => {
    const f = fakeIo([scr([el("board", { role: "canvas", name: "", b: { x: 0, y: 0, w: 1280, h: 800 } })])]);
    const r = await svc(f.io).look("click the red square");
    expect(f.log).toContain("rgb 0,0,1280,800");
    expect(r.text).toBe("red: 40×40 at 40,20 (centre 60,40) in e1 canvas");
    expect(r.images).toBeUndefined();
  });

  it("answers a chart question with OCR of the largest canvas/image only (cropped)", async () => {
    const f = fakeIo([scr([el("c", { role: "canvas", name: "", b: { x: 200, y: 150, w: 600, h: 400 } }), el("logo", { role: "image", name: "Logo", b: { x: 0, y: 0, w: 40, h: 40 } })])]);
    const r = await svc(f.io).look("what does the chart say about the total");
    expect(f.log).toEqual(["ocr 200,150,600,400"]);
    expect(r.text).toBe('text in e1 canvas: "Total 27.5M" · "Sales by month"');
  });

  it("an element-scoped query OCRs that element's box", async () => {
    const f = fakeIo([scr([el("p", { role: "image", name: "", b: { x: 10, y: 20, w: 100, h: 50 } })])]);
    await svc(f.io).look("read the text in e1");
    expect(f.log).toEqual(["ocr 10,20,100,50"]);
  });

  it("a query that names elements is answered from the model, with no OCR", async () => {
    const f = fakeIo([scr([el("a", { role: "cell", name: "Invoice 7731" }), el("b", { role: "cell", name: "$1,204.00", b: { x: 100, y: 140, w: 80, h: 30 } }), el("c", { role: "link", name: "Help" })])]);
    const r = await svc(f.io).look("invoice 7731");
    expect(r.text).toBe('e1 cell "Invoice 7731"');
    expect(f.log).toEqual([]);
  });

  it("a query that matches a table cell also returns the rest of that row (table lookups)", async () => {
    const row = (y: number) => ({ x: 0, y, w: 100, h: 20 });
    const f = fakeIo([scr([
      el("h1", { role: "columnheader", name: "Invoice", b: row(80) }), el("h2", { role: "columnheader", name: "Amount", b: { ...row(80), x: 200 } }),
      el("a1", { role: "cell", name: "7730", b: row(100) }), el("a2", { role: "cell", name: "$88.10", b: { ...row(100), x: 200 } }),
      el("b1", { role: "cell", name: "7731", b: row(120) }), el("b2", { role: "cell", name: "$1,204.00", b: { ...row(120), x: 200 } }),
    ])]);
    const r = await svc(f.io).look("amount for invoice 7731");
    expect(r.text).toBe('e5 cell "7731" | e6 cell "$1,204.00"\ne1 columnheader "Invoice" | e2 columnheader "Amount"');
  });
});

describe("PerceptionService: watch timer", () => {
  it("polls on its own between calls, remembers important changes with their age, and stops when idle", async () => {
    const base = scr([el("a", { name: "Go" })]);
    const modal = scr([el("a", { name: "Go" }), el("m", { role: "alertdialog", name: "Session expiring" })]);
    const f = fakeIo([base, modal, modal]);
    const s = new PerceptionService({ io: f.io, watchMs: 0, watchIdleMs: 60_000 });
    await s.look();
    await s.watchTick();
    await f.io.sleep(3_000);
    const r = await s.look();
    expect(r.text.split("\n")[0]).toBe('since your last call: + dialog "Session expiring" appeared (e2) (3 s ago)');
    await f.io.sleep(61_000);
    await s.watchTick();
    expect(f.reads()).toBe(3); // idle: the tick stopped instead of reading
  });
});

describe("PerceptionService: Act", () => {
  it("clicks an element by id at its exact centre with real xdotool input, then returns only the diff and 'settled'", async () => {
    const before = scr([el("buy", { name: "Buy" })]);
    const after = scr([el("buy", { name: "Buy" }), el("ok", { role: "text", name: "Added to cart" })]);
    const f = fakeIo([before, before, after, after, after, after]);
    const s = svc(f.io);
    await s.look();
    const r = await s.act({ do: "click", on: "e1" });
    expect(f.log).toEqual(["mousemove --sync 140 115", "click --repeat 1 --delay 80 1"]);
    expect(r.text).toBe('+ e2 text "Added to cart"\nsettled');
    expect(r.isError).toBeUndefined();
  });

  it("tiny targets are hit at their exact centre", async () => {
    const f = fakeIo([scr([el("x", { name: "Close", b: { x: 5, y: 5, w: 8, h: 8 } })])]);
    const s = svc(f.io);
    await s.look();
    await s.act({ do: "click", on: "e1" });
    expect(f.log[0]).toBe("mousemove --sync 9 9");
  });

  it("right click, double click and hover; a hover that opens a nested menu shows the new items", async () => {
    const base = scr([el("file", { role: "menuitem", name: "File" })]);
    const open = scr([el("file", { role: "menuitem", name: "File", states: ["expanded"] }), el("recent", { role: "menuitem", name: "Open Recent" })]);
    const f = fakeIo([base, base, open, open, open, open, open, open, open, open]);
    const s = svc(f.io);
    await s.look();
    const r = await s.act({ do: "hover", on: "e1" });
    expect(f.log).toEqual(["mousemove --sync 140 115"]);
    expect(r.text).toContain('+ e2 menuitem "Open Recent"');
    expect(r.text).toContain('~ e1 menuitem "File": now expanded');
    f.log.length = 0;
    await s.act({ do: "right", on: "e2" });
    await s.act({ do: "double", on: "640,400" });
    expect(f.log).toEqual(["mousemove --sync 140 115", "click --repeat 1 --delay 80 3", "mousemove --sync 640 400", "click --repeat 2 --delay 80 1"]);
  });

  it("an unknown or vanished id is an error that does not touch the mouse", async () => {
    const f = fakeIo([scr([el("a")]), scr([])]);
    const s = svc(f.io);
    await s.look();
    const gone = await s.act({ do: "click", on: "e1" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toBe('e1 (button "a") is no longer on screen. Look again.');
    const unknown = await s.act({ do: "click", on: "e99" });
    expect(unknown.text).toBe("Unknown element e99. Use an id from Look.");
    expect(f.log).toEqual([]);
  });

  it("refuses to click a web element covered by a modal or banner, and says what covers it", async () => {
    const f = fakeIo([scr([el("buy", { ref: 42 })])], { web: { coveredBy: async () => 'dialog "Cookies": Accept all' } });
    const s = svc(f.io);
    const r = await s.act({ do: "click", on: "e1" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('e1 is covered by dialog "Cookies": Accept all. Deal with that first.');
    expect(f.log).toEqual([]);
  });

  it("scrolls an off-screen web element into view first, then clicks its new position", async () => {
    const off = scr([el("more", { ref: 9, name: "More", b: { x: 100, y: 1500, w: 80, h: 30 } })]);
    const on = scr([el("more", { ref: 9, name: "More", b: { x: 100, y: 400, w: 80, h: 30 } })]);
    const f = fakeIo([off, on, on, on, on, on]);
    const s = svc(f.io);
    await s.act({ do: "click", on: "e1" });
    expect(f.log.slice(0, 2)).toEqual(["scroll-into-view 9", "mousemove --sync 140 415"]);
  });

  it("types into a filled single-line field by replacing its text", async () => {
    const f = fakeIo([scr([el("email", { role: "textbox", name: "Email", value: "old" })])]);
    const s = svc(f.io);
    await s.act({ do: "type", on: "e1", text: "bob@example.test" });
    expect(f.log).toEqual(["mousemove --sync 140 115", "click --repeat 1 --delay 80 1", "key --clearmodifiers -- ctrl+a", "type --delay 12 -- bob@example.test"]);
  });

  it("types into a multi-line editor without clearing it, and key sends xdotool key names", async () => {
    const f = fakeIo([scr([el("doc", { role: "text", name: "", value: "hello", states: ["multiline", "focused"] })])]);
    const s = svc(f.io);
    await s.act({ do: "type", on: "e1", text: " world" });
    await s.act({ do: "key", text: "ctrl+shift+s" });
    expect(f.log).toEqual(["type --delay 12 --  world", "key --clearmodifiers -- ctrl+shift+s"]);
  });

  it("select opens the list and clicks the option by name", async () => {
    const closed = scr([el("size", { role: "combobox", name: "Size", value: "S" })]);
    const opened = scr([el("size", { role: "combobox", name: "Size", value: "S", states: ["expanded"] }), el("m", { role: "option", name: "Medium", b: { x: 100, y: 200, w: 80, h: 20 } })]);
    const chosen = scr([el("size", { role: "combobox", name: "Size", value: "Medium" })]);
    const f = fakeIo([closed, closed, opened, opened, opened, chosen, chosen, chosen, chosen, chosen]);
    const s = svc(f.io);
    await s.look();
    const r = await s.act({ do: "select", on: "e1", text: "medium" });
    expect(f.log).toEqual(["mousemove --sync 140 115", "click --repeat 1 --delay 80 1", "mousemove --sync 140 210", "click --repeat 1 --delay 80 1"]);
    expect(r.text).toContain('~ e1 combobox "Size": value "S" → "Medium"');
  });

  it("select falls back to type-ahead + Return when the options are not in the tree (a native <select> popup)", async () => {
    const closed = scr([el("size", { role: "combobox", name: "Size", value: "S" })]);
    const f = fakeIo([closed]);
    await svc(f.io).act({ do: "select", on: "e1", text: "Large" });
    expect(f.log).toEqual(["mousemove --sync 140 115", "click --repeat 1 --delay 80 1", "type --delay 12 -- Large", "key --clearmodifiers -- Return"]);
  });

  it("drags by ids with real pointer steps (mousedown, intermediate moves, mouseup)", async () => {
    const f = fakeIo([scr([el("card", { b: { x: 100, y: 100, w: 100, h: 40 } }), el("done", { role: "region", name: "Done", b: { x: 700, y: 100, w: 200, h: 400 } })])]);
    await svc(f.io).act({ do: "drag", on: "e1", to: "e2" });
    expect(f.log[0]).toBe("mousemove --sync 150 120");
    expect(f.log[1]).toBe("mousedown 1");
    expect(f.log.filter((l) => l.startsWith("mousemove")).length).toBeGreaterThanOrEqual(6);
    expect(f.log.at(-2)).toBe("mousemove --sync 800 300");
    expect(f.log.at(-1)).toBe("mouseup 1");
  });

  it("scroll moves the pointer over the target and wheels N notches", async () => {
    const f = fakeIo([scr([el("list", { role: "list", name: "Results", b: { x: 0, y: 100, w: 400, h: 600 } })])]);
    await svc(f.io).act({ do: "scroll", on: "e1", text: "down 4" });
    expect(f.log).toEqual(["mousemove --sync 200 400", "click --repeat 4 --delay 40 5"]);
  });

  it("uploads to a web file input through the page (no native chooser), and hints when a click would open one", async () => {
    const f = fakeIo([scr([el("file", { ref: 5, name: "Choose File" })])], { web: { fileInput: async () => true } });
    const s = svc(f.io);
    const r = await s.act({ do: "upload", on: "e1", text: "/workspace/cv.pdf" });
    expect(f.log).toEqual(["set-files 5 /workspace/cv.pdf"]);
    expect(r.isError).toBeUndefined();
    const c = await s.act({ do: "click", on: "e1" });
    expect(c.text).toContain('e1 opens a file chooser: use do "upload" on e1 with text = the file path.');
  });

  it("uploads through a native file chooser window by typing the path", async () => {
    const chooser: Win = { key: "d:mousepad:2", title: "Save As", role: "file chooser", app: "mousepad", active: true, b: { x: 200, y: 100, w: 800, h: 600 }, src: "desk" };
    const f = fakeIo([scr([], { windows: [{ ...D, active: false }, chooser], page: undefined })]);
    await svc(f.io).act({ do: "upload", text: "/workspace/notes/today.txt" });
    expect(f.log).toEqual(["key --clearmodifiers -- ctrl+l", "type --delay 12 -- /workspace/notes/today.txt", "key --clearmodifiers -- Return"]);
  });

  it("when an act opens a window with no accessibility info, the diff attaches a cropped screenshot and says so", async () => {
    const dlg: Win = { key: "x:9", title: "Print", role: "dialog", app: "mousepad", active: true, b: { x: 300, y: 200, w: 500, h: 300 }, src: "desk" };
    const before = scr([el("p", { win: D.key, name: "Print" })], { windows: [D], page: undefined });
    const after = scr([el("p", { win: D.key, name: "Print" })], { windows: [{ ...D, active: false }, dlg], noA11y: dlg, page: undefined });
    const f = fakeIo([before, after, after, after, after]);
    const r = await svc(f.io).act({ do: "click", on: "e1" });
    expect(r.text).toContain('+ dialog "Print" opened');
    expect(r.text).toContain('Window "Print" exposes no accessibility info: attached a cropped screenshot (500×300 at 300,200).');
    expect(r.images).toHaveLength(1);
  });

  it("waits locally and reports 'still changing' when the screen never settles", async () => {
    let n = 0;
    const f = fakeIo([]);
    f.io.read = async () => scr([el(`spinner${n++}`)]);
    const r = await svc(f.io).act({ do: "key", text: "F5" });
    expect(r.text.split("\n").at(-1)).toBe("still changing after 5 s (Look again to see where it ends)");
  });

  it("an unchanged screen says so", async () => {
    const f = fakeIo([scr([el("a")])]);
    const r = await svc(f.io).act({ do: "key", text: "shift" });
    expect(r.text).toBe("no visible change\nsettled");
  });

  it("validates input before touching anything", async () => {
    const f = fakeIo([scr([el("a")])]);
    const s = svc(f.io);
    expect((await s.act({ do: "click" })).text).toBe('click needs on: an element id from Look (e.g. e12) or "x,y".');
    expect((await s.act({ do: "type", on: "e1" })).text).toBe("type needs text.");
    expect((await s.act({ do: "drag", on: "e1" })).text).toBe("drag needs to: an element id or \"x,y\".");
    expect((await s.act({ do: "click", on: "2000,10" })).text).toBe("Points must be inside the 1280×800 screen.");
    expect(f.log).toEqual([]);
  });
});

describe("PerceptionService: Screenshot", () => {
  it("crops to a region or an element, and returns the full screen with no region", async () => {
    const f = fakeIo([scr([el("c", { role: "canvas", name: "", b: { x: 200, y: 150, w: 600, h: 400 } })])]);
    const s = svc(f.io);
    expect((await s.screenshot("10,20,300,200")).images).toHaveLength(1);
    await s.screenshot("e1");
    await s.screenshot();
    expect(f.log).toEqual(["webp 10,20,300,200", "webp 200,150,600,400", "webp 0,0,1280,800"]);
    expect((await s.screenshot("bogus")).isError).toBe(true);
  });
});
