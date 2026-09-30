import fs from "node:fs";
import path from "node:path";
import { BROWSER_UNREVIEWED, COMPOSIO_SERVER_ID, isComposioHost, COMPUTER_NAME, composioAppName, composioToolReadOnly, composioToolkitOf, REVIEWED_COMPUTER_ACTIONS, STRC, browserBindTarget, browserReadOnly, macAppBindTarget, macAppReadOnly, macAppSummary, messagesSend, messagesSendSummary, realOfDeepest, type BrowserArgs, type MacAppArgs, type Surface } from "@synapse/shared";
import type { ToolCall } from "../brain/types";
import type { HostConfig } from "../config";
import { privateRoots, privateToAnother } from "../walls/registry";
import { botOsUser } from "../walls/bot-uid";
import { addressOf, parseRecipients } from "../google/recipients";
import { GIT_CONTROL_PATH } from "./static";
import { TEXT } from "./texts";
import { elementLabel } from "../computer/perception/mode";
import type { RiskTarget } from "./types";

export interface Classification { surface: Surface | null; sideEffect: boolean; target: RiskTarget | null; hardDeny: string | null; summary: string; command: string | null }

interface ComputerStep { action: string; x?: number; y?: number; x2?: number; y2?: number; path?: { x: number; y: number }[]; text?: string; key?: string; description?: string }

const UI_AUTOMATION = /\b(xdotool|wmctrl|xte|ydotool|osascript|cliclick|pyautogui|pynput|robotjs|sikuli|Quartz\.CGEvent|ApplicationServices\.framework|chromedriver|selenium-server|puppeteer|chrome-devtools-protocol)\b|--remote-debugging-(port|pipe)|playwright\s+(codegen|open)/;
const READ_ONLY_MCP = /(^|_)(get|list|search|read|fetch|find|query|lookup|describe)(_|$)/i;

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
/** Bug 441: a box path's real form: the deepest existing ancestor resolved, the missing tail kept. */
const realBoxPath = (abs: string): string => path.resolve(realOfDeepest(abs, (x) => fs.realpathSync.native(x)) ?? abs);
/** `p` is `root` or below it (a whole path segment, not a name prefix). */
const inside = (p: string, root: string): boolean => { const r = root.replace(/\/+$/, ""); return p === r || p.startsWith(`${r}/`); };

/** True when p (resolved against the workspace) is root or inside it. */
export function insideDir(workspace: string, p: string, root: string): boolean {
  const r = path.resolve(workspace, p);
  const base = path.resolve(root);
  return r === base || r.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/**
 * Bug #61 (Bot walls): the tool-level guard for paths another Bot owns (walls/registry.ts). It is weaker than the OS
 * wall on host-private data: a Bash command can still reach a box-readable path it never names (cd, variables,
 * relative paths, a script file). Paths are expanded for ~ and $HOME; a glob is also checked at its fixed prefix.
 */
const PATH_TOKEN = /(?:~|\$\{?HOME\}?)?\/[^\s'"<>|;&()`]*/g;
function wallTokens(text: string, boxHome: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    const t = m[0].replace(/^(?:~|\$\{?HOME\}?)(?=\/)/, boxHome);
    out.push(t);
    const segs = t.split("/");
    const g = segs.findIndex((x) => /[*?[{]/.test(x));
    if (g > 0) out.push(segs.slice(0, g).join("/") || "/");
  }
  return out;
}
export function wallDenied(cfg: HostConfig, botId: string | undefined, text: string): boolean {
  // Bug #66: once migrated, a Bot's ~ and $HOME are its own home, not box's.
  const home = (botId && /^[A-Za-z0-9_-]{1,64}$/.test(botId) ? botOsUser(cfg, botId)?.home : undefined) ?? cfg.boxHome;
  return wallTokens(text, home).some((t) => privateToAnother(cfg, botId, path.resolve(cfg.workspace, t)));
}
/** A recursive Glob/Grep rooted at an ancestor of another Bot's private data (the workspace itself excepted). */
function searchesWalled(cfg: HostConfig, p: string): boolean {
  const r = path.resolve(cfg.workspace, p);
  if (r === path.resolve(cfg.workspace)) return false;
  return privateRoots(cfg).some((root) => insideDir("/", root, r));
}

const GOOGLE_READS = new Set(["gmail_search", "gmail_read", "calendar_list", "drive_search", "drive_read"]);

/** ORIG-GOOGLE: the built-in Google tools. Reads are low-risk (no card); anything that acts on the user's Google
 *  account is a google_write, which the gate always shows as a card (even with Auto-review off). A draft only to
 *  the user themself stays a quiet side effect. */
function classifyGoogle(tool: string, input: Record<string, unknown>, googleEmail: string | null | undefined): Classification | null {
  const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  if (GOOGLE_READS.has(tool)) return { surface: null, sideEffect: false, target: null, hardDeny: null, summary: "", command: null };
  const to = input.to === undefined ? [] : parseRecipients(input.to);
  const toText = to?.length ? to.join(", ") : s(input.to);
  if (tool === "gmail_draft" && googleEmail && !input.reply_to_id && to?.length && to.every((r) => addressOf(r) === googleEmail.toLowerCase())) {
    return { surface: null, sideEffect: true, target: null, hardDeny: null, summary: "", command: null };
  }
  const summary =
    tool === "gmail_send" ? (input.draft_id ? `Send your Gmail draft ${s(input.draft_id)}` : `Send an email from your Gmail to ${toText || "the original sender"}: “${s(input.subject).slice(0, 120)}”`)
    : tool === "gmail_draft" ? `Save a Gmail draft to ${toText || "the original sender"}: “${s(input.subject).slice(0, 120)}”`
    : tool === "calendar_create" ? `Add “${s(input.summary).slice(0, 120)}” to your Google Calendar (${s(input.start)} → ${s(input.end)})`
    : tool === "calendar_update" ? `Change the Google Calendar event ${s(input.id)}`
    : tool === "calendar_delete" ? `Delete the Google Calendar event ${s(input.id)}`
    : tool === "drive_upload" ? `Upload ${s(input.path)} to your Google Drive${input.name ? ` as “${s(input.name).slice(0, 120)}”` : ""}`
    : null;
  if (!summary) return null;
  return {
    surface: "mcp", sideEffect: true, hardDeny: null, command: `google.${tool}(${JSON.stringify(input)})`.slice(0, 4000), summary,
    target: { action: "google_write", arguments: { tool, ...input }, enrichment: null },
  };
}

/**
 * Apps through Composio (host/composio): a read (GMAIL_FETCH_EMAILS) is quiet; anything else acts on the user's own
 * account (send, create, change, delete) and is a composio_write, which the gate always shows as a card, like a
 * Google write. The server id is reserved (mcp/reserved.ts), so only the built-in connector answers to this name.
 */
function classifyComposio(tool: string, input: Record<string, unknown>): Classification {
  if (composioToolReadOnly(tool)) return { surface: null, sideEffect: false, target: null, hardDeny: null, summary: "", command: null };
  const toolkit = composioToolkitOf(tool);
  const app = toolkit ? composioAppName(toolkit) : "a connected app";
  const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
  const words = tool.toLowerCase().split("_").slice(toolkit ? 1 : 0).join(" ");
  const to = s(input.recipient_email ?? input.to ?? input.channel ?? "");
  const subject = s(input.subject ?? input.title ?? input.summary ?? input.name ?? "");
  const summary = `${app} through Composio: ${words}${to ? ` to ${to.slice(0, 160)}` : ""}${subject ? ` “${subject.slice(0, 120)}”` : ""}`;
  return {
    surface: "mcp", sideEffect: true, hardDeny: null, command: `composio.${tool}(${JSON.stringify(input)})`.slice(0, 4000), summary: summary.slice(0, 500),
    target: { action: "composio_write", arguments: { tool, toolkit, arguments: input }, enrichment: null },
  };
}

/**
 * Bug 403: an MCP tool whose name says it sends, deletes, pays, posts, creates or updates something. With Auto-review
 * off these still ask (approval-gate.ts); reads and anything else run as before. Words are split on _ - . and camelCase.
 */
/** Bug 404: stems long enough to match inside a glued or prefixed word (sendmail, bulkdelete, HTTPSend, unsubscribe). */
const CHANGE_STEMS_LOOSE = ["send", "delete", "remove", "destroy", "purge", "erase", "create", "update", "modify", "insert", "upsert", "upload",
  "rename", "publish", "subscribe", "transfer", "refund", "purchase", "checkout", "charge", "broadcast", "forward", "invite", "comment",
  "notify", "reply", "respond", "decline", "accept", "reset", "restore", "assign", "approve", "merge", "submit", "execute", "trigger",
  "invoke", "deploy", "revoke", "cancel", "archive", "schedule", "import", "export", "message", "tweet", "replace", "duplicate", "convert",
  "disconnect", "connect", "uninstall", "install", "release", "unlabel", "unblock", "unmute", "unfollow", "unstar", "unpin", "unlock", "unarchive", "untrash", "dispatch"];
/** Short or ambiguous stems: the whole word, or the word with an inflection (posts, setting, ran is not caught). */
const CHANGE_STEMS_EXACT = ["add", "set", "run", "put", "post", "pay", "ban", "kick", "mark", "sync", "clear", "dm", "sms", "edit", "move",
  "close", "reopen", "share", "email", "write", "patch", "trash", "wipe", "grant", "label", "block", "mute", "star", "pin", "join", "leave",
  "lock", "copy", "stop", "start", "follow", "fork", "draft", "apply", "empty", "enable", "disable", "react", "rerun", "retry", "upvote", "vote", "order", "buy", "sell", "book"];
const EXACT_RE = new RegExp(`^(${CHANGE_STEMS_EXACT.join("|")})((?<=[^aeiou])([a-z])\\3?)?(s|es|ed|d|ing)?$`);
const LOOSE_RE = new RegExp(`(${CHANGE_STEMS_LOOSE.join("|")})`);
/**
 * Bug 403/404: an MCP tool whose name says it sends, deletes, pays, posts, creates, updates … something. With
 * Auto-review off these still ask (approval-gate.ts). Words are split on separators and case changes (HTTPSend →
 * http, send); a long stem counts anywhere in a word, a short one only as the word itself or its inflection. A read
 * verb doesn't cancel a change stem: `get_schedule_list` cards (the safe side).
 */
export function mcpToolChanges(tool: string): boolean {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => LOOSE_RE.test(w) || EXACT_RE.test(w));
}

/** Bug 404: a Composio action slug (GMAIL_SEND_EMAIL) with a known toolkit prefix, whatever server serves it. */
const COMPOSIO_SLUG_PREFIXES = ["GMAIL", "GOOGLECALENDAR", "GOOGLEDRIVE", "GOOGLEDOCS", "GOOGLESHEETS", "GOOGLEMEET", "GOOGLETASKS", "SLACK", "SLACKBOT",
  "GITHUB", "GITLAB", "NOTION", "LINEAR", "JIRA", "CONFLUENCE", "TRELLO", "ASANA", "CLICKUP", "OUTLOOK", "MICROSOFT_TEAMS", "ONEDRIVE", "DROPBOX",
  "DISCORD", "DISCORDBOT", "TWITTER", "LINKEDIN", "HUBSPOT", "SALESFORCE", "ZENDESK", "INTERCOM", "STRIPE", "SHOPIFY", "AIRTABLE", "FIGMA",
  "CALENDLY", "ZOOM", "TELEGRAM", "WHATSAPP", "REDDIT", "YOUTUBE", "SUPABASE", "COMPOSIO", "RUBE"];
const COMPOSIO_SLUG_RE = new RegExp(`^(${COMPOSIO_SLUG_PREFIXES.join("|")})_[A-Z0-9_]+$`);
export function looksLikeComposioSlug(tool: string): boolean {
  return COMPOSIO_SLUG_RE.test(tool);
}

export function classifyTool(call: ToolCall, o: { workspace: string; hostPrivate: string; enforce?: boolean; shellCwd?: string; botId?: string; mcpReadOnly?(serverId: string, tool: string): boolean; googleEmail?: string | null;
  /** Final secfix item 4: true only when this Bot's "google" server is the app's built-in one (identity, not the name). */
  googleBuiltin?: boolean;
  /** Bug 402: true only when this Bot's "composio_apps" server is the app's built-in Composio connector. */
  composioBuiltin?: boolean;
  /** Bug 403: a registry MCP server's URL host (null for a command server or an unknown id). */
  mcpServerHost?(serverId: string): string | null;
  /** Bug 404: a registry server that is Composio by its command, args or URL (npx @composio/mcp, a proxy …). */
  mcpServerComposio?(serverId: string): boolean;
  /** google-setup security fix 1: the captured client ID when SaveGoogleClient would replace a working connection. */
  googleClientReplace?: { clientId: string; replace: boolean } | null;
  /** Bug #61: the host config the Bot walls are declared against; the guard is on whenever it is given. */
  walls?: HostConfig }): Classification {
  const { toolName: name, input } = call;
  const under = (p: unknown, root: string) => typeof p === "string" && p.length > 0 && path.resolve(o.workspace, p).startsWith(root);
  const none = (sideEffect: boolean): Classification => ({ surface: null, sideEffect, target: null, hardDeny: null, summary: "", command: null });
  const deny = (text: string): Classification => ({ surface: null, sideEffect: false, target: null, hardDeny: text, summary: "", command: null });
  const walls = o.walls;
  const walledPath = (p: unknown) => walls !== undefined && typeof p === "string" && p.length > 0 && wallDenied(walls, o.botId, p.startsWith("/") || p.startsWith("~") || p.startsWith("$") ? p : path.resolve(o.workspace, p));
  const walledText = (t: string) => walls !== undefined && wallDenied(walls, o.botId, t);

  if (name === "Bash") {
    const command = String(input.command ?? "");
    if (UI_AUTOMATION.test(command)) return deny(TEXT.uiAutomation);
    if (command.includes(o.hostPrivate)) return deny(TEXT.protectedPath);
    if (walledText(command)) return deny(TEXT.otherBotPrivate);
    if (input.run_in_background) return deny(TEXT.background);
    return {
      surface: "box_shell", sideEffect: true, hardDeny: null, command, summary: `Run “${command.slice(0, 200)}”`,
      target: { action: "shell", arguments: { command, working_directory: o.workspace, surface: "isolated_box", description: input.description ?? null, background: false, timeout: input.timeout ?? null }, enrichment: null },
    };
  }
  if (name === "Read" || name === "Glob" || name === "Grep") {
    const p = input.file_path ?? input.path;
    if (under(p, o.hostPrivate)) return deny(TEXT.protectedPath);
    if (walledPath(p)) return deny(TEXT.otherBotPrivate);
    if (walls && name !== "Read" && searchesWalled(walls, typeof p === "string" && p ? p : o.shellCwd ?? o.workspace)) return deny(TEXT.otherBotPrivate);
    return none(false);
  }
  if (name === "Edit" || name === "Write") {
    const p = String(input.file_path ?? "");
    // Bug 441: a write is judged by where the file REALLY is: a link in the workspace (to the file, or in any folder
    // on its way) that leads outside it is a write outside it.
    const lex = p ? path.resolve(o.workspace, p) : "";
    const real = lex ? realBoxPath(lex) : "";
    if (under(p, o.hostPrivate) || (real && (inside(real, o.hostPrivate) || inside(real, realOr(o.hostPrivate))))) return deny(TEXT.protectedPath);
    if (walledPath(p) || (real && real !== lex && walledPath(real))) return deny(TEXT.otherBotPrivate);
    // D9-A: workspace writes are ordinary Bot work, except git control files (item 1c ruling: reviewed, F8 floor).
    const inWs = !!real && (inside(real, o.workspace) || inside(real, realOr(o.workspace)));
    if (under(p, o.workspace) && inWs && !GIT_CONTROL_PATH.test(lex) && !GIT_CONTROL_PATH.test(real)) return none(true);
    return { surface: "box_shell", sideEffect: true, hardDeny: null, command: `${name.toLowerCase()} ${p}`, summary: `Write the file ${p}`, target: { action: "write_file", arguments: { path: p, tool: name }, enrichment: null } };
  }
  if (name === "WebFetch" || name === "WebSearch" || name === "TodoWrite" || name === "Skill") return none(false);
  // Lazy tools: a lookup only loads a deferred tool's schema; calling that tool is classified on its own.
  if (name === "ToolSearch") return none(false);
  if (name === "mcp__bot__SendMessage") return none(false);

  const on = ` on ${COMPUTER_NAME}`;
  const lc = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
  if (name === "mcp__bot__Shell") {
    const command = String(input.command ?? "");
    if (UI_AUTOMATION.test(command)) return deny(TEXT.uiAutomation);
    if (command.includes(o.hostPrivate)) return deny(TEXT.protectedPath);
    // I2: the real cwd (working_directory ?? lastCwd ?? workspace, resolved by the gate) is part of the target.
    const wd = input.working_directory;
    const cwd = o.shellCwd ?? (typeof wd === "string" && wd.trim() ? path.resolve(o.workspace, wd) : o.workspace);
    if (insideDir(o.workspace, cwd, o.hostPrivate) || insideDir(o.workspace, cwd, realOr(o.hostPrivate))) return deny(TEXT.protectedPath);
    if (walledText(command) || (walls && privateToAnother(walls, o.botId, cwd))) return deny(TEXT.otherBotPrivate);
    const background = Number(input.block_until_ms ?? 30_000) === 0;
    return {
      surface: "box_shell", sideEffect: true, hardDeny: null, command, summary: `Run “${command.slice(0, 200)}”`,
      target: { action: "shell", arguments: { command, working_directory: cwd, surface: "isolated_box", description: input.description ?? null, background, timeout: input.block_until_ms ?? null }, enrichment: null },
    };
  }
  if (name === "mcp__bot__Task") {
    const title = String(input.description ?? "").slice(0, 80);
    const prompt = String(input.prompt ?? "");
    return {
      surface: "subagent", sideEffect: true, hardDeny: null, command: prompt.slice(0, 4000), summary: `Run a task${on}: “${title}”`,
      target: { action: "subagent", arguments: { prompt, type: String(input.subagent_type ?? "generalPurpose") }, enrichment: null },
    };
  }
  if (["mcp__bot__Screenshot", "mcp__bot__AwaitShell", "mcp__bot__CheckSubagent", "mcp__bot__request_box_help"].includes(name)) return none(false);
  if (name === "mcp__bot__MessageSubagent" || name === "mcp__bot__StopSubagent") return none(true);
  if (name === "mcp__computer__Computer") {
    const a = input as unknown as ComputerStep & { then?: ComputerStep[] };
    // Enforce-mode rule checked before review so no card is raised for an action the tool would reject (BRW-03).
    if ((o.enforce ?? true) && (a.action === "click" || a.action === "drag") && !a.description?.trim()) return deny(STRC.needsDescription);
    const reviewed = REVIEWED_COMPUTER_ACTIONS.has(a.action) || (a.then ?? []).some((s) => REVIEWED_COMPUTER_ACTIONS.has(s.action));
    if (!reviewed) return none(a.action !== "screenshot" && a.action !== "wait");
    const purpose = a.description ? ` to ${lc(a.description.trim())}` : "";
    const summary =
      a.action === "click" ? `Click at (${a.x}, ${a.y})${on}${purpose}`
      : a.action === "drag" ? `Drag from (${a.x}, ${a.y}) to (${a.x2 ?? a.path?.at(-1)?.x}, ${a.y2 ?? a.path?.at(-1)?.y})${on}${purpose}`
      : a.action === "type" ? `Type “${String(a.text).slice(0, 80)}”${on}`
      : a.action === "key" ? `Press ${a.key}${on}`
      : `Use the computer${on}${purpose}`;
    return {
      surface: "computer", sideEffect: true, hardDeny: null, command: JSON.stringify(input).slice(0, 4000), summary,
      target: { action: "computer", arguments: { action_kind: a.action, coordinates: a.x !== undefined ? [a.x, a.y] : null, text: a.text ?? null, key: a.key ?? null, declared_purpose: a.description ?? null, then: a.then?.map((s) => s.action) ?? [] }, enrichment: null },
    };
  }
  // "Computer perception: Live (beta)": Look/Screenshot only read; Act is reviewed like Computer's click/type/key/drag.
  if (name === "mcp__computer__Look" || name === "mcp__computer__Screenshot") return none(false);
  if (name === "mcp__computer__Act") {
    const kind = String(input.do ?? "");
    if (kind === "hover" || kind === "scroll") return none(true);
    const point = (t: unknown): [number, number] | null => { const m = /^(\d+)\s*,\s*(\d+)$/.exec(String(t ?? "").trim()); return m ? [Number(m[1]), Number(m[2])] : null; };
    const ref = (t: unknown): string => {
      const p = point(t);
      if (p) return `at (${p[0]}, ${p[1]})`;
      const id = String(t ?? "").trim();
      const l = elementLabel(o.botId, id);
      return l ? `${id} (${l})` : id;
    };
    const text = String(input.text ?? "");
    const target = input.on === undefined ? "" : ` ${ref(input.on)}`;
    const summary =
      kind === "click" ? `Click${target}${on}`
      : kind === "double" ? `Double-click${target}${on}`
      : kind === "right" ? `Right-click${target}${on}`
      : kind === "type" ? `Type “${text.slice(0, 80)}”${input.on === undefined ? "" : ` into ${ref(input.on)}`}${on}`
      : kind === "key" ? `Press ${text}${on}`
      : kind === "select" ? `Choose “${text.slice(0, 80)}” in${target}${on}`
      : kind === "upload" ? `Attach ${text.slice(0, 200)}${input.on === undefined ? "" : ` with ${ref(input.on)}`}${on}`
      : kind === "drag" ? `Drag${target} to ${ref(input.to)}${on}`
      : `Use the computer${on}`;
    return {
      surface: "computer", sideEffect: true, hardDeny: null, command: `Act(${JSON.stringify(input)})`.slice(0, 4000), summary,
      target: { action: "computer", arguments: { action_kind: kind, coordinates: point(input.on), element: input.on ?? null, text: kind === "key" ? null : (input.text ?? null), key: kind === "key" ? text : null, to: input.to ?? null }, enrichment: null },
    };
  }
  if (name.startsWith("mcp__computer__browser_")) {
    const tool = name.slice("mcp__computer__".length);
    if (BROWSER_UNREVIEWED.has(tool)) return none(false);
    if (tool === "browser_tabs" && input.action !== "new" && input.action !== "close") return none(true);
    const el = String(input.element ?? input.ref ?? "");
    const summary =
      tool === "browser_navigate" ? `Open ${String(input.url)} in the browser${on}`
      : tool === "browser_click" ? `Click “${el}” in the browser${on}`
      : tool === "browser_mouse_click_xy" ? `Click at (${input.x}, ${input.y}) in the browser${on}`
      : tool === "browser_type" ? `Type “${String(input.text ?? "").slice(0, 80)}” into ${el} in the browser${on}`
      : tool === "browser_fill" ? `Fill ${el} with “${String(input.value ?? "").slice(0, 80)}” in the browser${on}`
      : tool === "browser_select_option" ? `Choose ${(input.values as string[] | undefined)?.join(", ")} in ${el} in the browser${on}`
      : tool === "browser_press_key" ? `Press ${String(input.key)} in the browser${on}`
      : tool === "browser_drag" ? `Drag ${String(input.startRef)} to ${String(input.endRef)} in the browser${on}`
      : tool === "browser_cdp" ? `Run the browser command ${String(input.method)}${on}`
      : input.action === "new" ? `Open a new browser tab${input.url ? ` at ${String(input.url)}` : ""}${on}`
      : `Close browser tab ${String(input.index)}${on}`;
    return {
      surface: "computer", sideEffect: true, hardDeny: null, command: `${tool}(${JSON.stringify(input)})`.slice(0, 4000), summary,
      target: { action: "browser", arguments: { tool, ...input }, enrichment: null },
    };
  }

  // Item 7 ruling: a Bot may configure other Bots, but a change to another Bot's description (its standing
  // instructions) is shown to the user as a card. Its own description is refused by the tool itself (I7).
  if (name === "mcp__bot__UpdateAgent" && typeof input.description === "string" && input.description.trim() && String(input.agent_id) !== o.botId) {
    const agent = String(input.agent_id);
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `UpdateAgent(${JSON.stringify(input)})`.slice(0, 4000),
      // Final secfix item 9: a model change in the same call is shown too (and is part of the fingerprint).
      summary: `Change another Bot's standing instructions to “${input.description.slice(0, 160)}”${input.model !== undefined && input.model !== null ? ` and its model to ${String(input.model)}` : ""}`,
      target: { action: "update_agent", arguments: { agent_id: agent, name: input.name ?? null, description: input.description, ...(input.model !== undefined && input.model !== null ? { model: String(input.model) } : {}) }, enrichment: null },
    };
  }
  // I1: a Bot creating a Bot with standing instructions is the same ownership gate as UpdateAgent (always a card).
  if (name === "mcp__bot__CreateAgent" && typeof input.description === "string" && input.description.trim()) {
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `CreateAgent(${JSON.stringify(input)})`.slice(0, 4000),
      summary: `Create the Bot “${String(input.name ?? "")}” with the standing instructions “${input.description.slice(0, 160)}”`,
      target: { action: "create_agent", arguments: { name: input.name ?? null, description: input.description }, enrichment: null },
    };
  }
  // I1: changing another Bot's model is a reviewed control-plane change.
  if (name === "mcp__bot__UpdateAgent" && input.model !== undefined && input.model !== null && String(input.agent_id) !== o.botId) {
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `UpdateAgent(${JSON.stringify(input)})`.slice(0, 4000),
      summary: `Change another Bot's model to ${String(input.model)}`,
      target: { action: "update_agent_model", arguments: { agent_id: String(input.agent_id), model: String(input.model) }, enrichment: null },
    };
  }
  if (name === "mcp__bot__update_state" && input.target === "routine" && ["create", "update", "resume"].includes(String(input.action))) {
    const routine = String(input.name ?? input.id ?? "routine");
    const when = input.schedule !== undefined && input.schedule !== null ? String(input.schedule) : input.trigger !== undefined && input.trigger !== null ? `on ${Object.keys(input.trigger as object)[0] ?? "a trigger"} events` : "its saved schedule";
    const prompt = String(input.prompt ?? "").replace(/\s+/g, " ").slice(0, 200);
    const state = input.enabled === false ? "paused" : "active";
    return {
      surface: "automation_write", sideEffect: true, hardDeny: null,
      command: `routine ${String(input.action)} ${routine}: ${when}`.slice(0, 4000),
      summary: `Save the routine “${routine}” (${state}) to run ${when}: “${prompt}”`,
      target: { action: "automation_write", arguments: { action: input.action, id: input.id ?? null, name: input.name ?? null, schedule: input.schedule ?? null, trigger: input.trigger ?? null, prompt: input.prompt ?? null, enabled: input.enabled ?? null }, enrichment: null },
    };
  }
  // Minor ruling: the account time zone moves every routine's schedule, so a Bot's change is reviewed.
  if (name === "mcp__bot__update_state" && input.target === "account_settings" && input.user_time_zone !== undefined) {
    const tz = String(input.user_time_zone);
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `account_settings user_time_zone=${tz}`.slice(0, 4000),
      summary: `Change the account time zone to ${tz} (every routine's schedule follows it)`,
      target: { action: "account_settings", arguments: { user_time_zone: tz }, enrichment: null },
    };
  }
  // C1: a Bot asking for a routine run is reviewed like a routine write (never unreviewed, never bypassGate).
  if (name === "mcp__bot__update_state" && input.target === "routine" && input.action === "run") {
    const id = String(input.id ?? "");
    return {
      surface: "automation_write", sideEffect: true, hardDeny: null, command: `routine run ${id}`.slice(0, 4000),
      summary: `Run the routine “${id}” now (it does real work)`,
      target: { action: "automation_write", arguments: { action: "run", id }, enrichment: null },
    };
  }
  if (name === "mcp__bot__DeleteAgent") {
    const agentId = String(input.agent_id ?? "");
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `DeleteAgent ${agentId}`,
      summary: `Delete the Bot ${agentId} and its conversation and routines`,
      target: { action: "delete_agent", arguments: { agent_id: agentId }, enrichment: null },
    };
  }
  if (name === "mcp__bot__CodingAgent") {
    const action = String(input.action ?? "");
    if (["list", "get", "dump"].includes(action)) return none(false);
    const text = action === "launch" ? `launch a coding agent on ${String(input.repo ?? "")}: ${String(input.task ?? "")}` : action === "reply" ? `reply to coding agent ${String(input.agent_id ?? "")}: ${String(input.message ?? "")}` : `${action} coding agent ${String(input.agent_id ?? "")}`;
    return {
      surface: "cloud_agent", sideEffect: true, hardDeny: null, command: text.slice(0, 4000), summary: text.slice(0, 500),
      target: { action: `coding_agent_${action}`, arguments: { ...input }, enrichment: null },
    };
  }
  if (name === "mcp__bot__Browser") {
    // mac-browser: a browser window on the user's Mac. Reads take the fast path (sideEffect false); anything that
    // changes a page is reviewed. Typed text never enters the target (the bind target shows length + hash).
    const act = String(input.action ?? "");
    const b = { action: act, ...(typeof input.url === "string" ? { url: input.url } : {}), ...(typeof input.ref === "string" ? { ref: input.ref } : {}), ...(typeof input.value === "string" ? { value: input.value } : {}), ...(typeof input.text === "string" ? { text: input.text } : {}), ...(input.submit === true ? { submit: true } : {}) } as BrowserArgs;
    const command = browserBindTarget(b);
    const { text: _typed, ...shown } = b;
    return {
      surface: "host_shell", sideEffect: !browserReadOnly(b), hardDeny: null, command, summary: `In the browser on your computer: ${command.replace(/^browser /, "")}`.slice(0, 500),
      target: { action: "browser", arguments: { ...shown, ...(b.text !== undefined ? { typed: command.match(/‹[^›]*›/)?.[0] ?? "" } : {}), surface: "local_computer", tool: "Browser" }, enrichment: null },
    };
  }
  if (name === "mcp__bot__MacApp") {
    // mac-apps: an action in an app on the user's Mac. Reads and searches take the fast path; anything that
    // changes an app is reviewed. The typed body never enters the target (the bind shows length + hash).
    const m = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null)) as unknown as MacAppArgs;
    const command = macAppBindTarget(m);
    const { text: _typed, ...shown } = m;
    return {
      surface: "host_shell", sideEffect: !macAppReadOnly(m), hardDeny: null, command, summary: macAppSummary(m).slice(0, 500),
      target: { action: "mac-app", arguments: { ...shown, ...(m.text !== undefined ? { typed: command.match(/‹[^›]*›/)?.[0] ?? "" } : {}), surface: "local_computer", tool: "MacApp" }, enrichment: null },
    };
  }
  if (name === "mcp__bot__Mac") {
    // feat-mac-access-parity: one Mac file tool with an action enum (read/write/edit/glob/grep).
    const act = String(input.action ?? "");
    const p = String(input.path ?? "");
    const command = act === "read" ? `read ${p}` : act === "write" ? `write ${p}` : act === "edit" ? `edit ${p}` : act === "glob" ? `glob ${String(input.pattern ?? "")}` : `grep ${String(input.pattern ?? "")}`;
    return {
      surface: "host_shell", sideEffect: act === "write" || act === "edit", hardDeny: null, command: command.slice(0, 4000), summary: `On your computer: ${command.slice(0, 200)}`,
      target: { action: "shell", arguments: { command, working_directory: "~", surface: "local_computer", tool: "Mac", mac_action: act, path: p }, enrichment: null },
    };
  }
  if (name === "mcp__bot__ExternalShell" || name === "mcp__bot__ExternalRead" || name === "mcp__bot__CopyToBox" || name === "mcp__bot__CopyFromBox") {
    const command = name === "mcp__bot__ExternalShell" ? String(input.command ?? "")
      : name === "mcp__bot__ExternalRead" ? `cat ${String(input.path ?? "")}`
      : name === "mcp__bot__CopyToBox" ? `copy ${String(input.local_path ?? "")} to ${COMPUTER_NAME}: ${String(input.box_path ?? "")}` // I2: box_path is part of the target
      : `copy ${String(input.box_path ?? "")} to ${String(input.local_path ?? "")}`;
    // Bug 142: a Messages send's card (read aloud on a call) says who gets what, word for word.
    const sms = name === "mcp__bot__ExternalShell" ? messagesSend(command) : null;
    return {
      surface: "host_shell", sideEffect: true, hardDeny: null, command: command.slice(0, 4000), summary: sms ? messagesSendSummary(sms) : `On your computer: ${command.slice(0, 200)}`,
      target: { action: "shell", arguments: { command, working_directory: input.cwd ?? "~", surface: "local_computer", tool: name.replace("mcp__bot__", ""), ...(input.box_path !== undefined ? { box_path: input.box_path, local_path: input.local_path ?? null } : {}) }, enrichment: null },
    };
  }
  // PLG-07: installs that add a local process get a deterministic card (host/review/force-ask.ts)
  if (name === "mcp__bot__AddMcpServer" && typeof input.command === "string" && input.command.trim()) {
    const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: [input.command, ...args].join(" ").slice(0, 4000),
      summary: `Add the local MCP server “${String(input.name ?? "")}” (${String(input.command)})`,
      target: { action: "install_local_mcp_server", arguments: { name: input.name ?? null, command: input.command, args }, enrichment: null },
    };
  }
  if (name === "mcp__bot__InstallPlugin") {
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `install ${String(input.plugin_id ?? "")}`,
      summary: `Install the plugin ${String(input.plugin_id ?? "")}`,
      target: { action: "install_plugin", arguments: { plugin_id: input.plugin_id ?? null }, enrichment: null },
    };
  }
  // P5 review I11: packaging ANOTHER Bot as a template reads its memories and skills → an ownership card.
  if (name === "mcp__bot__Template" && String(input.agent_id ?? "") !== o.botId) {
    return { surface: "control_plane", sideEffect: true, hardDeny: null, command: `Template ${String(input.action ?? "")} ${String(input.agent_id ?? "")}`, summary: `Package another Bot (${String(input.agent_id ?? "")}) as a template`, target: { action: "template_other_bot", arguments: { action: input.action ?? null, agent_id: input.agent_id ?? null }, enrichment: null } };
  }
  // P5 review I5/C3: the plugin/MCP admin tools are control_plane (reviewed); see ownership.ts for the ones that always ask.
  const admin = pluginAdminTarget(name, input);
  if (admin) return { surface: "control_plane", sideEffect: true, hardDeny: null, command: admin.command.slice(0, 4000), summary: admin.summary.slice(0, 500), target: { action: admin.action, arguments: admin.args, enrichment: null } };
  if (name === "mcp__bot__SaveGoogleClient" && o.googleClientReplace) {
    const { clientId: id, replace } = o.googleClientReplace;
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: `SaveGoogleClient ${id}`,
      summary: replace
        ? `Replace your connected Google client with ${id} (this signs Google out until you connect again)`
        : `Save the Google client ${id} that the Bot read from Google Cloud. Check it matches the Client ID in your console.`,
      target: { action: "replace_google_client", arguments: { client_id: id, replace }, enrichment: null },
    };
  }
  // Smarter approvals: a plan is always the owner's own card (approval-gate.ts); the gate checks and parses it.
  if (name === "mcp__bot__ProposePlan") {
    return {
      surface: "control_plane", sideEffect: true, hardDeny: null, command: JSON.stringify(input).slice(0, 4000),
      summary: `Approve plan: ${String(input.title ?? "").slice(0, 120)}`,
      target: { action: "approve_plan", arguments: { title: input.title ?? null, steps: input.steps ?? null }, enrichment: null },
    };
  }
  if (name.startsWith("mcp__bot__")) return none(true);
  if (name.startsWith("mcp__google__") && o.googleBuiltin === true) {
    const g = classifyGoogle(name.slice("mcp__google__".length), input, o.googleEmail);
    if (g) return g;
  }
  if (name.startsWith(`mcp__${COMPOSIO_SERVER_ID}__`) && o.composioBuiltin === true) return classifyComposio(name.slice(`mcp__${COMPOSIO_SERVER_ID}__`.length), input);
  if (name.startsWith("mcp__")) {
    const [, rawServer = "", ...rest] = name.split("__");
    const server = rawServer.replace(/^claude_ai_/, "");
    const tool = rest.join("__");
    // Bug 403: a custom MCP server on a Composio host (the retired "Composio" preset) is Composio: the same fixed
    // read list, and every other tool a composio_write card — never the reviewer's or the trust flag's call.
    if (isComposioHost(o.mcpServerHost?.(rawServer)) || o.mcpServerComposio?.(rawServer) === true || looksLikeComposioSlug(tool)) return classifyComposio(tool, input);
    // P5 review I6: name matching only for curated/claude.ai/trusted servers (mcp/registry.ts mcpReadOnly); default reviewed.
    if (o.mcpReadOnly ? o.mcpReadOnly(rawServer, tool) : rawServer.startsWith("claude_ai_") && READ_ONLY_MCP.test(tool)) return none(false);
    const args = JSON.stringify(input).slice(0, 300);
    return {
      surface: "mcp", sideEffect: true, hardDeny: null, command: `${server}.${tool}(${JSON.stringify(input)})`.slice(0, 4000),
      summary: `Use ${server.replace(/_/g, " ")} tool ${tool} with ${args}`,
      target: { action: "mcp", arguments: { server, tool, arguments: input }, enrichment: null },
    };
  }
  return none(true);
}

function pluginAdminTarget(name: string, input: Record<string, unknown>): { action: string; command: string; summary: string; args: Record<string, unknown> } | null {
  const str = (v: unknown) => String(v ?? "");
  switch (name) {
    case "mcp__bot__AddMcpServer":
      return { action: "add_mcp_server", command: `add MCP server ${str(input.name)} ${str(input.url)}`, summary: `Add the MCP server “${str(input.name)}” (${str(input.url)}) for every Bot`, args: { name: input.name ?? null, url: input.url ?? null, headers: input.headers ? Object.keys(input.headers as object) : [] } };
    case "mcp__bot__UninstallPlugin":
      return { action: "uninstall_plugin", command: `uninstall ${str(input.plugin_id)}`, summary: `Uninstall the plugin ${str(input.plugin_id)} for every Bot`, args: { plugin_id: input.plugin_id ?? null } };
    case "mcp__bot__SetMcpToolEnabled": {
      const on = input.enabled === true;
      return { action: on ? "enable_mcp_tool" : "disable_mcp_tool", command: `${on ? "enable" : "disable"} ${str(input.server)}.${str(input.tool)}`, summary: `Turn ${on ? "on" : "off"} the connector tool ${str(input.tool)} (${str(input.server)}) for every Bot`, args: { server: input.server ?? null, tool: input.tool ?? null, enabled: on } };
    }
    case "mcp__bot__RemoveMcpAccount":
    case "mcp__bot__UninstallMcpServer":
      return { action: "remove_mcp_server", command: `remove MCP server ${str(input.server_id)}`, summary: `Remove the connector ${str(input.server_id)} for every Bot`, args: { server_id: input.server_id ?? null } };
    case "mcp__bot__RenameMcpAccount":
      return { action: "rename_mcp_account", command: `rename ${str(input.server_id)} to ${str(input.label)}`, summary: `Label the connector account ${str(input.server_id)} “${str(input.label)}”`, args: { server_id: input.server_id ?? null, label: input.label ?? null } };
    case "mcp__bot__RestartMcpServers":
      return { action: "restart_mcp_servers", command: `restart ${str(input.server_id) || "all connectors"}`, summary: `Reconnect ${str(input.server_id) || "every connector"}`, args: { server_id: input.server_id ?? null } };
    case "mcp__bot__SetMcpInstructions":
      return { action: "set_mcp_instructions", command: `SetMcpInstructions(${JSON.stringify(input)})`, summary: `Give every Bot these instructions for ${str(input.server_id)}: “${str(input.instructions).slice(0, 300)}”`, args: { server_id: input.server_id ?? null, instructions: input.instructions ?? null } };
    default:
      return null;
  }
}
