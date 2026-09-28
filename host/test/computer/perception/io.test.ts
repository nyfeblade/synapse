import { describe, expect, it } from "vitest";
import { deskFromHelper, parseActiveWindow, webFromCdp, type AxNode, type DomSnapshot } from "../../../computer/perception/io";

/** A tiny page: <h1>Sign in</h1> <label>Email<input></label> <input type=password> <button>Go</button> <div onclick>✕ Close</div> <canvas>. */
function page(): { ax: AxNode[]; snap: DomSnapshot } {
  const strings = ["#document", "HTML", "BODY", "H1", "#text", "Sign in", "INPUT", "type", "password", "BUTTON", "Go", "DIV", "Close", "CANVAS", "file", "SPAN", "inner"];
  // node indexes: 0 doc, 1 html, 2 body, 3 h1, 4 text "Sign in", 5 email input, 6 pw input, 7 button, 8 text "Go", 9 clickable div, 10 text "Close",
  // 11 canvas, 12 file input, 13 span inside button (clickable, must not be listed), 14 text "inner"
  const parentIndex = [-1, 0, 1, 2, 3, 2, 2, 2, 7, 2, 9, 2, 2, 7, 13];
  const nodeType = [9, 1, 1, 1, 3, 1, 1, 1, 3, 1, 3, 1, 1, 1, 3];
  const nodeName = [0, 1, 2, 3, 4, 6, 6, 9, 4, 11, 4, 13, 6, 15, 4];
  const nodeValue = [-1, -1, -1, -1, 5, -1, -1, -1, 10, -1, 12, -1, -1, -1, 16];
  const backendNodeId = [1, 2, 3, 10, 11, 20, 21, 30, 31, 40, 41, 50, 60, 70, 71];
  const attributes = [[], [], [], [], [], [], [7, 8], [], [], [], [], [], [7, 14], [], []];
  const layoutNodes = [3, 4, 5, 6, 7, 9, 11, 12, 13];
  const bounds = [[10, 110, 300, 40], [10, 110, 90, 40], [10, 170, 200, 24], [10, 210, 200, 24], [10, 250, 60, 30], [1200, 108, 6, 6], [10, 300, 400, 300], [10, 620, 120, 24], [12, 252, 20, 20]];
  const snap: DomSnapshot = {
    strings,
    documents: [{ scrollOffsetX: 0, scrollOffsetY: 100, nodes: { parentIndex, nodeType, nodeName, nodeValue, backendNodeId, attributes, isClickable: { index: [7, 9, 13] } }, layout: { nodeIndex: layoutNodes, bounds } }],
  };
  const p = (name: string, value: unknown) => ({ name, value: { value } });
  const ax: AxNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Login" }, childIds: ["2", "3", "4", "5", "6", "7", "8", "9"], backendDOMNodeId: 1 },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Sign in" }, childIds: ["2t"], backendDOMNodeId: 10 },
    { nodeId: "2t", parentId: "2", role: { value: "StaticText" }, name: { value: "Sign in" }, backendDOMNodeId: 11 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "bob@example.test" }, backendDOMNodeId: 20, properties: [p("focused", true), p("required", true)] },
    { nodeId: "4", parentId: "1", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "hunter2" }, backendDOMNodeId: 21 },
    { nodeId: "5", parentId: "1", role: { value: "button" }, name: { value: "Go" }, childIds: ["5t"], backendDOMNodeId: 30, properties: [p("disabled", true)] },
    { nodeId: "5t", parentId: "5", role: { value: "StaticText" }, name: { value: "Go" }, backendDOMNodeId: 31 },
    { nodeId: "6", parentId: "1", role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 40 },
    { nodeId: "7", parentId: "1", role: { value: "Canvas" }, name: { value: "" }, backendDOMNodeId: 50 },
    { nodeId: "8", parentId: "1", role: { value: "button" }, name: { value: "Choose File" }, backendDOMNodeId: 60 },
    { nodeId: "9", parentId: "1", role: { value: "link" }, name: { value: "Hidden" }, backendDOMNodeId: 99, ignored: true },
  ];
  return { ax, snap };
}

describe("perception io: Chromium over CDP", () => {
  it("builds elements in SCREEN coordinates with stable keys, states, redacted passwords, file inputs and unlabeled clickables", () => {
    const { ax, snap } = page();
    const r = webFromCdp({ targetId: "T1", ax, snap, info: { ox: 0, oy: 80, url: "http://127.0.0.1:8080/login", title: "Login", ready: "complete" }, win: { x: 0, y: 0, w: 1280, h: 800 } });
    expect(r.page).toEqual({ url: "http://127.0.0.1:8080/login", title: "Login", loading: false });
    expect(r.win).toMatchObject({ key: "web:T1", title: "Login", src: "web", active: true });
    const rows = r.els.map((e) => [e.key, e.role, e.name, e.value ?? null, e.states.join(","), `${e.b.x},${e.b.y},${e.b.w},${e.b.h}`]);
    expect(rows).toEqual([
      ["web:T1:10", "heading", "Sign in", null, "", "10,90,300,40"],
      ["web:T1:20", "textbox", "Email", "bob@example.test", "focused,required", "10,150,200,24"],
      ["web:T1:21", "textbox", "Password", "[redacted]", "", "10,190,200,24"],
      ["web:T1:30", "button", "Go", null, "disabled", "10,230,60,30"],
      ["web:T1:50", "canvas", "", null, "", "10,280,400,300"],
      ["web:T1:60", "fileinput", "Choose File", null, "", "10,600,120,24"],
      ["web:T1:40", "clickable", "Close", null, "", "1200,88,6,6"],
    ]);
    expect(r.els.every((e) => e.win === "web:T1")).toBe(true);
    expect(r.els.find((e) => e.key === "web:T1:20")!.ref).toBe(20);
  });

  it("a page still loading is marked loading", () => {
    const { ax, snap } = page();
    expect(webFromCdp({ targetId: "T1", ax, snap, info: { ox: 0, oy: 80, url: "u", title: "t", ready: "interactive" }, win: { x: 0, y: 0, w: 1280, h: 800 } }).page!.loading).toBe(true);
  });
});

describe("perception io: desktop over AT-SPI", () => {
  const helper = {
    windows: [
      { app: "mousepad", pid: 42, i: 0, title: "Untitled 1 - Mousepad", role: "frame", active: false, b: [0, 0, 1280, 800], els: [
        { k: "0.1", role: "menu item", name: "File", states: ["enabled", "sensitive", "expandable"], b: [0, 30, 40, 20] },
        { k: "0.3", role: "text", name: "", value: "hello", states: ["focused", "editable", "multi line", "enabled", "sensitive"], b: [0, 60, 1280, 700] },
      ] },
      { app: "mousepad", pid: 42, i: 1, title: "Save As", role: "file chooser", active: true, b: [200, 100, 800, 600], els: [
        { k: "1.0", role: "text", name: "Name", value: "Untitled 1", states: ["focused", "editable", "single line", "enabled", "sensitive"], b: [300, 130, 400, 30] },
        { k: "1.1", role: "push button", name: "Save", states: ["enabled", "sensitive"], b: [880, 640, 100, 34] },
        { k: "1.2", role: "push button", name: "Cancel", states: [], b: [760, 640, 100, 34] },
        { k: "1.3", role: "check box", name: "Show hidden", states: ["enabled", "sensitive", "checked"], b: [210, 640, 20, 20] },
      ] },
    ],
  };

  it("maps windows and elements, normalizes roles and states, and needs no screenshot when the tree is there", () => {
    const r = deskFromHelper(helper, { wid: "77", title: "Save As", cls: "Mousepad", b: { x: 200, y: 100, w: 800, h: 600 } });
    expect(r.windows.map((w) => [w.key, w.title, w.role, w.active])).toEqual([["d:mousepad:42:0", "Untitled 1 - Mousepad", "frame", false], ["d:mousepad:42:1", "Save As", "file chooser", true]]);
    expect(r.els.map((e) => [e.key, e.role, e.name, e.value ?? null, e.states.join(",")])).toEqual([
      ["d:mousepad:42:0.1", "menuitem", "File", null, "collapsed"],
      ["d:mousepad:42:0.3", "textbox", "", "hello", "focused,multiline"],
      ["d:mousepad:42:1.0", "textbox", "Name", "Untitled 1", "focused"],
      ["d:mousepad:42:1.1", "button", "Save", null, ""],
      ["d:mousepad:42:1.2", "button", "Cancel", null, "disabled"],
      ["d:mousepad:42:1.3", "checkbox", "Show hidden", null, "checked"],
    ]);
    expect(r.noA11y).toBeUndefined();
  });

  it("an active X window that AT-SPI does not know (or knows empty) is marked noA11y", () => {
    const r = deskFromHelper(helper, { wid: "99", title: "Print", cls: "Mousepad", b: { x: 300, y: 200, w: 500, h: 300 } });
    expect(r.noA11y).toEqual({ key: "x:99", title: "Print", role: "window", app: "Mousepad", active: true, b: { x: 300, y: 200, w: 500, h: 300 }, src: "desk" });
    expect(r.windows.filter((w) => w.active).map((w) => w.key)).toEqual(["x:99"]);
    const empty = deskFromHelper({ windows: [{ ...helper.windows[1]!, els: [] }] }, { wid: "77", title: "Save As", cls: "Mousepad", b: { x: 200, y: 100, w: 800, h: 600 } });
    expect(empty.noA11y?.title).toBe("Save As");
  });

  it("with no helper output at all (AT-SPI missing), the active window is noA11y", () => {
    const r = deskFromHelper(null, { wid: "5", title: "Thunar", cls: "Thunar", b: { x: 0, y: 0, w: 1280, h: 800 } });
    expect(r.noA11y?.key).toBe("x:5");
  });
});

describe("perception io: the active X window", () => {
  it("parses xdotool's chained getactivewindow/getwindowname/getwindowgeometry and xprop WM_CLASS", () => {
    const out = "Save As\nWINDOW=77\nX=200\nY=100\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n";
    expect(parseActiveWindow(out, 'WM_CLASS(STRING) = "mousepad", "Mousepad"\n')).toEqual({ wid: "77", title: "Save As", cls: "Mousepad", b: { x: 200, y: 100, w: 800, h: 600 } });
  });
});
