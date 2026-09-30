import { BROWSER_PERMISSION_PREFIX, LIMITS5, MACAPP_PERMISSION_PREFIX, LOCAL_NEEDS_APPROVAL, NO_LIMITS_CONFIRM, STR5, type BrowserArgs, type BrowserReply, type MacAppArgs, type MacAppReply, type LocalAction, type LocalAskChoice, type LocalExecRequest, type PermMode, type SseEvent } from "@synapse/shared";
import type { LocalExecutor } from "./executor";
import { bindHash, type LocalPolicyStore } from "./policy";

// The file/command card actions, whose answers go through the generic branch at the end of `intercept`.
// "browser" and "mac-app" are absent on purpose: each has its own branch above it, because their "Always"
// means something different (a per-Bot permission, or a site rule) than a file action's does.
const ACTIONS: LocalAction[] = ["run-command", "send-input", "read-file", "list-directory", "write-file", "edit-file", "glob", "grep"];

type Call = (cmd: string, args: unknown) => Promise<unknown>;

/** mac-browser: one Browser action as the app's controller (main process) takes it, after this Mac's own gate. */
/** full-auto-quiet: `mode` is the Bot's permission mode on THIS Mac; the controller applies the five-category
 *  policy to the live page with it (a "Save changes" is not one of the five; "Pay now" is). */
export interface BrowserCall { botId: string; botName: string; args: BrowserArgs; approved: boolean; origins: string[]; explicit: boolean; turn?: string; userTurn?: boolean; mode?: PermMode }
export type BrowserResult = { ok: true; reply: BrowserReply } | { ok: false; error: string; needsApproval?: boolean };

/** mac-apps: one MacApp action as the app's controller (main process) takes it, after this Mac's own gate. */
export interface MacAppCallMsg { botId: string; botName: string; args: MacAppArgs; approved: boolean }
export type MacAppResultMsg = { ok: true; reply: MacAppReply } | { ok: false; error: string; needsApproval?: boolean; summary?: string };

export class LocalExecDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Every execId this process has taken. The host re-offers a running request on every heartbeat,
   *  so this is what tells a re-offer apart from a request a previous run of the app took to its
   *  grave — the latter must be answered or the Bot's tool call blocks for the host's lifetime. */
  private taken = new Set<string>();

  constructor(private d: {
    call: Call; policy: LocalPolicyStore; executor: LocalExecutor; heartbeatMs?: number;
    /** mac-browser: the controller in the main process, and the site of a Bot's last consequential refusal. */
    browser?(c: BrowserCall): Promise<BrowserResult>;
    browserOrigin?(botId: string): Promise<string | null>;
    /** mac-apps: the controller in the main process. */
    macapp?(c: MacAppCallMsg): Promise<MacAppResultMsg>;
    /**
     * settings-persist / bug 225: false only when the profile's permission key file (local-policy.key) was tampered
     * with or can't be read, so nothing written this run could be trusted after a restart. A per-Bot switch then
     * refuses, visibly, and Settings offers Reset permissions.
     */
    durable?: boolean;
    /** bug 225: Reset permissions — a new key file and fresh policy files; the caller rebuilds the daemon. */
    resetPolicy?(): Promise<{ ok: boolean }>;
    /** Bug 258 (fix round): verify a per-dialog No limits nonce with main (single-use). Absent in tests: the constant is accepted. */
    verifyNoLimits?(nonce: string): Promise<boolean>;
  }) {}

  private get durable(): boolean { return this.d.durable !== false; }

  /** settings-persist (review ruling): a non-durable run can't GRANT (it could never be read back); taking away always works. */
  private requireDurableGrant(allowed: unknown): void {
    if (allowed === true && !this.durable) throw new Error(STR5.localPolicyKeyBroken);
  }

  /** settings-persist (review ruling): in a non-durable run a card's "Always" acts as "once" — no stored grant or rule. */
  private choiceOf(choice: LocalAskChoice): LocalAskChoice {
    return choice === "always" && !this.durable ? "once" : choice;
  }

  async start(): Promise<void> {
    await this.register();
    const beat = async () => {
      try {
        const r = (await this.d.call("localExecHeartbeat", { computerId: this.d.policy.current().computerId })) as { pending?: LocalExecRequest[]; register?: boolean };
        // Bug-log 129: a restarted host that doesn't know this Mac asks for it again (it used to wait for an app relaunch).
        if (r.register) await this.register();
        for (const req of r.pending ?? []) void this.handle(req);
      } catch { /* host unreachable; the host's liveness check reports LOC-06 */ }
    };
    this.timer = setInterval(() => void beat(), this.d.heartbeatMs ?? LIMITS5.localHeartbeatMs);
    void beat();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(e: SseEvent): void {
    if (e.channel === "local-exec") void this.handle(e.payload);
  }

  /** Coordinator-side commands and the LOC-05 approval record. Returns handled:false for everything else. */
  async intercept(cmd: string, args: unknown): Promise<{ handled: true; result: unknown } | { handled: false }> {
    if (cmd === "getLocalPolicyStatus") return { handled: true, result: this.durable ? { ok: true } : { ok: false, reason: STR5.localPolicyKeyBroken } };
    if (cmd === "resetLocalPolicy") {
      // Bug 229: Reset permissions only ever replaces a key file that is broken or tampered with — never a sound one.
      if (this.durable || !this.d.resetPolicy) throw new Error(STR5.localPolicyResetRefused);
      return { handled: true, result: await this.d.resetPolicy() };
    }
    if (cmd === "getLocalComputer") return { handled: true, result: { computer: this.d.policy.current() } };
    if (cmd === "setLocalComputer") {
      const computer = this.d.policy.update(args as { label?: string });
      await this.register();
      return { handled: true, result: { computer } };
    }
    if (cmd === "setAgentPermMode") {
      // fix-mac-gate-and-approval-expiry (Bug A): the Mac keeps its OWN copy of each Bot's mode, taken from the user's
      // choice in this app on its way to the host (recorded only once the host accepted it). The Mac never reads the
      // mode from the host, so a compromised host can't grant itself Full auto (LOC-05).
      const a = args as { id?: unknown; mode?: unknown };
      const result = await this.d.call(cmd, args);
      if (typeof a.id === "string" && (a.mode === "ask" || a.mode === "accept-edits" || a.mode === "full-auto")) this.d.policy.setBotMode(a.id, a.mode);
      return { handled: true, result };
    }
    if (cmd === "setAgentNoLimits") {
      // Bug 258: No limits is written on this Mac ONLY from the app's own confirm dialog, which sends NO_LIMITS_CONFIRM.
      // Nothing the host sends (a claim, the adoption card, the restore prompt) reaches this record. Turning it off
      // never needs the confirm. The host is told first, as with setAgentPermMode; the Mac records once it accepted.
      const a = args as { id?: unknown; enabled?: unknown; confirm?: unknown };
      if (typeof a.id !== "string" || !a.id) throw new Error(STR5.noLimitsNeedsConfirm);
      const on = a.enabled === true;
      // Fix round: a per-dialog nonce main issued, checked once here; with no verifier wired (tests) the fixed constant
      // is accepted. Either way the host is forwarded the constant, so nothing a Bot could send turns No limits on.
      if (on) {
        const token = typeof a.confirm === "string" ? a.confirm : "";
        const ok = this.d.verifyNoLimits ? await this.d.verifyNoLimits(token) : token === NO_LIMITS_CONFIRM;
        if (!ok) throw new Error(STR5.noLimitsNeedsConfirm);
      }
      if (on && !this.durable) throw new Error(STR5.localPolicyKeyBroken);
      const result = await this.d.call(cmd, on ? { id: a.id, enabled: true, confirm: NO_LIMITS_CONFIRM } : { id: a.id, enabled: false });
      if (on) {
        this.d.policy.setBotMode(a.id, "full-auto");
        this.d.policy.setNoLimits(a.id, true);
      } else this.d.policy.setNoLimits(a.id, false);
      return { handled: true, result };
    }
    if (cmd === "getLocalPolicyReset") {
      // Bug 256: ONE prompt after a permission reset (or whenever a Bot's chosen mode isn't on this Mac) instead of a
      // silent card per command. The renderer sends the modes the user chose; the Mac answers which it lacks.
      const a = args as { bots?: unknown };
      const want = Array.isArray(a.bots) ? (a.bots as { id: string; mode: PermMode }[]) : [];
      return { handled: true, result: { reset: this.d.policy.resetNotice() !== null, missing: this.d.policy.missingModes(want) } };
    }
    if (cmd === "restoreLocalBotModes") {
      // Bug 256: the prompt's one button, answered in THIS app (the same trust as the adoption card or a settings
      // change): records each listed Bot's mode on this Mac. The host is never asked and can't send this (LOC-05).
      const a = args as { bots?: unknown };
      const want = Array.isArray(a.bots) ? (a.bots as { id: string; mode: PermMode }[]) : [];
      const todo = this.d.policy.missingModes(want);
      if (todo.length && !this.durable) throw new Error(STR5.localPolicyKeyBroken);
      for (const b of todo) this.d.policy.setBotMode(b.id, b.mode);
      this.d.policy.clearResetNotice();
      return { handled: true, result: { restored: todo.map((b) => b.id) } };
    }
    if (cmd === "dismissLocalPolicyReset") {
      // "Not now": the same record as the adoption card's "Keep asking", per Bot and mode value, so neither the banner
      // nor the adoption card returns until the user picks the mode in settings (setBotMode clears it).
      const a = args as { bots?: unknown };
      const want = Array.isArray(a.bots) ? (a.bots as { id: string; mode: PermMode }[]) : [];
      for (const b of this.d.policy.missingModes(want)) this.d.policy.declineMode(b.id, b.mode);
      this.d.policy.clearResetNotice();
      return { handled: true, result: {} };
    }
    if (cmd === "getLocalBotMode") {
      const a = args as { id?: unknown };
      return { handled: true, result: { mode: typeof a.id === "string" ? this.d.policy.botMode(a.id) : "ask" } };
    }
    if (cmd === "resolveLocalToolPermission" && ((args as { adopt?: unknown }).adopt === "full-auto" || (args as { adopt?: unknown }).adopt === "accept-edits")) {
      // fix-fullauto-adoption: the adoption card, answered in THIS app. Allow writes the Mac's own record through the same
      // path as a settings change; Keep asking records that choice for this mode value. The host only settles the card
      // and wakes the Bot: nothing it sends can write this record (LOC-05).
      const a = args as { id: string; askId: string; choice: LocalAskChoice; adopt: "full-auto" | "accept-edits" };
      if (a.choice === "once" || a.choice === "always") this.d.policy.setBotMode(a.id, a.adopt);
      else this.d.policy.declineMode(a.id, a.adopt);
      return { handled: true, result: await this.d.call(cmd, { id: a.id, askId: a.askId, choice: a.choice === "always" ? "once" : a.choice === "never" ? "deny" : a.choice }) };
    }
    if (cmd === "getLocalBrowserAllowed") {
      const a = args as { id?: unknown };
      return { handled: true, result: { allowed: typeof a.id === "string" && this.d.policy.granted(a.id, "browser") } };
    }
    if (cmd === "setLocalBrowserAllowed") {
      // mac-browser: "May use the browser on your Mac", per Bot, recorded on this Mac only (the host never can).
      const a = args as { id?: unknown; allowed?: unknown };
      if (typeof a.id !== "string") return { handled: true, result: { allowed: false } };
      this.requireDurableGrant(a.allowed);
      if (a.allowed === true) this.d.policy.grant(a.id, "browser"); else this.d.policy.revoke(a.id, "browser");
      return { handled: true, result: { allowed: this.d.policy.granted(a.id, "browser") } };
    }
    if (cmd === "getLocalMacAppAllowed") {
      const a = args as { id?: unknown };
      return { handled: true, result: { allowed: typeof a.id === "string" && this.d.policy.granted(a.id, "mac-app") } };
    }
    if (cmd === "setLocalMacAppAllowed") {
      // mac-apps: "May use the apps on your Mac", per Bot, recorded on this Mac only (the host never can).
      const a = args as { id?: unknown; allowed?: unknown };
      if (typeof a.id !== "string") return { handled: true, result: { allowed: false } };
      this.requireDurableGrant(a.allowed);
      if (a.allowed === true) this.d.policy.grant(a.id, "mac-app"); else this.d.policy.revoke(a.id, "mac-app");
      return { handled: true, result: { allowed: this.d.policy.granted(a.id, "mac-app") } };
    }
    if (cmd === "resolveLocalToolPermission" && (args as { action?: unknown }).action === "mac-app") {
      // mac-apps: Allow once = a one-time approval bound to exactly the card's call. Always, on the PERMISSION
      // card, turns this Bot's app permission on. On a consequential card (send, delete, spend, security) there
      // is no "Always": those ask every time, so an Always there is recorded as a one-time approval and no more.
      const raw = args as { id: string; askId: string; choice: LocalAskChoice; target?: string };
      const a = { ...raw, choice: this.choiceOf(raw.choice) };
      const target = typeof a.target === "string" ? a.target : "";
      if ((a.choice === "once" || a.choice === "always") && target) this.d.policy.recordApproval(a.askId, { botId: a.id, expiresAt: Date.now() + LIMITS5.localApprovalHygieneMs, bind: bindHash("mac-app", target) });
      if (a.choice === "always" && target.startsWith(MACAPP_PERMISSION_PREFIX)) this.d.policy.grant(a.id, "mac-app");
      return { handled: true, result: await this.d.call(cmd, { id: a.id, askId: a.askId, choice: a.choice === "never" ? "deny" : a.choice }) };
    }
    if (cmd === "resolveLocalToolPermission" && (args as { action?: unknown }).action === "browser") {
      // mac-browser: Allow once = a one-time approval bound to exactly the card's call. Always = on the permission card,
      // turn the Bot's browser permission on; on a consequential card, an always-allow rule for that site (this Bot).
      // "Never" here only declines: it never switches the whole Mac to Never allow.
      const raw = args as { id: string; askId: string; choice: LocalAskChoice; target?: string };
      const a = { ...raw, choice: this.choiceOf(raw.choice) };
      const target = typeof a.target === "string" ? a.target : "";
      if ((a.choice === "once" || a.choice === "always") && target) this.d.policy.recordApproval(a.askId, { botId: a.id, expiresAt: Date.now() + LIMITS5.localApprovalHygieneMs, bind: bindHash("browser", target) });
      if (a.choice === "always" && target.startsWith(BROWSER_PERMISSION_PREFIX)) this.d.policy.grant(a.id, "browser");
      else if (a.choice === "always") { const site = await this.d.browserOrigin?.(a.id).catch(() => null); if (site) this.d.policy.addBrowserOrigin(a.id, site); }
      return { handled: true, result: await this.d.call(cmd, { id: a.id, askId: a.askId, choice: a.choice === "never" ? "deny" : a.choice }) };
    }
    if (cmd === "resolveLocalToolPermission") {
      // The renderer passes the card's action and exact target: a once-approval is bound to hash(action + target),
      // and "Always" becomes a grant for this Bot + this action only (P5 review minors), never the whole Mac.
      const raw = args as { id: string; askId: string; choice: LocalAskChoice; action?: string; target?: string };
      const a = { ...raw, choice: this.choiceOf(raw.choice) };
      const action = ACTIONS.find((x) => x === a.action) ?? null;
      // Final secfix item 12: "Always" also records the once-approval for the answered call itself — the grant alone
      // no longer covers it unless it's statically read-only.
      // fix-mac-gate-and-approval-expiry (Bug B): the approval waits for the Bot to use it (a late answer wakes the Bot,
      // which may run it minutes later); it still works once, for this Bot and this exact command, and goes after 7 days.
      if ((a.choice === "once" || a.choice === "always") && action && typeof a.target === "string") this.d.policy.recordApproval(a.askId, { botId: a.id, expiresAt: Date.now() + LIMITS5.localApprovalHygieneMs, bind: bindHash(action, a.target) });
      if (a.choice === "always" && action) this.d.policy.grant(a.id, action);
      if (a.choice === "never") {
        this.d.policy.update({ executionPolicy: "never" });
        await this.register();
      }
      return { handled: true, result: await this.d.call(cmd, { id: a.id, askId: a.askId, choice: a.choice }) };
    }
    return { handled: false };
  }

  private register(): Promise<unknown> {
    return this.d.call("registerLocalComputer", { computer: this.d.policy.current() }).catch(() => null);
  }

  /** Every gateway call made while handling a request goes through here. `handle` is only ever
   *  started with `void`, so a rejection escaping it is an unhandled rejection — which, under Node's
   *  default --unhandled-rejections=throw, kills the utility process and mutes the whole app. */
  private async post(cmd: string, args: unknown): Promise<void> {
    try {
      await this.d.call(cmd, args);
    } catch { /* host unreachable; the host's own idle watchdog closes the request out */ }
  }

  private async handle(req: LocalExecRequest): Promise<void> {
    if (!this.d.policy.markDelivered(req.execId)) {
      // Persisted: a restart never re-runs a delivered request. But the host only re-offers requests
      // it is still waiting on, so an id this process never took belongs to a run of the app that is
      // gone. Answer it instead of returning silently and leaving the Bot blocked on it.
      if (!this.taken.has(req.execId)) await this.post("localExecDone", { execId: req.execId, exitCode: null, error: "This computer restarted while the request was running." });
      return;
    }
    this.taken.add(req.execId);
    if (this.taken.size > 4000) this.taken.delete(this.taken.values().next().value!);
    if (req.op === "revoke-grants") { // ruling (b): only ever removes privileges, so no policy check
      this.d.policy.forgetBot(req.botId);
      return void (await this.post("localExecDone", { execId: req.execId, exitCode: 0 }));
    }
    if (req.op === "browser") return void (await this.browser(req));
    if (req.op === "mac-app") return void (await this.macapp(req));
    await this.d.policy.warm?.(req);
    const verdict = this.d.policy.check(req);
    if (!verdict.ok) return void (await this.post("localExecDone", { execId: req.execId, exitCode: null, error: verdict.reason }));
    let buf: { stream: "stdout" | "stderr"; chunk: string }[] = [];
    const flush = async () => {
      const b = buf;
      buf = [];
      for (const x of b) await this.post("localExecOutput", { execId: req.execId, stream: x.stream, chunk: x.chunk });
    };
    const flusher = setInterval(() => void flush(), 200);
    try {
      const r = await this.d.executor.run(req, {
        output: (stream, chunk) => buf.push({ stream, chunk }),
        pin: verdict.pin ?? null, // bug 235: the executor re-checks the exempt tool right before exec
        // Bug 258: an everyday hand-off with no card (light sandbox), Full auto's web-page bridge, No limits' sandbox.
        quiet: verdict.quiet === true, openBridge: this.d.policy.fullAutoFor(req), noLimits: verdict.noLimits === true,
        ...(verdict.target !== undefined ? { target: verdict.target } : {}), // bug 441: the real path the check judged
        uploadBox: async (chunk, offset, final) => void (await this.post("localExecUpload", { execId: req.execId, offset, bytesBase64: chunk.toString("base64"), final })),
        readBox: (boxPath) => this.readBox(boxPath),
      });
      clearInterval(flusher);
      await flush();
      await this.post("localExecDone", { execId: req.execId, exitCode: r.exitCode, ...(r.result !== undefined ? { result: r.result } : {}) });
    } catch (e) {
      clearInterval(flusher);
      await flush();
      await this.post("localExecDone", { execId: req.execId, exitCode: null, error: (e as Error).message });
    }
  }

  /** mac-browser: this Mac's gate, then the controller; a refusal it can card is prefixed for the host. */
  private async browser(req: LocalExecRequest): Promise<void> {
    const v = this.d.policy.checkBrowser(req);
    if (!v.ok) return void (await this.post("localExecDone", { execId: req.execId, exitCode: null, error: v.reason }));
    if (!this.d.browser || !req.browser) return void (await this.post("localExecDone", { execId: req.execId, exitCode: null, error: "This app can't drive a browser." }));
    try {
      const r = await this.d.browser({ botId: req.botId, botName: req.botName ?? "Bot", args: req.browser, approved: v.approved, origins: v.origins, mode: v.mode, explicit: req.explicit === true, turn: req.turn, userTurn: req.userTurn === true });
      if (r.ok) await this.post("localExecDone", { execId: req.execId, exitCode: 0, result: JSON.stringify(r.reply) });
      else await this.post("localExecDone", { execId: req.execId, exitCode: null, error: `${r.needsApproval ? LOCAL_NEEDS_APPROVAL : ""}${r.error}` });
    } catch (e) {
      await this.post("localExecDone", { execId: req.execId, exitCode: null, error: `The browser failed: ${(e as Error).message}` });
    }
  }

  /**
   * mac-apps: this Mac's gate (the per-Bot permission and the one-time approval), then the controller in the
   * main process. The controller applies the consequential gate itself — it is the only side that can see
   * the resolved recipient or the real button label — and a refusal it can card is prefixed for the host.
   */
  private async macapp(req: LocalExecRequest): Promise<void> {
    const v = this.d.policy.checkMacApp(req);
    if (!v.ok) return void (await this.post("localExecDone", { execId: req.execId, exitCode: null, error: v.reason }));
    if (!this.d.macapp || !req.macapp) return void (await this.post("localExecDone", { execId: req.execId, exitCode: null, error: "This app can't drive the apps on this Mac." }));
    try {
      const r = await this.d.macapp({ botId: req.botId, botName: req.botName ?? "Bot", args: req.macapp, approved: v.approved });
      if (r.ok) await this.post("localExecDone", { execId: req.execId, exitCode: 0, result: JSON.stringify(r.reply) });
      else await this.post("localExecDone", { execId: req.execId, exitCode: null, error: `${r.needsApproval ? LOCAL_NEEDS_APPROVAL : ""}${r.error}` });
    } catch (e) {
      await this.post("localExecDone", { execId: req.execId, exitCode: null, error: `The app action failed: ${(e as Error).message}` });
    }
  }

  private async *readBox(boxPath: string): AsyncIterable<Buffer> {
    let offset = 0;
    for (;;) {
      const r = (await this.d.call("readWorkspaceFile", { path: boxPath, offset, length: LIMITS5.localChunkBytes })) as { chunkBase64: string; eof: boolean };
      const b = Buffer.from(r.chunkBase64, "base64");
      offset += b.length;
      yield b;
      if (r.eof) return;
    }
  }
}
