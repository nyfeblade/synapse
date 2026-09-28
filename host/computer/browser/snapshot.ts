import { LIMITSC } from "@synapse/shared";
import type { CdpPage } from "./connector";

export interface AXNode {
  nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown };
  childIds?: string[]; parentId?: string; backendDOMNodeId?: number;
}
export interface SnapshotResult { text: string; refs: Map<string, number>; nodes: number; truncated: boolean }

const WRAPPERS = new Set(["generic", "none", "presentation", "LineBreak", "InlineTextBox"]);
const q = (s: string) => JSON.stringify(s);

export function renderSnapshot(nodes: AXNode[], o: { maxNodes: number; maxDepth: number; passwordIds: Set<number> }): SnapshotResult {
  const byId = new Map(nodes.map((x) => [x.nodeId, x]));
  const childSet = new Set(nodes.flatMap((x) => x.childIds ?? []));
  const root = nodes.find((x) => !x.parentId && !childSet.has(x.nodeId)) ?? nodes[0];
  const lines: string[] = [];
  const refs = new Map<string, number>();
  let count = 0;
  let truncated = false;
  const walk = (id: string, depth: number): void => {
    if (truncated) return;
    const nd = byId.get(id);
    if (!nd) return;
    const role = nd.role?.value ?? "";
    const name = (nd.name?.value ?? "").trim();
    const hoist = nd.ignored || (WRAPPERS.has(role) && !name);
    let next = depth;
    if (!hoist) {
      if (depth > o.maxDepth) return;
      if (count >= o.maxNodes) { truncated = true; return; }
      count += 1;
      const ref = `e${count}`;
      if (nd.backendDOMNodeId !== undefined) refs.set(ref, nd.backendDOMNodeId);
      const raw = nd.value?.value;
      const val = raw === undefined || raw === "" ? "" : ` value=${q(nd.backendDOMNodeId !== undefined && o.passwordIds.has(nd.backendDOMNodeId) ? "[redacted]" : String(raw))}`;
      lines.push(`${"  ".repeat(depth)}- ${role}${name ? ` ${q(name)}` : ""}${val} [ref=${ref}]`);
      next = depth + 1;
    }
    for (const c of nd.childIds ?? []) walk(c, next);
  };
  if (root) walk(root.nodeId, 0);
  if (truncated) lines.push(`… (snapshot truncated at ${o.maxNodes} nodes; scroll or navigate to see more)`);
  return { text: lines.join("\n"), refs, nodes: count, truncated };
}

/** BRW-04: accessibility snapshot of the Bot's tab; password inputs are found through the DOM and their values never leave the host. */
export async function takeSnapshot(page: CdpPage): Promise<SnapshotResult> {
  await page.send("DOM.enable");
  await page.send("Accessibility.enable");
  const { root } = await page.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await page.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "input[type=password]" });
  const passwordIds = new Set<number>();
  for (const nodeId of nodeIds) {
    const { node } = await page.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    passwordIds.add(node.backendNodeId);
  }
  const { nodes } = await page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
  return renderSnapshot(nodes, { maxNodes: LIMITSC.snapshotNodes, maxDepth: LIMITSC.snapshotDepth, passwordIds });
}
