import { parseShell } from "./shell-parse";

/**
 * Battle plan 5.6: the Mac's action log, undo for file changes and dry run. The records live on the Mac only
 * (app/src/coordinator/local-exec/action-log.ts); these are the shapes the renderer reads and the pure helpers both
 * sides share. See docs/superpowers/specs/2026-09-30-action-log-undo-design.md.
 */
export type MacActionKind = "read" | "write" | "edit" | "delete" | "move" | "command" | "browser" | "app";
export type MacActionOutcome = "done" | "failed" | "refused" | "simulated";
/** What let the action run: this call's own card, a standing grant, or the Bot's mode on this Mac. */
export type MacActionVia = "card" | "always-bot" | "always-mac" | "full-auto" | "no-limits" | "accept-edits" | "permission" | "none";
export type MacUndoState = "available" | "undone" | "expired" | "none";
export type MacActionFilter = "all" | "files" | "commands" | "apps" | "dry-run";
export type DryRunMode = "off" | "turn" | "on";

export interface MacActionView {
  id: string;
  at: number;
  botId: string;
  kind: MacActionKind;
  /** The request's op (write-file, run-command, browser …). */
  op: string;
  /** Paths, a command, a site or an app: redacted, never contents. */
  targets: string[];
  /** A browser or app action's name ("click", "mail.send"); never what was typed. */
  act?: string;
  /** The shell command a delete or move came from. */
  command?: string;
  outcome: MacActionOutcome;
  /** A short fact: an exit code, an error, "Would overwrite (12 → 40 bytes)". Redacted. */
  detail?: string;
  via: MacActionVia;
  dryRun?: boolean;
  undo: MacUndoState;
  /** Why there is no undo ("Commands can't be undone", "Outside your project folders"). */
  undoNote?: string;
}

export type MacUndoResult = { ok: true } | { ok: false; conflict: boolean; message: string };

export const MAC_ACTION_FILTERS: readonly MacActionFilter[] = ["all", "files", "commands", "apps", "dry-run"];

export function macActionMatches(e: Pick<MacActionView, "kind" | "op" | "dryRun">, f: MacActionFilter): boolean {
  switch (f) {
    case "all": return true;
    case "files": return ["read", "write", "edit", "delete", "move"].includes(e.kind);
    case "commands": return e.op === "run-command" || e.op === "send-input";
    case "apps": return e.kind === "app" || e.kind === "browser";
    case "dry-run": return e.dryRun === true;
  }
}

/**
 * The file effects of a shell command the Mac can PROVE, or null. Only one plain `rm` (flags -f/-v) of literal
 * paths, or one plain `mv` (flags -f/-v) of one literal path onto another: no globs, variables, substitutions,
 * redirects, pipes, chains, wrappers or `--` tricks. The caller still checks each path on disk (a regular file, not a
 * symlink; mv's destination not a folder) before trusting it. Everything else is a command with no undo.
 */
export type ProvenEffect = { kind: "delete"; paths: string[] } | { kind: "move"; from: string; to: string };
export function provenFileEffects(command: string, cwd: string, home: string): ProvenEffect | null {
  if (!command || command.length > 4096 || /[\n\r]/.test(command)) return null;
  const p = parseShell(command, { cwd, home });
  if (p.opaque.length || p.compound || p.hasPipe || p.hasRedirect || p.hasSubstitution || p.background || p.cmds.length !== 1) return null;
  const c = p.cmds[0]!;
  if (c.wrappers.length || c.assigns.length || c.redirects.length || c.argsUnknown || c.programFromInput || c.origin !== "top") return null;
  const argv0 = c.argv[0];
  if (!argv0 || argv0.dynamic || argv0.glob || (argv0.text !== "rm" && argv0.text !== "mv")) return null;
  const paths: string[] = [];
  let flagsDone = false;
  for (const w of c.argv.slice(1)) {
    if (w.dynamic || w.glob || !w.text) return null;
    if (!flagsDone && !w.quoted && w.text === "--") { flagsDone = true; continue; }
    if (!flagsDone && !w.quoted && w.text.startsWith("-")) {
      if (!/^-[fv]+$/.test(w.text)) return null;
      continue;
    }
    if (!w.headQuoted && w.text.startsWith("~") && w.text !== "~" && !w.text.startsWith("~/")) return null;
    const t = !w.headQuoted && (w.text === "~" || w.text.startsWith("~/")) ? home + w.text.slice(1) : w.text;
    const abs = t.startsWith("/") ? t : `${cwd.replace(/\/+$/, "")}/${t}`;
    if (abs.split("/").includes("..")) return null;
    paths.push(abs.replace(/\/+/g, "/").replace(/\/\.(?=\/|$)/g, ""));
  }
  if (!paths.length || paths.length > 64) return null;
  if (argv0.text === "rm") return { kind: "delete", paths };
  return paths.length === 2 ? { kind: "move", from: paths[0]!, to: paths[1]! } : null;
}

/** The kind a shell command is logged as: a proven delete/move, else "command". */
export function commandKind(effect: ProvenEffect | null): MacActionKind {
  return effect?.kind ?? "command";
}

/** "would write 3 files, delete 1, run 2 commands" for a dry run's simulated and refused actions. */
export function dryRunTally(kinds: readonly MacActionKind[]): string {
  const n = (k: MacActionKind) => kinds.filter((x) => x === k).length;
  const parts: string[] = [];
  const files = n("write") + n("edit");
  if (files) parts.push(`write ${files} file${files === 1 ? "" : "s"}`);
  if (n("delete")) parts.push(`delete ${n("delete")}`);
  if (n("move")) parts.push(`move ${n("move")}`);
  if (n("command")) parts.push(`run ${n("command")} command${n("command") === 1 ? "" : "s"}`);
  const other = n("browser") + n("app");
  if (other) parts.push(`take ${other} app or browser action${other === 1 ? "" : "s"}`);
  return parts.length ? `would ${parts.join(", ")}` : "nothing would change";
}

export const STRAL = {
  section: "Activity",
  filters: { all: "All", files: "Files", commands: "Commands", apps: "Apps", "dry-run": "Dry run" } as Record<MacActionFilter, string>,
  allBots: "All Bots",
  export: "Export",
  undo: "Undo",
  undone: "Undone",
  empty: "Nothing yet",
  more: "Show more",
  kind: { read: "Read", write: "Wrote", edit: "Edited", delete: "Deleted", move: "Moved", command: "Ran", browser: "Browser", app: "App" } as Record<MacActionKind, string>,
  outcome: { done: "Done", failed: "Failed", refused: "Refused", simulated: "Dry run" } as Record<MacActionOutcome, string>,
  via: { card: "Approved", "always-bot": "Always allowed", "always-mac": "Always allowed", "full-auto": "Full auto", "no-limits": "No limits", "accept-edits": "Auto-accept edits", permission: "Allowed", none: "" } as Record<MacActionVia, string>,
  expired: "Expired",
  undoConfirm: (what: string) => `Undo "${what}"?`,
  undoVerb: "Undo",
  conflict: "Changed since. Not undone.",
  noUndoCommand: "Commands can't be undone",
  noUndoOutside: "Outside your home folder",
  noUndoExcluded: "Not kept for this folder",
  noUndoTooBig: "Too large to keep",
  noUndoKind: "Not a regular file",
  dryRun: "Dry run",
  dryRunModes: { off: "Off", turn: "Next turn", on: "On" } as Record<DryRunMode, string>,
  activityLink: "Activity",
  // What the Bot reads back in dry run.
  dryRunDone: (what: string, tally: string) => `Dry run: nothing changed. ${what} So far this turn: ${tally}.`,
  dryRunRefused: (what: string, tally: string) => `Dry run: this wasn't run, because its effect can't be simulated. ${what} So far this turn: ${tally}.`,
  dryRunWouldAsk: "It would ask first.",
  dryRunUnknown: "Dry run couldn't be checked on this Mac, so no changes are made. Set Dry run again in the Bot's settings, or reset permissions in Settings → Computer.",
} as const;

declare module "./gateway" {
  interface GatewayCommands {
    /** 5.6: the Mac's action log (answered by the coordinator, never the host). Newest first. */
    listMacActions: { args: { botId?: string; filter?: MacActionFilter; before?: number; limit?: number }; result: { entries: MacActionView[]; more: boolean } };
    /** 5.6: the log as JSON lines, for a Save dialog. */
    exportMacActions: { args: { botId?: string }; result: { fileName: string; text: string } };
    /** 5.6: restore a file change's prior state. `confirm: true` is sent only by the app's confirm dialog. */
    undoMacAction: { args: { id: string; confirm: true }; result: MacUndoResult };
    getLocalDryRun: { args: { id: string }; result: { mode: DryRunMode } };
    setLocalDryRun: { args: { id: string; mode: DryRunMode }; result: { mode: DryRunMode } };
  }
}
