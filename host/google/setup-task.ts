import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GOOGLE_CLIENT_ID_PLACEHOLDER, GOOGLE_CLIENT_ID_RE, GOOGLE_CLIENT_SECRET_RE, GOOGLE_SECRET_PLACEHOLDER, STRGS,
  googleSetupTaskPrompt, isGoogleClientPage, type BrowserArgs, type GoogleSetupMode, type GoogleSetupTaskView,
} from "@synapse/shared";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import { log } from "../util/log";

/** A task the user started and walked away from ends on its own. */
export const SETUP_TASK_TTL_MS = 2 * 3_600_000;
export const SAVE_GOOGLE_CLIENT = "SaveGoogleClient";

export { isGoogleClientPage };

/** Any Bot's browser output: a Google client secret on a page never reaches a model, whatever the task. */
export const scrubGoogleClientSecrets = (text: string): string => text.replace(GOOGLE_CLIENT_SECRET_RE, GOOGLE_SECRET_PLACEHOLDER);

export interface GoogleSetupDeps {
  now(): number;
  botName(botId: string): string | null;
  /** The task's opening message, shown in the Bot's chat as the user's request (the user pressed Start). */
  sendPrompt(botId: string, text: string, clientNonce: string): void;
  /** The existing setGoogleClient path (validation, token reset, publish). Throws a GatewayError on bad values. */
  setClient(clientId: string, clientSecret: string): void;
  onChange(): void;
}

interface Task { botId: string; mode: GoogleSetupMode; startedAt: number; clientSaved: boolean; captured: { clientId?: string; clientSecret?: string }; ambiguous?: boolean }

/**
 * google-setup "Let a Bot do it": at most one guided task, started by the user for one Bot.
 *
 * The Client ID and secret never pass through the model, the chat or the transcript: while the task runs, the Bot's
 * Browser output is read here first, host-side, and any client ID / client secret on the page is captured and
 * replaced by a placeholder before the Bot sees it. SaveGoogleClient takes no values; it stores what was captured
 * through the same path as the sheet's own Save (setGoogleClient). Outside the task the tool doesn't exist, and a
 * warm session that still lists it gets a refusal. Every Bot's browser output loses client secrets either way.
 */
export class GoogleSetupTasks {
  private task: Task | null = null;
  private secretFns = new Set<() => void>();

  /** A new value was captured: the secret scanner re-reads secrets() at once. */
  onSecrets(fn: () => void): void { this.secretFns.add(fn); }

  constructor(private d: GoogleSetupDeps) {}

  view(): GoogleSetupTaskView | null {
    const t = this.live();
    return t ? { botId: t.botId, botName: this.d.botName(t.botId) ?? "Bot", mode: t.mode, startedAt: t.startedAt, clientSaved: t.clientSaved } : null;
  }

  private live(): Task | null {
    if (this.task && (this.d.now() - this.task.startedAt > SETUP_TASK_TTL_MS || this.d.botName(this.task.botId) === null)) { this.task = null; this.d.onChange(); }
    return this.task;
  }

  /** The setup task (mode "setup") is running for this Bot: the only time SaveGoogleClient exists. */
  active(botId: string, mode?: GoogleSetupMode): boolean {
    const t = this.live();
    return !!t && t.botId === botId && (!mode || t.mode === mode);
  }

  start(botId: string, mode: GoogleSetupMode, o: { projectId?: string | null } = {}): GoogleSetupTaskView {
    if (this.d.botName(botId) === null) throw new GatewayError("NOT_FOUND", "That Bot doesn't exist.");
    if (mode !== "setup" && mode !== "reconnect") throw new GatewayError("BAD_ARGS", "Unknown Google setup mode.");
    this.task = { botId, mode, startedAt: this.d.now(), clientSaved: false, captured: {} };
    this.d.onChange();
    this.d.sendPrompt(botId, googleSetupTaskPrompt(mode, o), `google-setup-${randomUUID()}`);
    return this.view()!;
  }

  /** Stop from the sheet, or the account connected (the task's goal). */
  end(): void {
    if (!this.task) return;
    this.task = null;
    this.d.onChange();
  }

  /** Before a Browser action: during the task a screenshot could carry the secret as pixels. */
  refuseBrowser(botId: string, args: Pick<BrowserArgs, "action">): string | null {
    return args.action === "screenshot" && this.active(botId) ? STRGS.noScreenshots : null;
  }

  /**
   * After a Browser action, before the Bot sees the page: capture (task Bot only) and scrub. `url` is the page the
   * Mac read (BrowserReply.url, the live address at read time). Security fix 1: a pair is captured only off Google
   * Cloud's own client pages, and only when the ID and the secret are in the SAME read, so a page the Bot opened
   * elsewhere (evil.example with both shapes on it) can't plant a client, and two reads can't be stitched together.
   */
  browserText(botId: string, text: string, url = "", editable?: string[]): string {
    if (!this.active(botId, "setup")) return scrubGoogleClientSecrets(text);
    const t = this.task!;
    // Re-review 1: only page text a Bot can't have typed. A value the Mac found in an input, textarea, contenteditable
    // or textbox is never a candidate, and a reply without that report (a failed read, an older Mac) captures nothing.
    const typed = new Set(Array.isArray(editable) ? editable : []);
    const fixed = (m: RegExpMatchArray | null) => (Array.isArray(editable) ? (m ?? []).filter((v) => !typed.has(v)) : []);
    const secrets = fixed(text.match(GOOGLE_CLIENT_SECRET_RE));
    const ids = fixed(text.match(GOOGLE_CLIENT_ID_RE));
    // One client per dialog: the last value on the page is the one just created.
    const clean = scrubGoogleClientSecrets(text).replace(GOOGLE_CLIENT_ID_RE, GOOGLE_CLIENT_ID_PLACEHOLDER);
    if (!isGoogleClientPage(url)) return clean;
    // Final hardening: exactly one client per read. A second ID or secret anywhere on the page (a client list, a
    // planted name) makes the read ambiguous: nothing is kept, an earlier capture is dropped, and the Bot is told to
    // open the new client's own page (its details page or the "OAuth client created" dialog shows one pair).
    if (new Set(ids).size > 1 || new Set(secrets).size > 1) {
      t.captured = {};
      t.ambiguous = true;
      return `${clean}\n${STRGS.multiClient}`;
    }
    const secret = secrets[0];
    const id = ids[0];
    if (secret && id && (secret !== t.captured.clientSecret || id !== t.captured.clientId)) {
      t.captured = { clientId: id, clientSecret: secret };
      t.ambiguous = false;
      for (const fn of this.secretFns) fn();
    }
    return clean;
  }

  /**
   * Security fix 1 + re-review: a client a Bot read is always the user's call — over a WORKING connection (saving signs
   * the account out) and on a first save (the user checks the ID against the console). The card names the captured
   * client ID, never the secret; null when the save would refuse anyway (no task, nothing captured).
   */
  cardFor(botId: string, connected: boolean): { clientId: string; replace: boolean } | null {
    const c = this.active(botId, "setup") ? this.task!.captured : null;
    return c?.clientId && c.clientSecret ? { clientId: c.clientId, replace: connected } : null;
  }

  /** For the secret scanner: a captured secret is redacted everywhere the moment it exists (transcript, logs, memory). */
  secrets(): { name: string; value: string }[] {
    const v = this.task?.captured.clientSecret;
    return v ? [{ name: "GOOGLE_CLIENT_SECRET", value: v }] : [];
  }

  private save(botId: string): BotToolResult {
    if (!this.active(botId, "setup")) return { text: STRGS.saveNotTask, isError: true };
    const t = this.task!;
    const { clientId, clientSecret } = t.captured;
    if (!clientId || !clientSecret) return { text: t.ambiguous ? STRGS.multiClient : STRGS.saveNoClient, isError: true };
    try {
      this.d.setClient(clientId, clientSecret);
    } catch (e) {
      // setClient's own messages name no value; anything else is cut to its first line, never echoed with input.
      return { text: e instanceof GatewayError ? e.message : "Couldn't save the Google client.", isError: true };
    }
    t.clientSaved = true;
    log.info("google-setup: client saved from the setup task");
    this.d.onChange();
    return { text: STRGS.saveDone };
  }

  /** The Bot's one extra tool, only for the Bot running the setup task. */
  toolsFor(botId: string): BotToolDef[] {
    if (!this.active(botId, "setup")) return [];
    return [{
      name: SAVE_GOOGLE_CLIENT, description: STRGS.saveTool, readOnly: false,
      // No inputs at all: nothing the Bot could put here is a secret, and nothing is echoed back.
      schema: {} satisfies Record<string, z.ZodTypeAny>,
      handler: async () => this.save(botId),
    }];
  }
}
