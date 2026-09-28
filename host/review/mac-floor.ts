import path from "node:path";
import { browserReadOnly, macAppReadOnly, macFloorHits, macOpaque, type BrowserActionName, type MacAppActionName } from "@synapse/shared";
import type { ToolCall } from "../brain/types";
import { analyzeShell, GIT_CONTROL_PATH, SECURITY_PATH } from "./static";
import type { StaticResult } from "./types";

/**
 * P5 review I1: the static pass for host_shell (the user's own Mac, commands run by /bin/zsh -lc with the
 * user's full privileges). A MAC FLOOR hit — key and credential stores, persistence points, the app's own
 * data, pipe-to-shell installs and network sends — always raises a card; so do zsh-only constructs the
 * bash-oriented analyzer can't see through. Floor ids reuse the never-allowed categories (F7 credentials and
 * exfiltration, F8 the app's settings and persistence, F9 pipe-to-shell).
 */
// Final secfix item 2: the floor patterns (all case-insensitive) and the zsh-opaque checks live in @synapse/shared,
// so the Mac's own policy applies exactly the same floor.

export type MacStatic = StaticResult & { forceCard: boolean };

export function macStatic(text: string, o: { command?: boolean } = {}): MacStatic {
  const { signals, floors: floor } = macFloorHits(text);
  const zsh = macOpaque(text, o);
  if (zsh) signals.push("zsh_opaque");
  let readOnly = floor.size === 0 && !zsh;
  if (o.command !== false && readOnly) {
    const st = analyzeShell(text, { workspace: "/nonexistent-mac-root" });
    readOnly = st.readOnly && st.floorHits.length === 0;
    signals.push(...st.signals);
  }
  const floorHits = [...floor];
  return { tierHint: floorHits.length ? 4 : readOnly ? 0 : 2, signals: [...new Set(signals)], floorHits, readOnly, forceCard: floorHits.length > 0 || zsh };
}

/** The Mac-floor static result for one host_shell tool call (ExternalShell/ExternalRead/CopyToBox/CopyFromBox). */
export function hostCallStatic(call: ToolCall, workspace: string): MacStatic {
  const i = call.input;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (call.toolName) {
    case "mcp__bot__ExternalShell": {
      const st = macStatic(str(i.command));
      const cwd = str(i.cwd);
      if (!cwd) return st;
      const c = macStatic(cwd, { command: false });
      return c.forceCard ? { tierHint: 4, floorHits: [...new Set([...st.floorHits, ...c.floorHits])], signals: [...st.signals, ...c.signals], readOnly: false, forceCard: true } : st;
    }
    case "mcp__bot__ExternalRead": return macStatic(str(i.path), { command: false });
    case "mcp__bot__Mac": {
      // feat-mac-access-parity: a path check for the Mac file tool (glob/grep search a pattern, not a path).
      const act = str(i.action);
      const st = macStatic(str(i.path), { command: false });
      const write = act === "write" || act === "edit";
      return { ...st, readOnly: st.readOnly && !write };
    }
    case "mcp__bot__CopyToBox": {
      // I2: a copy INTO the box is a workspace write; git control files and security controls are F8 there too.
      const st = macStatic(str(i.local_path), { command: false });
      const dest = path.resolve(workspace, str(i.box_path));
      const hits = new Set(st.floorHits);
      const signals = [...st.signals];
      if (GIT_CONTROL_PATH.test(dest) || SECURITY_PATH.test(dest)) { hits.add("F8"); signals.push(`writes:${dest}`); }
      return { tierHint: hits.size ? 4 : 2, signals, floorHits: [...hits], readOnly: false, forceCard: hits.size > 0 };
    }
    case "mcp__bot__CopyFromBox": return { ...macStatic(str(i.local_path), { command: false }), readOnly: false };
    // mac-browser: no path or command to check; a read is read-only (the reviewer's fast path), anything else tier 2.
    // The Mac's own gates (permission, consequential actions, secret fields) judge the live page.
    case "mcp__bot__Browser": {
      const ro = browserReadOnly({ action: str(i.action) as BrowserActionName, value: str(i.value) });
      return { tierHint: ro ? 0 : 2, signals: [`browser:${str(i.action)}`], floorHits: [], readOnly: ro, forceCard: false };
    }
    // mac-apps: no path or command to check either. A read is read-only (the reviewer's fast path); anything
    // else is tier 2, and the MAC decides the rest — only it can see the resolved recipient or the real button
    // label, so the send/delete/spend/security card is minted there, not here.
    case "mcp__bot__MacApp": {
      const ro = macAppReadOnly({ action: str(i.action) as MacAppActionName, value: str(i.value) });
      return { tierHint: ro ? 0 : 2, signals: [`macapp:${str(i.action)}`], floorHits: [], readOnly: ro, forceCard: false };
    }
    default: return { tierHint: 2, signals: [], floorHits: [], readOnly: false, forceCard: false };
  }
}
