import { BROWSER_ACTIONS, BROWSER_PERMISSION_PREFIX, LOCAL_ADOPT_MODE, LOCAL_NEEDS_APPROVAL, MACAPP_ACTIONS, MACAPP_PERMISSION_PREFIX, STR5, STRB, STRMA, browserBindTarget, browserReadOnly, evaluateFixedRules, fullAutoAsk, localFullAutoAction, macAppBindTarget, macAppReadOnly, type BrowserArgs, type BrowserReply, type MacAppArgs, type MacAppReply, localBindTarget, localPermAction, macAutoRunEligible, type LocalAction, type LocalExecRequest, type PermResult } from "@synapse/shared";
import { hostCallStatic, type MacStatic } from "../review/mac-floor";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { TurnSlot } from "../runner/turn-slot";
import type { LocalAsks } from "./asks";
import type { BrowserCards } from "./browser-cards";
import type { LocalBridge, LocalExecResult } from "./bridge";
import { scrubGoogleClientSecrets } from "../google/setup-task";

const err = (text: string): BotToolResult => ({ text, isError: true });
const DEFAULT_BLOCK_MS = 30_000;

export function createLocalTools(d: {
  botId: string; slot(): TurnSlot | null; bridge: LocalBridge; asks: LocalAsks; now(): number;
  /** Whether Auto-review is on. Off means nothing reviewed the call in PreToolUse, so the card is required. */
  autoReviewOn?(): boolean;
  /** feat-mac-access-parity: the Bot's permission mode. Full-auto skips the Mac execution card (the account
   *  master switch "Never allow" still blocks everything; the fixed rules already stopped NEVER/ALWAYS-ASK upstream). */
  permMode?(): "ask" | "accept-edits" | "full-auto";
  /** Bug 258: the Bot is in No limits (the host setting). Sent to the Mac only as a cap; the Mac keeps its own record. */
  noLimits?(): boolean;
  /** The box workspace (CopyToBox's box_path resolves against it for the F8 floor). */
  workspace?: string;
  /** mac-browser: the Bot's name (the window bar), the user's latest message (the only source of a password/card
   *  value the Bot may type) and the session card + usage. */
  botName?(): string;
  lastUserMessage?(): string | null;
  browserCards?: BrowserCards;
  /** google-setup: refuses a Browser action before it runs (a string), and reads each page before the Bot does
   *  (client secrets become placeholders; the setup task captures them host-side). */
  browserFilter?: { refuse(args: BrowserArgs): string | null; text(text: string, url: string, editable?: string[]): string };
}): BotToolDef[] {
  /** LOC-03 second gate: the Mac's policy, then (for Ask) the first-time card. Auto-review already ran in PreToolUse.
   *  Integration ruling: local execution never runs unreviewed. With Auto-review off, "Always allow" still asks.
   *  P5 review I1: a Mac-floor hit or zsh-opaque command always asks; the computer-wide "Always allow" skips the card
   *  only for statically read-only calls; an "Always" answer on a card covers only this Bot and this action. */
  /** 5.6: the owner message this work belongs to (its epoch): approval resumes and follow-up turns keep it, the owner's
   *  next message changes it. The Mac's dry run "Next turn" lasts exactly that long. */
  const taskOf = (): { task?: string } => { const s = d.slot(); return s && typeof s.userMessageEpoch === "number" ? { task: `u${s.userMessageEpoch}` } : {}; };
  async function gate(action: LocalAction, target: string, st: MacStatic, req: { op: string; command?: string; path?: string; cwd?: string }): Promise<{ approvalId: string | null } | BotToolResult> {
    const c = d.bridge.computer();
    if (!c || !d.bridge.available()) return err(STR5.localNotConnected);
    if (c.executionPolicy === "never") return err(STR5.localNeverPolicy);
    const reviewed = d.autoReviewOn?.() ?? true;
    // Final secfix round 2 (ruling A): ANY "Always" (computer-wide or a per-Bot grant) auto-runs only a call that
    // passes the one shared allowlist-by-location predicate (the Mac applies it again on its real paths). The host
    // can't see the Mac's disk, so it checks the lexical path; with no auto-run roots (the default) it always asks.
    // fix-mac-gate-and-approval-expiry (Bug B): a card the user answered after the Bot's session ended woke the Bot;
    // its re-run of exactly that command carries the recorded approval (one-time, bound to this Bot + command).
    const late = d.asks.takeLateApproval(d.botId, action, target);
    if (late) return { approvalId: late };
    // The same fixed rules the Mac re-applies (shared/src/perm-rules.ts), on the host's lexical view of the Mac.
    // (In Ask mode a NEVER still reaches the card as before; the host gate denied it upstream and the Mac refuses it
    // even with an approval. In the modes that skip the card, it is refused right here.)
    const fixed = fixedFor(req);
    const mode = d.permMode?.() ?? "ask";
    if (fixed?.verdict === "never" && mode !== "ask") return err(STR5.macRefused.neverRule(fixed.reason));
    const always = c.executionPolicy === "always" || d.asks.granted(d.botId, action);
    const eligible = macAutoRunEligible(req, { home: c.home ?? c.localRoot, root: c.localRoot, roots: c.autoRunRoots ?? [] });
    if (reviewed && !st.forceCard && st.readOnly && always && eligible) return { approvalId: null };
    // Bug 256 (full-auto-quiet, the host's half): in Full auto the shared classifier is the whole card policy here too,
    // exactly as on the Mac (policy.ts) and in the PreToolUse gate. This gate used to card every Mac-floor hit and every
    // fixed ALWAYS-ASK in Full auto, so `ls ~/Library/Application Support/…`, a bookmarks grep or a curl download
    // carded on EVERY call although the Mac would have run it. The host sees only the lexical path; whatever only the
    // Mac's disk reveals (an overwrite, a sandbox-exempt tool, a hand-off, tool config) comes back as the Mac's
    // refusal, which run() below turns into this same card. The fixed NEVER above still refuses outright.
    // Auto-accept edits skips it for an edit the fixed rules auto-allow (inside a project dir).
    const skip = (mode === "full-auto" && !fullAutoFor(req).ask)
      || (mode === "accept-edits" && !st.forceCard && fixed?.verdict === "always-allow" && (req.op === "edit-file" || req.op === "write-file"));
    if (skip) {
      // fix-fullauto-adoption: while this Bot's adoption card is pending on the Mac, the request joins it (no card of
      // its own, nothing sent); the answer wakes the Bot, naming it.
      if (d.asks.adoptionPending(d.botId) === mode) return adopt(mode, target);
      return { approvalId: null };
    }
    return card(action, target);
  }
  /** Bug #96: a waiting card ends the turn (the runner interrupts once this tool returns) instead of holding a slot. */
  function waiting(text: string): BotToolResult {
    const slot = d.slot();
    if (slot) slot.awaitingUserSelection = true;
    return err(text);
  }
  /** The Mac card. Its answer (in the app on the Mac) mints the Mac's one-time approval, bound to action + target, and
   *  wakes the Bot; its re-run of exactly this call carries that approval (takeLateApproval above). */
  function card(action: LocalAction, target: string, description?: string): BotToolResult {
    const slot = d.slot();
    if (!slot) return err("No active turn.");
    d.asks.post(d.botId, slot, { action, target, ...(description ? { description } : {}) });
    return waiting(STR5.localAskWaiting);
  }
  /** fix-fullauto-adoption: ONE Mac-side card per Bot adopts the host's mode on the Mac (the Mac writes the record when
   *  the user answers there; the host never can). Further requests join it. */
  function adopt(mode: "accept-edits" | "full-auto", target: string): BotToolResult {
    const slot = d.slot();
    if (!slot) return err("No active turn.");
    d.asks.adopt(d.botId, slot, mode, target);
    return waiting(STR5.localAdoptWaiting(mode));
  }
  /** Bug 256: the shared Full-auto classifier on the host's lexical view of the Mac (the Mac re-runs it on its disk).
   *  `exists` is unknown here, so an overwrite is left to the Mac, whose refusal becomes the card. */
  function fullAutoFor(req: { op: string; command?: string; path?: string; cwd?: string }): { ask: boolean } {
    const c = d.bridge.computer();
    if (!c) return { ask: true };
    const home = c.home ?? c.localRoot;
    const action = localFullAutoAction(req, c.localRoot || home, home);
    const noLimits = (d.permMode?.() ?? "ask") === "full-auto" && (d.noLimits?.() ?? false);
    return action ? fullAutoAsk(action, { home, workspaces: c.autoRunRoots ?? [], exists: () => false, noLimits }) : { ask: false };
  }
  function fixedFor(req: { op: string; command?: string; path?: string; cwd?: string }): PermResult | null {
    const c = d.bridge.computer();
    if (!c) return null;
    const home = c.home ?? c.localRoot;
    const action = localPermAction(req, c.localRoot || home, home);
    const noLimits = (d.permMode?.() ?? "ask") === "full-auto" && (d.noLimits?.() ?? false);
    return action ? evaluateFixedRules(action, { home, projectDirs: c.autoRunRoots ?? [], noLimits }) : null;
  }
  /**
   * Send one request to the Mac. If the Mac refuses it for want of an approval (its own settings disagree with the
   * host's, e.g. a mode the user never set in the app on the Mac, or an ALWAYS-ASK only its real paths reveal), the
   * refusal becomes the card that mints that approval — never a dead end. Bug #96: the turn ends on that card and its
   * answer wakes the Bot, whose re-run carries the approval. fix-fullauto-adoption: a refusal only because the Mac has
   * no record of the host's mode becomes the Bot's ONE adoption card instead.
   */
  async function run(action: LocalAction, target: string, req: Omit<LocalExecRequest, "execId" | "botId" | "approvalId">, approvalId: string | null, blockMs: number | null): Promise<{ execId: string; r: LocalExecResult | null } | BotToolResult> {
    const send = (id: string | null) => {
      const x = d.bridge.request({ botId: d.botId, approvalId: id, hostMode: d.permMode?.() ?? "ask", hostNoLimits: (d.permMode?.() ?? "ask") === "full-auto" && (d.noLimits?.() ?? false), ...taskOf(), ...req });
      return { execId: x.execId, wait: blockMs === null ? x.done : Promise.race([x.done, new Promise<null>((res) => setTimeout(() => res(null), blockMs))]) };
    };
    const s = send(approvalId);
    const r = await s.wait;
    if (approvalId === null && r?.error?.startsWith(LOCAL_ADOPT_MODE)) {
      const mode = d.permMode?.() ?? "ask";
      if (mode !== "ask") return adopt(mode, target);
    }
    if (r?.error?.startsWith(LOCAL_NEEDS_APPROVAL) && approvalId === null) return card(action, target);
    return { execId: s.execId, r };
  }
  const errText = (e: string) => (e.startsWith(LOCAL_NEEDS_APPROVAL) ? e.slice(LOCAL_NEEDS_APPROVAL.length) : e.startsWith(LOCAL_ADOPT_MODE) ? e.slice(LOCAL_ADOPT_MODE.length) : e);
  const stat = (tool: string, input: Record<string, unknown>) => hostCallStatic({ toolName: `mcp__bot__${tool}`, input, toolUseId: "" }, d.workspace ?? "/workspace");
  const unavailable = (r: LocalExecResult) => r.error?.startsWith("unavailable:") ? STR5.localUnavailable(r.error.slice(12)) : null;
  const fmt = (r: LocalExecResult) => unavailable(r) ?? (r.error ? `Error: ${errText(r.error)}` : `${r.output}${r.result ? r.result : ""}\n[exit code ${r.exitCode}]`);
  /** A finished file/copy request: the unavailable line, the Mac's (actionable) refusal, or the result. */
  const finished = (x: { r: LocalExecResult | null } | BotToolResult, ok: (r: LocalExecResult) => BotToolResult): BotToolResult => {
    if ("text" in x) return x;
    const r = x.r!;
    return unavailable(r) ? err(unavailable(r)!) : r.error ? err(errText(r.error)) : ok(r);
  };

  /**
   * mac-browser: one action in the Bot's window on the Mac. Auto-review already ran in PreToolUse (host_shell; reads
   * take the fast path). The Mac decides the rest against the live page: the per-Bot "May use the browser" permission
   * (first use asks), consequential actions (always ask), password/card fields (only a value the user gave this turn).
   */
  async function browser(args: BrowserArgs): Promise<BotToolResult> {
    const c = d.bridge.computer();
    if (!c || !d.bridge.available()) return err(STR5.localNotConnected);
    if (c.executionPolicy === "never") return err(STR5.localNeverPolicy);
    const refused = d.browserFilter?.refuse(args);
    if (refused) return err(refused);
    const target = browserBindTarget(args);
    const approvalId = d.asks.takeLateApproval(d.botId, "browser", target) ?? d.asks.takeLateApproval(d.botId, "browser", `${BROWSER_PERMISSION_PREFIX}${target}`);
    // Local execution never runs unreviewed: in Ask mode with Auto-review off, a page-changing action cards first.
    if (!approvalId && !browserReadOnly(args) && (d.permMode?.() ?? "ask") === "ask" && !(d.autoReviewOn?.() ?? true)) return card("browser", target);
    const slot = d.slot();
    const userTurn = slot?.source === "user";
    const said = userTurn ? d.lastUserMessage?.() ?? "" : "";
    const explicit = userTurn && typeof args.text === "string" && args.text.length > 0 && said.includes(args.text);
    const name = d.botName?.() ?? "This Bot";
    const x = d.bridge.request({ botId: d.botId, approvalId, hostMode: d.permMode?.() ?? "ask", op: "browser", browser: args, botName: name, explicit, turn: slot?.requestId, userTurn, ...taskOf() });
    const r = await x.done;
    if (approvalId === null && r.error?.startsWith(LOCAL_NEEDS_APPROVAL)) {
      const why = r.error.slice(LOCAL_NEEDS_APPROVAL.length);
      return why.startsWith(STRB.permissionRefused) ? card("browser", `${BROWSER_PERMISSION_PREFIX}${target}`, STRB.permissionAsk(name)) : card("browser", target, why);
    }
    if (unavailable(r)) return err(unavailable(r)!);
    if (r.error) return err(errText(r.error));
    let rep: BrowserReply;
    try { rep = JSON.parse(r.result ?? "") as BrowserReply; } catch { return err("The Mac sent back an unreadable browser reply."); }
    d.browserCards?.record(d.botId, slot, rep);
    return { text: d.browserFilter ? d.browserFilter.text(rep.text, rep.url, Array.isArray(rep.editable) ? rep.editable.filter((v) => typeof v === "string") : undefined) : scrubGoogleClientSecrets(rep.text), ...(rep.image ? { images: [{ data: rep.image, mimeType: "image/jpeg" }] } : {}) };
  }

  /**
   * mac-apps: one action in an app on the Mac. Like Browser, the MAC is the final authority — it holds the
   * per-Bot "May use the apps on your Mac" permission, the consequential gate (send, delete, spend and
   * security always ask, in every mode) and the credential refusal, because only the Mac can see what is
   * really on screen. A refusal it can card comes back prefixed and becomes that card here.
   */
  async function macapp(args: MacAppArgs): Promise<BotToolResult> {
    const c = d.bridge.computer();
    if (!c || !d.bridge.available()) return err(STR5.localNotConnected);
    if (c.executionPolicy === "never") return err(STR5.localNeverPolicy);
    const target = macAppBindTarget(args);
    const approvalId = d.asks.takeLateApproval(d.botId, "mac-app", target) ?? d.asks.takeLateApproval(d.botId, "mac-app", `${MACAPP_PERMISSION_PREFIX}${target}`);
    const name = d.botName?.() ?? "This Bot";
    // Local execution never runs unreviewed: in Ask mode with Auto-review off, nothing reviewed this call in
    // PreToolUse, so anything that changes an app cards first (the same rule as the Browser tool's).
    if (!approvalId && !macAppReadOnly(args) && (d.permMode?.() ?? "ask") === "ask" && !(d.autoReviewOn?.() ?? true)) return card("mac-app", target);
    const slot = d.slot();
    const x = d.bridge.request({ botId: d.botId, approvalId, hostMode: d.permMode?.() ?? "ask", op: "mac-app", macapp: args, botName: name, turn: slot?.requestId, userTurn: slot?.source === "user", ...taskOf() });
    const r = await x.done;
    if (approvalId === null && r.error?.startsWith(LOCAL_NEEDS_APPROVAL)) {
      const why = r.error.slice(LOCAL_NEEDS_APPROVAL.length);
      return why.startsWith(STRMA.permissionRefused)
        ? card("mac-app", `${MACAPP_PERMISSION_PREFIX}${target}`, STRMA.askPermission(name))
        : card("mac-app", target, why);
    }
    if (unavailable(r)) return err(unavailable(r)!);
    if (r.error) return err(errText(r.error));
    let rep: MacAppReply;
    try { rep = JSON.parse(r.result ?? "") as MacAppReply; } catch { return err("The Mac sent back an unreadable app reply."); }
    return { text: rep.text };
  }

  return [
    { name: "MacApp", description: STRMA.toolDescription, readOnly: false,
      schema: {
        action: z.enum(MACAPP_ACTIONS), app: z.string().optional(), target: z.string().optional(), text: z.string().optional(),
        title: z.string().optional(), query: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
        people: z.string().optional(), list: z.string().optional(), ref: z.string().optional(), value: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(), page: z.number().int().min(1).max(50).optional(),
      },
      handler: (a) => macapp(Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null)) as unknown as MacAppArgs) },
    { name: "Browser", description: STRB.toolDescription, readOnly: false,
      schema: { action: z.enum(BROWSER_ACTIONS), url: z.string().optional(), ref: z.string().optional(), text: z.string().optional(), value: z.string().optional(), submit: z.boolean().optional() },
      handler: (a) => browser({
        action: a.action as BrowserArgs["action"],
        ...(typeof a.url === "string" ? { url: a.url } : {}), ...(typeof a.ref === "string" ? { ref: a.ref } : {}),
        ...(typeof a.text === "string" ? { text: a.text } : {}), ...(typeof a.value === "string" ? { value: a.value } : {}),
        ...(a.submit === true ? { submit: true } : {}),
      }) },
    { name: "ExternalShell", description: "Run a shell command on the user's own computer (the Mac). Full user privileges inside the local root.", readOnly: false,
      schema: { command: z.string(), cwd: z.string().optional(), block_ms: z.number().int().min(0).max(600_000).optional(), timeout_ms: z.number().int().optional() },
      handler: async (a) => {
        const cwd = a.cwd as string | undefined;
        const target = localBindTarget({ op: "run-command", command: String(a.command), cwd });
        const g = await gate("run-command", target, stat("ExternalShell", a), { op: "run-command", command: String(a.command), cwd });
        if ("text" in g) return g;
        const x = await run("run-command", target, { op: "run-command", command: String(a.command), cwd, timeoutMs: a.timeout_ms as number | undefined }, g.approvalId, (a.block_ms as number | undefined) ?? DEFAULT_BLOCK_MS);
        if ("text" in x) return x;
        if (x.r) return { text: fmt(x.r), isError: !!x.r.error };
        return { text: `${d.bridge.outputSoFar(x.execId, d.botId)}\n[still running; shell_id ${x.execId}. Use AwaitExternalShell to wait for more output.]` };
      } },
    { name: "AwaitExternalShell", description: "Wait for more output from a running ExternalShell.", readOnly: true,
      schema: { shell_id: z.string(), block_ms: z.number().int().min(0).max(600_000).optional() },
      handler: async (a) => {
        const id = String(a.shell_id);
        if (!d.bridge.isRunning(id, d.botId)) {
          const r = d.bridge.result(id, d.botId);
          return r ? { text: fmt(r), isError: !!r.error } : err(`No shell ${id}.`);
        }
        const until = d.now() + ((a.block_ms as number | undefined) ?? DEFAULT_BLOCK_MS);
        while (d.bridge.isRunning(id, d.botId) && d.now() < until) await new Promise((r) => setTimeout(r, 250));
        const r = d.bridge.result(id, d.botId);
        return r ? { text: fmt(r), isError: !!r.error } : { text: `${d.bridge.outputSoFar(id, d.botId)}\n[still running; shell_id ${id}]` };
      } },
    { name: "ExternalRead", description: "Read a file or list a folder on the user's computer.", readOnly: true,
      schema: { path: z.string() },
      handler: async (a) => {
        const target = localBindTarget({ op: "read-file", path: String(a.path) });
        const g = await gate("read-file", target, stat("ExternalRead", a), { op: "read-file", path: String(a.path) });
        if ("text" in g) return g;
        return finished(await run("read-file", target, { op: "read-file", path: String(a.path) }, g.approvalId, null), (r) => ({ text: r.result ?? "" }));
      } },
    // feat-mac-access-parity: CLI-parity file tools folded into one action-enum tool (short schema, one card path).
    { name: "Mac", description: "Files on the user's Mac: action read (optional line range), write, edit (exact-string replace), glob, grep.", readOnly: false,
      schema: { action: z.enum(["read", "write", "edit", "glob", "grep"]), path: z.string().optional(), content: z.string().optional(), old_string: z.string().optional(), new_string: z.string().optional(), replace_all: z.boolean().optional(), pattern: z.string().optional(), offset: z.number().int().optional(), limit: z.number().int().optional() },
      handler: async (a) => {
        const action = String(a.action);
        const write = action === "write" || action === "edit";
        const op: LocalAction = action === "read" ? "read-file" : action === "write" ? "write-file" : action === "edit" ? "edit-file" : action === "glob" ? "glob" : "grep";
        const macAction = write ? "write-file" as const : "read-file" as const;
        const req = { op, path: a.path as string | undefined, content: a.content as string | undefined, oldString: a.old_string as string | undefined, newString: a.new_string as string | undefined, replaceAll: a.replace_all as boolean | undefined, pattern: a.pattern as string | undefined, offset: a.offset as number | undefined, limit: a.limit as number | undefined };
        const target = localBindTarget({ op, path: String(a.path ?? ""), pattern: a.pattern as string | undefined, oldString: a.old_string as string | undefined });
        const g = await gate(macAction, target, stat("Mac", a), { op, path: a.path as string | undefined });
        if ("text" in g) return g;
        return finished(await run(macAction, target, req, g.approvalId, null), (r) => ({ text: r.result ?? "" }));
      } },
    { name: "CopyToBox", description: "Copy a file from the user's computer into the workspace (max 100 MiB).", readOnly: false,
      schema: { local_path: z.string(), box_path: z.string() },
      handler: async (a) => {
        const target = localBindTarget({ op: "copy-to-box", path: String(a.local_path), boxPath: String(a.box_path) });
        const g = await gate("read-file", target, stat("CopyToBox", a), { op: "copy-to-box", path: String(a.local_path) });
        if ("text" in g) return g;
        return finished(await run("read-file", target, { op: "copy-to-box", path: String(a.local_path), boxPath: String(a.box_path) }, g.approvalId, null), (r) => ({ text: `Copied ${String(a.local_path)} to ${String(a.box_path)} (${r.result} bytes).` }));
      } },
    { name: "CopyFromBox", description: "Copy a workspace file to the user's computer (max 100 MiB).", readOnly: false,
      schema: { box_path: z.string(), local_path: z.string() },
      handler: async (a) => {
        const target = localBindTarget({ op: "copy-from-box", path: String(a.local_path), boxPath: String(a.box_path) });
        const g = await gate("write-file", target, stat("CopyFromBox", a), { op: "copy-from-box", path: String(a.local_path) });
        if ("text" in g) return g;
        return finished(await run("write-file", target, { op: "copy-from-box", path: String(a.local_path), boxPath: String(a.box_path) }, g.approvalId, null), (r) => ({ text: `Copied ${String(a.box_path)} to ${r.result}.` }));
      } },
  ];
}
