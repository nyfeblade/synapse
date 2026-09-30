import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readScriptCapped } from "./script-read";
import { STR_RULES, macRequestFacts, macRuleDecision, type MacRulesView } from "@synapse/shared";
import { BROWSER_PERMISSION_PREFIX, LIMITS5, MACAPP_PERMISSION_PREFIX, STRMA, LOCAL_ADOPT_MODE, LOCAL_NEEDS_APPROVAL, MAC_UNCHECKED_RULES, STR5, STRB, evaluateFixedRules, fullAutoAsk, localActionOf, localFullAutoAction, localPermAction, macAutoRunEligible, macFloorHits, macFold, macRootAcceptable, macExemptTool, macSandboxExemptSimple, macSandboxInteractive, macUnsandboxedHandoff, macPrivateStoreRead, macPrivateStorePath, macQuietHandoff, localBindTarget, realOfDeepest, type DryRunMode, type ExecutionPolicy, type FullAutoResult, type LocalAction, type LocalComputer, type LocalExecRequest, type MacActionVia, type MacHandoffContext, type PermMode, type PermResult } from "@synapse/shared";

import { macAllowedApp, warmAllowedApps } from "./app-trust";
import { readRaw, writeRaw } from "./policy-io";
import { policyMac } from "./policy-key";
import { exemptInstallTrees, pinTool, samePin, type ToolPin } from "./tool-path";

const PERM_MODES: readonly PermMode[] = ["ask", "accept-edits", "full-auto"];
const RANK: Record<PermMode, number> = { ask: 0, "accept-edits": 1, "full-auto": 2 };

/** P5 review minor: a once-approval is bound to hash(action + exact target), so it can't run a different command. */
export function bindHash(action: string, target: string): string {
  return createHash("sha256").update(`${action}\0${target}`).digest("hex");
}

/** A check's answer. `quiet`: an everyday hand-off with no card (the executor runs it in the light sandbox);
 *  `noLimits`: the Bot is in No limits (the sandbox drops the private-store rules). Bug 258. */
/** 5.6: `via` is what let it run (the action log's "approval that allowed it"). Bug 441: `target` is the real path a
 *  file write was judged at; the executor writes there or nowhere. */
export type CheckResult = { ok: true; pin?: ToolPin; quiet?: boolean; noLimits?: boolean; via?: MacActionVia; target?: string } | { ok: false; reason: string };

/**
 * Bug 433: the most distinct paths one gate decision resolves on disk. Each check (fixed rules, Full auto, hand-offs,
 * private stores) resolves every path a command names, and a failed realpath costs a syscall and an exception: a
 * command naming tens of thousands of paths could stall the gate for seconds. Past this, the call needs its own card.
 */
const REALPATH_BUDGET = 4096;
const MISSING = Object.freeze(new Error("ENOENT (memoized)"));

interface Approval { botId: string; expiresAt: number; bind: string; /** bug 235: the exempt tool as its card showed it. */ pin?: ToolPin }
interface Grant { botId: string; action: LocalAction }
interface DryRunRec { mode: DryRunMode; turn: string | null }

/**
 * computers.json, local-tool-approvals.json, local-tool-grants.json, local-tool-retirements.json and the delivered
 * set live in the Mac profile (§4.1). P5 review I3: every file is HMAC'd; bug 225: with the profile's own
 * local-policy.key (policy-key.ts), never the keychain. A file that fails the check is ignored, so a tampered policy
 * falls back to Ask.
 */
export class LocalPolicyStore {
  private files: { computers: string; approvals: string; grants: string; retirements: string; seen: string; modes: string; declines: string; origins: string; reset: string; noLimits: string; dryRun: string };
  private key: Buffer;

  private home: () => string;
  private userData: () => string | null;
  /** Bug 433: the current decision's resolved paths (null outside check()). */
  private resolved: { memo: Map<string, string | null>; calls: number; exhausted: boolean } | null = null;
  /** realpath on this Mac: memoized and budgeted within one check(), plain otherwise. */
  private realpath = (x: string): string => {
    const m = this.resolved;
    if (!m) return fs.realpathSync.native(x);
    const hit = m.memo.get(x);
    if (hit !== undefined) { if (hit === null) throw MISSING; return hit; }
    if (m.calls >= REALPATH_BUDGET) { m.exhausted = true; throw MISSING; }
    m.calls++;
    let real: string | null = null;
    try { real = fs.realpathSync.native(x); } catch { /* missing */ }
    m.memo.set(x, real);
    if (real === null) throw MISSING;
    return real;
  };

  constructor(dir: string, private now: () => number = Date.now, key?: Buffer, o: { home?: () => string; userData?: () => string | null; dryRunShadow?: string } = {}) {
    this.home = o.home ?? (() => os.homedir());
    this.userData = o.userData ?? (() => null);
    this.dryShadow = o.dryRunShadow ?? null;
    fs.mkdirSync(dir, { recursive: true });
    this.key = key ?? randomBytes(32); // tests only: the app always passes the profile key (or a throwaway one when it fails closed)
    this.files = {
      computers: path.join(dir, "computers.json"), approvals: path.join(dir, "local-tool-approvals.json"), grants: path.join(dir, "local-tool-grants.json"),
      retirements: path.join(dir, "local-tool-retirements.json"), seen: path.join(dir, "local-exec-delivered.json"),
      modes: path.join(dir, "local-bot-modes.json"), declines: path.join(dir, "local-bot-mode-declines.json"),
      origins: path.join(dir, "local-browser-origins.json"), reset: path.join(dir, "local-policy-reset.json"),
      noLimits: path.join(dir, "local-bot-nolimits.json"), dryRun: path.join(dir, "local-bot-dryrun.json"),
    };
  }

  private mac(file: string, data: unknown): string {
    return policyMac(this.key, path.basename(file), data);
  }
  private read<T>(file: string, fallback: T): T {
    const raw = readRaw(file) as { data?: unknown; mac?: unknown } | null;
    if (!raw || typeof raw.mac !== "string" || !("data" in raw)) return fallback;
    const want = Buffer.from(this.mac(file, raw.data), "hex");
    const got = Buffer.from(raw.mac, "hex");
    return got.length === want.length && timingSafeEqual(got, want) ? (raw.data as T) : fallback;
  }
  private write(file: string, data: unknown): void {
    writeRaw(file, { data, mac: this.mac(file, data) });
  }

  current(): LocalComputer {
    const list = this.read<{ computers: LocalComputer[] }>(this.files.computers, { computers: [] }).computers;
    let c = list.find((x) => x.isCurrent);
    if (!c) {
      c = { computerId: os.hostname(), label: macLabel(os.hostname()), isCurrent: true, executionPolicy: "ask", localRoot: this.home(), autoRunRoots: [] };
      this.write(this.files.computers, { computers: [...list, c] });
    }
    // Ruling A: the auto-run roots default to NONE (an older computers.json has no field).
    return { ...c, autoRunRoots: Array.isArray(c.autoRunRoots) ? c.autoRunRoots.filter((x) => typeof x === "string") : [], home: this.home() };
  }

  update(p: { label?: string; executionPolicy?: ExecutionPolicy; localRoot?: string; addAutoRunRoot?: string; removeAutoRunRoot?: string }): LocalComputer {
    const cur = this.current();
    let roots = cur.autoRunRoots ?? [];
    const added = typeof p.addAutoRunRoot === "string" ? this.acceptRoot(p.addAutoRunRoot) : null;
    if (added && !roots.includes(added)) roots = [...roots, added].slice(-50);
    if (typeof p.removeAutoRunRoot === "string") roots = roots.filter((x) => x !== p.removeAutoRunRoot);
    const { home: _home, ...stored } = cur; // home is reported, never stored
    const next: LocalComputer = {
      ...stored,
      ...(p.label !== undefined && p.label.trim() ? { label: p.label.trim().slice(0, 80) } : {}),
      ...(p.executionPolicy && ["always", "ask", "never"].includes(p.executionPolicy) ? { executionPolicy: p.executionPolicy } : {}),
      ...(p.localRoot && fs.existsSync(p.localRoot) ? { localRoot: fs.realpathSync(p.localRoot) } : {}),
      autoRunRoots: roots,
    };
    const list = this.read<{ computers: LocalComputer[] }>(this.files.computers, { computers: [] }).computers.map((x) => (x.isCurrent ? next : x));
    this.write(this.files.computers, { computers: list });
    return { ...next, home: this.home() };
  }

  /**
   * Ruling A: an auto-run root is an existing real folder (stored as its on-disk spelling), never /, never under
   * ~/Library, never inside a dot-dir, never a credential place or the app's data. Anything else is ignored.
   * Final secfix round 3 (ruling 2): and it must pass macRootAcceptable on its real path — a strict subfolder of ~
   * (or of /Volumes/<name>) that contains no protected place; ~, its ancestors and the system folders are refused.
   */
  private acceptRoot(p: string): string | null {
    if (!path.isAbsolute(p) || !/^[\x20-\x7e]+$/.test(p)) return null;
    let real: string;
    try {
      real = fs.realpathSync.native(p);
      if (!fs.statSync(real).isDirectory()) return null;
    } catch { return null; }
    if (macFold(real) === "/") return null;
    if (!macRootAcceptable(real, { home: this.home(), userData: this.userData() })) return null;
    const ctx = { home: this.home(), root: real, roots: [real], userData: this.userData(), realpath: (x: string) => fs.realpathSync.native(x) };
    return macAutoRunEligible({ op: "list-directory", path: real }, ctx) ? real : null;
  }

  /** Ruling A: the one shared predicate, on the Mac's real paths. Final secfix round 3 (ruling 2): the predicate itself
   *  ignores a stored root that no longer passes macRootAcceptable or whose realpath no longer equals the stored value. */
  autoRunEligible(req: LocalExecRequest): boolean {
    const c = this.current();
    return macAutoRunEligible(req, { home: this.home(), root: c.localRoot, roots: c.autoRunRoots ?? [], userData: this.userData(), realpath: this.realpath });
  }

  recordApproval(approvalId: string, rec: Approval): void {
    // Bug 235: an approval for an exempt tool carries the tool exactly as its card showed it (realpath, size, mtime).
    const shown = this.pendingPins.get(`${rec.botId}\0${rec.bind}`);
    if (shown && !rec.pin) rec = { ...rec, pin: shown };
    const cur = this.read<Record<string, Approval>>(this.files.approvals, {});
    for (const [k, v] of Object.entries(cur)) if (v.expiresAt < this.now()) delete cur[k];
    cur[approvalId] = rec;
    this.write(this.files.approvals, cur);
  }

  /** P5 review minor: the card's "Always" is per-Bot + per-action, never the whole Mac. */
  grant(botId: string, action: LocalAction): void {
    const g = this.read<{ grants: Grant[] }>(this.files.grants, { grants: [] }).grants.filter((x) => !(x.botId === botId && x.action === action));
    this.write(this.files.grants, { grants: [...g, { botId, action }].slice(-500) });
  }
  revoke(botId: string, action: LocalAction): void {
    this.write(this.files.grants, { grants: this.read<{ grants: Grant[] }>(this.files.grants, { grants: [] }).grants.filter((x) => !(x.botId === botId && x.action === action)) });
  }
  granted(botId: string, action: LocalAction | null): boolean {
    return !!action && this.read<{ grants: Grant[] }>(this.files.grants, { grants: [] }).grants.some((x) => x.botId === botId && x.action === action);
  }
  /** mac-browser: sites where this Bot's consequential browser actions run without a card (the user's explicit rule). */
  browserOrigins(botId: string): string[] {
    const o = this.read<Record<string, string[]>>(this.files.origins, {})[botId];
    return Array.isArray(o) ? o.filter((x) => typeof x === "string") : [];
  }
  addBrowserOrigin(botId: string, origin: string): void {
    if (!botId || !origin) return;
    const all = this.read<Record<string, string[]>>(this.files.origins, {});
    all[botId] = [...new Set([...(all[botId] ?? []), origin])].slice(-200);
    this.write(this.files.origins, all);
  }

  /**
   * mac-browser (LOC-05): the Mac's own gate for a Browser action. The per-Bot permission ("May use the browser on your
   * Mac", a grant of action "browser"; off by default) or this call's permission-card approval lets it through; a
   * consequential-card approval (bound to exactly this call) also marks it approved for the controller, which judges
   * the live page. Never allow blocks it like every Mac request.
   */
  /** Safety v2: the owner's rules, from the host (getSafety and the "safety" event); null until the first answer. */
  private rulesView: MacRulesView | null = null;
  setRules(v: MacRulesView | null): void { this.rulesView = v && Array.isArray(v.rules) ? v : null; }
  rules(): MacRulesView | null { return this.rulesView; }

  checkBrowser(req: LocalExecRequest): { ok: true; approved: boolean; origins: string[]; mode: PermMode; rules: MacRulesView | null } | { ok: false; reason: string } {
    if (this.current().executionPolicy === "never") return { ok: false, reason: STR5.macRefused.neverPolicy };
    const target = localBindTarget(req);
    let permitted = this.granted(req.botId, "browser");
    let approved = false;
    if (req.approvalId) {
      const hit = this.take(req.approvalId, req.botId, [bindHash("browser", target), bindHash("browser", `${BROWSER_PERMISSION_PREFIX}${target}`)]);
      if (hit < 0) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.staleApproval}` };
      permitted = true;
      approved = hit === 0;
    }
    if (!permitted) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STRB.permissionRefused}` };
    // full-auto-quiet: the controller judges the LIVE page, so it needs the Bot's effective mode to apply the
    // same five-category policy there (a "Save changes" on a settings page is not one of the five; "Pay now" is).
    return { ok: true, approved, origins: this.browserOrigins(req.botId), mode: this.effectiveMode(req), rules: this.rulesView };
  }

  /** The Bot's mode on THIS Mac: its own record, capped by any lower claim the host sent (never raised by it). */
  private effectiveMode(req: LocalExecRequest): PermMode {
    const own = this.botMode(req.botId);
    const claim = req.hostMode && PERM_MODES.includes(req.hostMode) ? req.hostMode : null;
    return claim && RANK[claim] < RANK[own] ? claim : own;
  }

  /**
   * mac-apps: the same shape as checkBrowser. The per-Bot "May use the apps on your Mac" permission gates
   * everything; `approved` says the user answered the card for exactly THIS call, which is what lets the
   * controller run a send, a delete, a spend or a security action.
   */
  checkMacApp(req: LocalExecRequest): { ok: true; approved: boolean; rules: MacRulesView | null } | { ok: false; reason: string } {
    if (this.current().executionPolicy === "never") return { ok: false, reason: STR5.macRefused.neverPolicy };
    const target = localBindTarget(req);
    let permitted = this.granted(req.botId, "mac-app");
    let approved = false;
    if (req.approvalId) {
      const hit = this.take(req.approvalId, req.botId, [bindHash("mac-app", target), bindHash("mac-app", `${MACAPP_PERMISSION_PREFIX}${target}`)]);
      if (hit < 0) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.staleApproval}` };
      permitted = true;
      approved = hit === 0;
    }
    if (!permitted) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STRMA.permissionRefused}` };
    return { ok: true, approved, rules: this.rulesView };
  }

  /** Consume a once-approval if it is this Bot's, live, and bound to one of `binds`; the index matched, or -1. */
  private take(approvalId: string, botId: string, binds: string[]): number {
    const retired = this.read<{ retired: string[] }>(this.files.retirements, { retired: [] }).retired;
    const approvals = this.read<Record<string, Approval>>(this.files.approvals, {});
    const rec = approvals[approvalId];
    if (!rec || retired.includes(approvalId) || rec.expiresAt < this.now() || rec.botId !== botId) return -1;
    const i = binds.indexOf(rec.bind);
    if (i < 0) return -1;
    delete approvals[approvalId];
    this.write(this.files.approvals, approvals);
    this.write(this.files.retirements, { retired: [...retired, approvalId].slice(-1000) });
    return i;
  }

  /** I12: a deleted Bot's grants go. */
  forgetBot(botId: string): void {
    this.write(this.files.grants, { grants: this.read<{ grants: Grant[] }>(this.files.grants, { grants: [] }).grants.filter((x) => x.botId !== botId) });
    const modes = this.read<Record<string, PermMode>>(this.files.modes, {});
    if (botId in modes) {
      delete modes[botId];
      this.write(this.files.modes, modes);
    }
    const declines = this.read<Record<string, PermMode>>(this.files.declines, {});
    if (botId in declines) {
      delete declines[botId];
      this.write(this.files.declines, declines);
    }
    const origins = this.read<Record<string, string[]>>(this.files.origins, {});
    if (botId in origins) {
      delete origins[botId];
      this.write(this.files.origins, origins);
    }
    this.setNoLimits(botId, false);
    // A deleted Bot's dry run goes only from a record that can be trusted: this never rewrites a bad one.
    const d = this.dryRecords();
    if (d?.good && botId in d.all) this.setDryRun(botId, "off");
  }

  /**
   * 5.6: dry run, per Bot, as set IN THIS APP (the host can't read or change it). "turn" (Next turn) lasts for one
   * task: it binds to the owner message the first request belongs to (`task`, the host's user-message epoch) and ends
   * when a request from a later owner message arrives; approval resumes and follow-up turns carry the same task. "on"
   * stays until turned off. HMAC'd like the modes.
   *
   * Fails safe: a file that is unreadable, tampered with or fails its signature is not "off". Every Bot that had dry
   * run at the last good read keeps it; with no good read at all this run, the state is "unknown" and the daemon
   * refuses every change.
   */
  private dryLastGood: Record<string, DryRunRec> | null = null;
  private dryShadow: string | null = null;
  private dryRead(): Record<string, DryRunRec> | null {
    const f = this.files.dryRun;
    const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; } };
    if (!exists(f)) {
      // Nothing set on this Mac: off for everyone. A run on a scratch folder (the key file can't be trusted) can't
      // verify the real file, so that one is unknown, not off.
      if (this.dryShadow && exists(this.dryShadow)) return null;
      this.dryLastGood = {};
      return {};
    }
    const raw = readRaw(f) as { data?: unknown; mac?: unknown } | null;
    if (!raw || typeof raw.mac !== "string" || !("data" in raw) || !raw.data || typeof raw.data !== "object") return null;
    const want = Buffer.from(this.mac(f, raw.data), "hex");
    const got = Buffer.from(raw.mac, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    this.dryLastGood = raw.data as Record<string, DryRunRec>;
    return { ...this.dryLastGood };
  }
  /** The records to act on: this read, else the last good one, else null (unknown). */
  private dryRecords(): { all: Record<string, DryRunRec>; good: boolean } | null {
    const r = this.dryRead();
    if (r) return { all: r, good: true };
    return this.dryLastGood ? { all: { ...this.dryLastGood }, good: false } : null;
  }
  dryRunMode(botId: string): DryRunMode {
    const d = this.dryRecords();
    if (!d) return "on";
    const r = d.all[botId];
    return r?.mode === "on" || r?.mode === "turn" ? r.mode : "off";
  }
  setDryRun(botId: string, mode: DryRunMode): void {
    if (!botId) return;
    const d = this.dryRecords();
    const all = d?.all ?? {};
    if (mode === "on" || mode === "turn") all[botId] = { mode, turn: null };
    else if (botId in all) delete all[botId];
    else if (d?.good) return;
    this.write(this.files.dryRun, all);
    this.dryLastGood = all;
  }
  /** Whether this request runs dry: "on", "off", or "unknown" (the record can't be trusted and was never read). */
  dryRunState(req: Pick<LocalExecRequest, "botId" | "task">): "on" | "off" | "unknown" {
    const d = this.dryRecords();
    if (!d) return "unknown";
    const r = d.all[req.botId];
    if (!r || (r.mode !== "on" && r.mode !== "turn")) return "off";
    // A bad file never ends a Next turn: that needs a write this run can't trust.
    if (r.mode === "on" || !req.task || !d.good) return "on";
    if (r.turn === null) { d.all[req.botId] = { mode: "turn", turn: req.task }; this.write(this.files.dryRun, d.all); this.dryLastGood = d.all; return "on"; }
    if (r.turn === req.task) return "on";
    delete d.all[req.botId];
    this.write(this.files.dryRun, d.all);
    this.dryLastGood = d.all;
    return "off";
  }
  dryRunFor(req: Pick<LocalExecRequest, "botId" | "task">): boolean {
    return this.dryRunState(req) !== "off";
  }

  /**
   * fix-mac-gate-and-approval-expiry (Bug A): each Bot's permission mode as the user set it IN THIS APP (the coordinator
   * records setAgentPermMode as it passes through from the renderer). The host's word is never read, so a compromised
   * host can't grant itself Full auto. HMAC'd like every other policy file; missing or tampered → Ask.
   */
  botMode(botId: string): PermMode {
    const m = this.read<Record<string, PermMode>>(this.files.modes, {})[botId];
    return m && PERM_MODES.includes(m) ? m : "ask";
  }
  setBotMode(botId: string, mode: PermMode): void {
    if (!PERM_MODES.includes(mode) || !botId) return;
    const modes = this.read<Record<string, PermMode>>(this.files.modes, {});
    if (mode === "ask") delete modes[botId];
    else modes[botId] = mode;
    this.write(this.files.modes, modes);
    // Bug 258: any mode choice (settings, the adoption card, the restore prompt) leaves No limits: only its own confirm
    // (setNoLimits, after this) turns it on again.
    this.setNoLimits(botId, false);
    // A choice made in settings (or on the adoption card) supersedes an earlier "Keep asking".
    const declines = this.read<Record<string, PermMode>>(this.files.declines, {});
    if (botId in declines) {
      delete declines[botId];
      this.write(this.files.declines, declines);
    }
  }
  /**
   * Bug 258: No limits, on top of Full auto, as the user confirmed it IN THIS APP (the coordinator writes it only from
   * the confirm dialog's command, carrying NO_LIMITS_CONFIRM). HMAC'd like the modes; missing or tampered → off. It
   * counts only while this Mac's own record of the Bot is Full auto.
   */
  noLimits(botId: string): boolean {
    return this.botMode(botId) === "full-auto" && this.read<Record<string, boolean>>(this.files.noLimits, {})[botId] === true;
  }
  setNoLimits(botId: string, on: boolean): void {
    if (!botId) return;
    const all = this.read<Record<string, boolean>>(this.files.noLimits, {});
    if (on) all[botId] = true;
    else if (botId in all) delete all[botId];
    else return;
    this.write(this.files.noLimits, all);
  }

  /** fix-fullauto-adoption: the user answered the adoption card "Keep asking" for this mode value: no adoption card for
   *  it again (per-command cards instead) until the mode is chosen in settings or the host's mode changes. */
  declineMode(botId: string, mode: PermMode): void {
    if (!botId || mode === "ask" || !PERM_MODES.includes(mode)) return;
    this.write(this.files.declines, { ...this.read<Record<string, PermMode>>(this.files.declines, {}), [botId]: mode });
  }
  declined(botId: string, mode: PermMode): boolean {
    return this.read<Record<string, PermMode>>(this.files.declines, {})[botId] === mode;
  }

  /** Bug 256: set when earlier permission files could not be carried over to this key (or after Reset permissions). */
  resetNotice(): { at: number; lost: string[] } | null {
    const r = this.read<{ at?: unknown; lost?: unknown } | null>(this.files.reset, null);
    return r && typeof r.at === "number" && Array.isArray(r.lost) ? { at: r.at, lost: r.lost.filter((x): x is string => typeof x === "string") } : null;
  }
  clearResetNotice(): void {
    try { fs.unlinkSync(this.files.reset); } catch { /* not there */ }
  }
  /** Bug 256: the Bots whose mode the user chose (sent by this app's renderer) is above this Mac's record and was never
   *  declined here: the list the one "Turn Full auto back on" prompt names. */
  missingModes(want: { id: string; mode: PermMode }[]): { id: string; mode: PermMode }[] {
    return want.filter((b) => !!b && typeof b.id === "string" && !!b.id && PERM_MODES.includes(b.mode) && b.mode !== "ask" && RANK[this.botMode(b.id)] < RANK[b.mode] && !this.declined(b.id, b.mode));
  }

  /** The shared fixed-rules engine (shared/src/perm-rules.ts) on the Mac's real paths: the same NEVER / ALWAYS-ASK /
   *  ALWAYS-ALLOW the host applied, re-evaluated here because the Mac is the final authority (LOC-05). */
  private fixed(req: LocalExecRequest, c: LocalComputer, noLimits = false): PermResult | null {
    const home = this.home();
    const action = localPermAction(req, c.localRoot || home, home);
    if (!action) return null;
    return evaluateFixedRules(action, { home, projectDirs: c.autoRunRoots ?? [], userData: this.userData(), realpath: this.realpath, readScript: readScriptCapped, noLimits, ...(action.kind === "write" || action.kind === "edit" ? { toolTrees: exemptInstallTrees(home) } : {}) });
  }

  /** Bug 258: No limits applies to this request: this Mac's own record, Full auto in effect, and no lower host claim. */
  private noLimitsFor(req: LocalExecRequest): boolean {
    return this.effectiveMode(req) === "full-auto" && this.noLimits(req.botId) && req.hostNoLimits !== false;
  }

  /**
   * full-auto-quiet: the SAME classifier the host's tool guard and the Browser classifier use (@synapse/shared
   * full-auto.ts), re-evaluated here because the Mac is the final authority (LOC-05). In Full auto a request needs
   * the user's OK only for DESTRUCTION of their data, SENDING OUTWARD, MONEY or SECURITY AND ACCESS.
   */
  private fullAuto(req: LocalExecRequest, c: LocalComputer, noLimits = false): FullAutoResult {
    const home = this.home();
    const action = localFullAutoAction(req, c.localRoot || home, home);
    if (!action) return { ask: false, category: null, rule: "full-auto.quiet", reason: "" };
    return fullAutoAsk(action, {
      home,
      noLimits,
      // On this Mac the Bot owns exactly the auto-run roots the user added (none by default).
      workspaces: c.autoRunRoots ?? [],
      realpath: this.realpath,
      exists: (p) => { try { return fs.existsSync(p); } catch { return true; } },
    });
  }

  /** Bug 235: the exempt tool each card showed, by Bot + bound target, until the card is answered. */
  private pendingPins = new Map<string, ToolPin>();

  consume(approvalId: string | null, req: LocalExecRequest): { ok: true; pin?: ToolPin } | { ok: false; reason: string } {
    const no = { ok: false as const, reason: `${LOCAL_NEEDS_APPROVAL}${approvalId ? STR5.macRefused.staleApproval : STR5.macRefused.askNoApproval}` };
    if (!approvalId) return no;
    const retired = this.read<{ retired: string[] }>(this.files.retirements, { retired: [] }).retired;
    const approvals = this.read<Record<string, Approval>>(this.files.approvals, {});
    const rec = approvals[approvalId];
    const action = localActionOf(req.op);
    if (!rec || !action || retired.includes(approvalId) || rec.expiresAt < this.now() || rec.botId !== req.botId) return no;
    if (rec.bind !== bindHash(action, localBindTarget(req))) return no;
    delete approvals[approvalId];
    this.write(this.files.approvals, approvals);
    this.write(this.files.retirements, { retired: [...retired, approvalId].slice(-1000) });
    // Bug 235: an exempt tool must be exactly what the card showed; the approval is spent either way.
    const tool = req.op === "run-command" && macSandboxExemptSimple(req.command ?? "") ? macExemptTool(req.command ?? "") : null;
    if (tool) {
      const now = pinTool(tool, { home: this.home() });
      if (!rec.pin || !samePin(rec.pin, now)) return { ok: false, reason: `${STR5.macToolChanged} (${tool} → ${now?.realpath ?? "not found"})` };
      return { ok: true, pin: now! };
    }
    return { ok: true };
  }

  /** LOC-05: a request runs only if the Mac's own settings allow it, whatever the host says. */
  check(req: LocalExecRequest): CheckResult {
    const v = this.decide(req);
    if (!v.ok) return v;
    const { via: _via, ...rest } = v;
    return rest;
  }

  /** 5.6: check(), plus what let it run (`via`), for the action log. */
  decide(req: LocalExecRequest): CheckResult {
    // Bug 433: one decision resolves each path once, and at most REALPATH_BUDGET of them; past that, what it found
    // can't be trusted to allow: a card (an approval this call brought still counts).
    if (this.resolved) return this.checkOnce(req);
    this.resolved = { memo: new Map(), calls: 0, exhausted: false };
    try {
      const v = this.checkOnce(req);
      if (v.ok && this.resolved.exhausted && !req.approvalId) {
        return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk("This command names more paths than can be checked ahead of time.")}` };
      }
      // Bug 441: a file write is judged by where its path really is; the executor writes only there (a link swapped in
      // between the check and the write is refused).
      if (v.ok && (req.op === "write-file" || req.op === "edit-file" || req.op === "copy-from-box")) return { ...v, target: this.realTarget(req.path ?? "") };
      return v;
    } finally {
      this.resolved = null;
    }
  }

  /** Bug 441: the real path a file request names, as this decision resolved it (the same base the checks use). */
  private realTarget(p: string): string {
    const home = this.home();
    const base = this.current().localRoot || home;
    const abs = p === "~" || p.startsWith("~/") ? `${home.replace(/\/$/, "")}${p.slice(1)}` : path.resolve(base, p);
    return path.resolve(realOfDeepest(abs, this.realpath) ?? abs);
  }

  private checkOnce(req: LocalExecRequest): CheckResult {
    const c = this.current();
    const policy = c.executionPolicy;
    // The account switch is the master: Never allow blocks everything, whatever the Bot's mode.
    if (policy === "never") return { ok: false, reason: STR5.macRefused.neverPolicy };
    if (req.op === "kill") return { ok: true };
    // Bug 258: No limits (this Mac's own record, confirmed in the app, on top of Full auto) and Full auto in effect.
    const noLimits = this.noLimitsFor(req);
    const inFullAuto = this.effectiveMode(req) === "full-auto";
    const tag = (v: CheckResult, via: MacActionVia = "card"): CheckResult => (v.ok ? { ...v, via, ...(noLimits ? { noLimits: true } : {}) } : v);
    // A fixed NEVER is a hard wall in every mode, with or without an approval id. In No limits it still walls the
    // app's own data (the policy key and files) and the keychain.
    const fixed = this.fixed(req, c, noLimits);
    if (fixed?.verdict === "never") return { ok: false, reason: STR5.macRefused.neverRule(fixed.reason) };
    // Bug 433: a command the fixed rules couldn't check (too long, or too many scripts to read) needs this call's own
    // approval in EVERY mode, and nothing else here reads its text (a huge hostile command can't stall the gate).
    if (fixed?.verdict === "always-ask" && MAC_UNCHECKED_RULES.has(fixed.rule)) {
      return req.approvalId ? tag(this.consume(req.approvalId, req)) : { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(fixed.reason)}` };
    }
    // Safety v2: the owner's rules, on the Mac's own facts (the real path, the command's targets), in every mode, No
    // limits included. Never is a wall (no card); Ask first needs this call's own approval, whatever the mode or grants.
    // (No rules from the host: nothing is parsed, so a huge hostile command costs no more than before, bug 433.)
    if (req.op !== "browser" && req.op !== "mac-app" && this.rulesView?.rules.some((r) => r.enabled && !r.reviewOnly && (r.source !== "preset" || r.strict || r.type === "never"))) {
      const home = this.home();
      const rule = macRuleDecision(this.rulesView, macRequestFacts(req.botId, req, { home, base: c.localRoot || home }), { now: this.now(), home });
      if (rule?.type === "never") return { ok: false, reason: STR_RULES.macNever(rule.rule.text) };
      if (rule?.type === "ask") return req.approvalId ? tag(this.consume(req.approvalId, req)) : { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR_RULES.macAsk(rule.rule.text)}` };
    }
    // Bug 229: a command that runs outside the command sandbox (a known self-sandboxing program, run unwrapped) or
    // hands code to something that will (launchd, cron, an opened script/app, Terminal told to run a line) needs this
    // call's own approval in EVERY mode, whatever the grants or the computer-wide Always.
    // Bug 237: an app-side write/edit of a tool's settings (Claude, Codex, git) needs this call's own card in every mode.
    if ((req.op === "write-file" || req.op === "edit-file") && fixed?.rule === "ask.tool-config") {
      return req.approvalId ? tag(this.consume(req.approvalId, req)) : { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(fixed.reason)}` };
    }
    let quiet = false;
    if (req.op === "run-command") {
      // Bug 232: an unsandboxed program runs one-shot only; an interactive session is refused outright (no card).
      if (macSandboxInteractive(req.command ?? "")) return { ok: false, reason: STR5.macExemptInteractive };
      const exempt = macSandboxExemptSimple(req.command ?? ""); // bug 236: only a single simple command runs unwrapped
      const cwd = req.cwd ?? c.localRoot;
      let handoff = macUnsandboxedHandoff(req.command ?? "", { home: this.home(), cwd });
      // Bug 258: in Full auto an everyday hand-off (one simple `osascript -e …` or `open` of a local file, folder or
      // app) runs with no card, in the light sandbox. The high-risk forms, and a chain around any hand-off, keep it.
      if (handoff && inFullAuto && !req.approvalId && macQuietHandoff(req.command ?? "", this.handoffCtx(cwd, noLimits))) {
        handoff = null;
        quiet = true;
      }
      // Bug 234: the card names the binary that will actually run ("claude → /opt/homebrew/bin/claude"), resolved the
      // same way the executor resolves it for the unwrapped run.
      const tool = exempt ? macExemptTool(req.command ?? "") : null;
      // Bug 235: the card shows the realpath that will run, and that exact file (size, mtime) is pinned for the approval.
      const pin = tool ? pinTool(tool, { home: this.home() }) : null;
      if (tool && pin && !req.approvalId) this.pendingPins.set(`${req.botId}\0${bindHash("run-command", localBindTarget(req))}`, pin);
      if (this.pendingPins.size > 200) this.pendingPins.delete(this.pendingPins.keys().next().value!);
      const shown = tool ? ` (${tool} → ${pin?.realpath ?? "not found"})` : "";
      // Private-store hardening: a single plain read of one private store runs outside the sandbox (which denies it)
      // once approved, so like a hand-off it needs this call's own card in every mode. Bug 258: in No limits the
      // sandbox has no store rules, so the read runs inside it with no card.
      const storeRead = !noLimits && !handoff && !exempt && macPrivateStoreRead(req.command ?? "", { home: this.home(), cwd, realpath: this.realpath });
      const strict = handoff ? `${handoff}${shown}` : exempt ? `${STR5.macOutsideSandbox(exempt)}${shown}` : storeRead ? STR5.macPrivateStoreRead : null;
      if (strict) return req.approvalId ? tag(this.consume(req.approvalId, req)) : { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(strict)}` };
    }
    const pass = (via: MacActionVia): CheckResult => tag(quiet ? { ok: true, quiet: true } : { ok: true }, via);
    // Final secfix round 2 (ruling A): ANY "Always" (computer-wide or a per-Bot grant) auto-runs only an allowlisted
    // read inside an auto-run root the user added (none by default). Everything else needs this call's own approval.
    const always = policy === "always" || this.granted(req.botId, localActionOf(req.op));
    if (!req.approvalId && always && this.autoRunEligible(req)) return pass(policy === "always" ? "always-mac" : "always-bot");
    // fix-mac-gate-and-approval-expiry (Bug A): the Bot's mode, as set in THIS app. Full auto runs everything but a
    // fixed ALWAYS-ASK (which still needs this call's own approval); Auto-accept edits runs an edit/write the fixed
    // rules auto-allow (inside a project dir). Ask keeps the approval requirement below.
    // The Mac floor (credential stores, persistence points, pipe-to-shell, network sends) cards in every mode, as on
    // the host (hostCallStatic): the host shows that card, and its answer is this call's approval.
    // fix-fullauto-adoption: the host's claim only ever restricts (a lower claim caps the Mac's record); a higher one is
    // never granted here, it only raises the one adoption card below, whose answer is recorded by the Mac itself.
    const own = this.botMode(req.botId);
    const claim = req.hostMode && PERM_MODES.includes(req.hostMode) ? req.hostMode : null;
    const mode = this.effectiveMode(req);
    const floor = macFloorHits(req.op === "run-command" || req.op === "send-input" ? req.command ?? "" : req.path ?? "").floors.size > 0;
    // full-auto-quiet: in Full auto the shared classifier is the whole policy for CARDS — the fixed ALWAYS-ASK and
    // the Mac floor no longer ask on their own in that mode. The fixed NEVER wall above is untouched.
    const fa = this.fullAuto(req, c, noLimits);
    // Bug 256: in Full auto the classifier alone decides; a plain command never needs a matching fixed rule to pass.
    // Bug 440: Auto-accept edits is never weaker than Full auto: an edit Full auto would card (a git hook, the agent's
    // settings, a key or credentials file, even inside a project) needs this call's own approval here too. (No limits
    // counts only while Full auto is in effect, so `fa` here is the strict verdict whenever Auto-accept edits is asked.)
    const passes = (m: PermMode) => m === "full-auto"
      ? !fa.ask
      : (!!fixed && fixed.verdict !== "always-ask" && !floor && !fa.ask && m === "accept-edits" && fixed.verdict === "always-allow" && (req.op === "edit-file" || req.op === "write-file"));
    if (passes(mode)) return pass(mode === "full-auto" ? (noLimits ? "no-limits" : "full-auto") : "accept-edits");
    if (!req.approvalId && claim && claim !== "ask" && RANK[claim] > RANK[own] && passes(claim) && !this.declined(req.botId, claim)) {
      return { ok: false, reason: `${LOCAL_ADOPT_MODE}${STR5.localAdoptRefused}` };
    }
    if (!req.approvalId && mode === "full-auto" && fa.ask) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(fa.reason)}` };
    if (!req.approvalId && mode === "accept-edits" && fa.ask && (req.op === "edit-file" || req.op === "write-file")) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(fa.reason)}` };
    if (!req.approvalId && mode !== "full-auto" && fixed?.verdict === "always-ask") return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk(fixed.reason)}` };
    if (!req.approvalId && mode === "accept-edits" && floor) return { ok: false, reason: `${LOCAL_NEEDS_APPROVAL}${STR5.macRefused.alwaysAsk("it touches a protected place: credentials, a startup item, a pipe into a shell or a network send")}` };
    return tag(this.consume(req.approvalId, req));
  }

  /** Bug 258: Full auto is in effect for this request on this Mac (a dev tool's web page may open through the bridge). */
  fullAutoFor(req: LocalExecRequest): boolean {
    return this.effectiveMode(req) === "full-auto";
  }

  /** 0.1.4 first-run: check (off the thread) every app this command's hand-off check will ask about, so the sync
   *  `check` that follows only reads the cache and never runs codesign in the coordinator's thread. */
  async warm(req: LocalExecRequest): Promise<void> {
    if (req.op !== "run-command" || !req.command) return;
    const cwd = req.cwd ?? this.current().localRoot;
    if (!macUnsandboxedHandoff(req.command, { home: this.home(), cwd })) return;
    await warmAllowedApps(req.command, this.handoffCtx(cwd, this.noLimitsFor(req))).catch(() => {});
  }

  /** Bug 258: what the Full-auto hand-off split needs to know about this Mac. */
  handoffCtx(cwd: string | null | undefined, noLimits: boolean): MacHandoffContext {
    return {
      home: this.home(), cwd: cwd ?? null, userData: this.userData(), noLimits,
      realpath: this.realpath,
      isExecFile: (p) => { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } },
      isAllowedApp: (n) => macAllowedApp(n, this.home()),
      isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
      isStore: (p) => macPrivateStorePath(p, this.home()),
    };
  }

  /** P5 review minor: the daemon never re-runs a request it already took, even after a restart. */
  markDelivered(execId: string): boolean {
    const seen = this.read<{ ids: string[] }>(this.files.seen, { ids: [] }).ids;
    if (seen.includes(execId)) return false;
    this.write(this.files.seen, { ids: [...seen, execId].slice(-2000) });
    return true;
  }

  askTtlMs(): number { return LIMITS5.localAskTtlMs; }
}

/** New-user walk, nit 30: the Mac's name without the network suffix ("Studio-MBP.localdomain" → "Studio-MBP"). */
export function macLabel(hostname: string): string {
  return hostname.replace(/\.(local|localdomain|lan|home|internal)$/i, "");
}
