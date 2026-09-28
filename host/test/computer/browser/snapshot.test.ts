import { describe, expect, it } from "vitest";
import { renderSnapshot, type AXNode } from "../../../computer/browser/snapshot";

const n = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AXNode> = {}): AXNode =>
  ({ nodeId, role: { value: role }, name: { value: name }, childIds, backendDOMNodeId: Number(nodeId) * 10, ...extra });

describe("renderSnapshot (BRW-04)", () => {
  it("renders roles, names and [ref=eN]; hoists ignored/generic wrappers; maps refs to backend node ids", () => {
    const nodes = [
      n("1", "RootWebArea", "Sign in · Northwind", ["2"]),
      n("2", "generic", "", ["3", "4", "5"]),
      n("3", "heading", "Sign in", []),
      n("4", "textbox", "Email", [], { value: { value: "you@example.com" } }),
      n("5", "button", "Continue", []),
    ];
    const r = renderSnapshot(nodes, { maxNodes: 400, maxDepth: 20, passwordIds: new Set() });
    expect(r.text).toBe([
      '- RootWebArea "Sign in · Northwind" [ref=e1]',
      '  - heading "Sign in" [ref=e2]',
      '  - textbox "Email" value="you@example.com" [ref=e3]',
      '  - button "Continue" [ref=e4]',
    ].join("\n"));
    expect(r.refs.get("e3")).toBe(40);
    expect(r.truncated).toBe(false);
  });

  it("redacts password values", () => {
    const nodes = [n("1", "RootWebArea", "x", ["2"]), n("2", "textbox", "Password", [], { value: { value: "hunter2" } })];
    const r = renderSnapshot(nodes, { maxNodes: 400, maxDepth: 20, passwordIds: new Set([20]) });
    expect(r.text).toContain('textbox "Password" value="[redacted]"');
    expect(r.text).not.toContain("hunter2");
  });

  it("stops at 400 nodes and depth 20, and says so", () => {
    const many = [n("1", "RootWebArea", "big", Array.from({ length: 500 }, (_, i) => String(i + 2))), ...Array.from({ length: 500 }, (_, i) => n(String(i + 2), "link", `L${i}`))];
    const r = renderSnapshot(many, { maxNodes: 400, maxDepth: 20, passwordIds: new Set() });
    expect(r.nodes).toBe(400);
    expect(r.truncated).toBe(true);
    expect(r.text.split("\n").at(-1)).toBe("… (snapshot truncated at 400 nodes; scroll or navigate to see more)");
    const deep: AXNode[] = Array.from({ length: 30 }, (_, i) => n(String(i + 1), "group", `g${i}`, i < 29 ? [String(i + 2)] : []));
    expect(renderSnapshot(deep, { maxNodes: 400, maxDepth: 20, passwordIds: new Set() }).text.split("\n").filter((l) => l.includes("group"))).toHaveLength(21);
  });
});
