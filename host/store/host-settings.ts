import { createHash, randomUUID } from "node:crypto";
import {
  COMPUTER_PERCEPTION_MODES, DEFAULT_SAVINGS, LIMITS, isCallReplies, isLongContextMode, isPromptCacheTtl,
  type CallReplies, type ComputerPerception, type GatewayCommands, type HostSettingsView, type LongContextMode, type PromptCacheTtl, type ThemePreference,
} from "@synapse/shared";
import { LIVE_PERCEPTION_ENABLED, LIVE_SHELVED_MESSAGE } from "../computer/perception/mode";
import { GatewayError } from "../gateway/errors";
import { readJsonOrQuarantine, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { normalizeTrusted } from "../approvals/smarter";

export interface HostSettings {
  autoReviewEnabled: boolean;
  autoReviewInstructions: { allowInstructions: string[]; blockInstructions: string[] };
  userTimeZone: string | null;
  userTimeZoneOverride: string | null;
  pinnedAgentIds: string[];
  autoReviewCompiled: Record<string, unknown>;
  themePreference: ThemePreference;
  memoryRecall: boolean;
  advanced: { enabled: boolean };
  smartGroupTurns: boolean;
  teachSidecar: boolean;
  publicWebhook: { enabled: boolean; url: string | null };
  /** I5: the webhook listener binds 127.0.0.1 unless the user turns on local-network access. */
  webhookLan: boolean;
  /** cost-diet-2 lever 1: "Save usage" for every Bot that has no switch of its own (model routing). Default off. */
  saveUsage: boolean;
  /** "Computer perception" for every Bot with no choice of its own. Always read through perceptionMode: Live is shelved
   *  (decisions.md 2026-09-21), so a stored "live" runs as screenshots. */
  computerPerception: ComputerPerception;
  /** saving-settings (Settings → Usage → Savings). Defaults are the behaviour before the settings existed; always read
   *  through savings(), so a stored value this build doesn't know reads as its default. */
  promptCacheTtl: PromptCacheTtl;
  callReplies: CallReplies;
  longContext: LongContextMode;
  /** Smarter approvals: people the owner trusts; a send to only them (and the owner) skips the card. Set only in
   *  Settings (setHostSettings from the app); a Bot's update_state can't change it. */
  trustedRecipients: string[];
  /** settings-persist: bumped on every save and kept on disk, so a view carries its age (HostSettingsView.rev). */
  rev: number;
}

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  autoReviewEnabled: true,
  autoReviewInstructions: { allowInstructions: [], blockInstructions: [] },
  userTimeZone: null,
  userTimeZoneOverride: null,
  pinnedAgentIds: [],
  autoReviewCompiled: {},
  themePreference: "system",
  memoryRecall: true,
  advanced: { enabled: false },
  smartGroupTurns: false,
  teachSidecar: true,
  publicWebhook: { enabled: false, url: null },
  webhookLan: false,
  saveUsage: false,
  computerPerception: "screenshots",
  trustedRecipients: [],
  ...DEFAULT_SAVINGS,
  rev: 0,
};

function normalizeRules(list: string[], label: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const r = raw.trim();
    if (!r) continue;
    if (r.length > LIMITS.ruleMaxChars) throw new GatewayError("RULE_TOO_LONG", `${label} rules can be at most 1,000 characters.`);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > LIMITS.rulesPerList) throw new GatewayError("TOO_MANY_RULES", `${label} can have at most 20 rules.`);
  return out;
}

export class HostSettingsStore {
  private s: HostSettings;
  private lanError: string | null = null;
  /** Where an unreadable settings.json was moved at load, or null: the user's settings are now the defaults. */
  readonly quarantined: string | null;
  /** settings-persist: this store's load id (HostSettingsView.epoch). A new host run — including one that found the
   *  file corrupt and started from the defaults at `rev` 0 — is a new epoch, so the app takes its answers again. */
  readonly epoch = randomUUID();

  constructor(private file: string, private onChange?: (view: HostSettingsView) => void) {
    const { value: loaded, quarantined } = readJsonOrQuarantine<Partial<HostSettings>>(file, {});
    if (quarantined) log.error("settings.json could not be parsed; starting from the defaults", { file, kept: quarantined });
    this.quarantined = quarantined ?? null; // app.ts tells the user (a tray), not only the log
    this.s = { ...DEFAULT_HOST_SETTINGS, ...loaded, advanced: { ...DEFAULT_HOST_SETTINGS.advanced, ...(loaded.advanced ?? {}) } };
  }

  get(): HostSettings {
    return this.s;
  }

  /** saving-settings: the three Savings choices, each its default when the stored value is not one this build knows. */
  savings(): { promptCacheTtl: PromptCacheTtl; callReplies: CallReplies; longContext: LongContextMode } {
    return {
      promptCacheTtl: isPromptCacheTtl(this.s.promptCacheTtl) ? this.s.promptCacheTtl : DEFAULT_SAVINGS.promptCacheTtl,
      callReplies: isCallReplies(this.s.callReplies) ? this.s.callReplies : DEFAULT_SAVINGS.callReplies,
      longContext: isLongContextMode(this.s.longContext) ? this.s.longContext : DEFAULT_SAVINGS.longContext,
    };
  }

  timeZone(): string {
    return this.s.userTimeZoneOverride ?? this.s.userTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /**
   * 0.1.4 first-run (code audit 6.1 / 6.2): the Mac's own time zone, reported by the app at connect and whenever the
   * Mac's zone changes. "Auto" follows it (the box's own zone, fixed when the host started, is only the fallback).
   * Saved (and published) only when it changed; an unknown zone name is refused. Returns whether it changed.
   */
  setMacTimeZone(zone: string): boolean {
    if (typeof zone !== "string" || !zone || zone.length > 64) throw new GatewayError("BAD_ZONE", "That isn't a time zone.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { throw new GatewayError("BAD_ZONE", "That isn't a time zone."); }
    if (this.s.userTimeZone === zone) return false;
    this.save({ ...structuredClone(this.s), userTimeZone: zone });
    return true;
  }

  view(): HostSettingsView {
    return {
      autoReviewEnabled: this.s.autoReviewEnabled,
      allowInstructions: [...this.s.autoReviewInstructions.allowInstructions],
      blockInstructions: [...this.s.autoReviewInstructions.blockInstructions],
      userTimeZone: this.timeZone(),
      userTimeZoneOverride: this.s.userTimeZoneOverride,
      pinnedAgentIds: [...this.s.pinnedAgentIds],
      themePreference: this.s.themePreference,
      memoryRecall: this.s.memoryRecall,
      advancedEnabled: this.s.advanced.enabled,
      smartGroupTurns: this.s.smartGroupTurns,
      teachSidecar: this.s.teachSidecar,
      publicWebhook: { enabled: this.s.publicWebhook.enabled, url: this.s.publicWebhook.enabled ? this.s.publicWebhook.url : null },
      webhookLan: this.s.webhookLan,
      webhookLanError: this.lanError,
      saveUsage: this.s.saveUsage,
      computerPerception: this.s.computerPerception ?? "screenshots",
      ...this.savings(),
      trustedRecipients: this.trusted(),
      rev: this.revNow(),
      epoch: this.epoch,
    };
  }

  update(patch: GatewayCommands["setHostSettings"]["args"]): HostSettingsView {
    const next: HostSettings = structuredClone(this.s);
    if (patch.autoReviewEnabled !== undefined) next.autoReviewEnabled = Boolean(patch.autoReviewEnabled);
    if (patch.allowInstructions) next.autoReviewInstructions.allowInstructions = normalizeRules(patch.allowInstructions, "Allow automatically");
    if (patch.blockInstructions) next.autoReviewInstructions.blockInstructions = normalizeRules(patch.blockInstructions, "Ask first");
    if (patch.userTimeZone !== undefined) next.userTimeZoneOverride = patch.userTimeZone || null;
    if (patch.themePreference !== undefined) {
      if (!["system", "light", "dark"].includes(patch.themePreference)) throw new GatewayError("BAD_THEME", "Theme must be system, light or dark.");
      next.themePreference = patch.themePreference;
    }
    if (patch.memoryRecall !== undefined) next.memoryRecall = Boolean(patch.memoryRecall);
    if (patch.advancedEnabled !== undefined) next.advanced = { ...next.advanced, enabled: Boolean(patch.advancedEnabled) };
    if (patch.smartGroupTurns !== undefined) next.smartGroupTurns = Boolean(patch.smartGroupTurns);
    if (patch.teachSidecar !== undefined) next.teachSidecar = Boolean(patch.teachSidecar);
    if (patch.publicWebhook !== undefined) {
      const enabled = Boolean(patch.publicWebhook.enabled);
      next.publicWebhook = { enabled, url: enabled ? this.s.publicWebhook.url : null }; // the URL is set only by the tunnel (Task 18)
    }
    if (patch.webhookLan !== undefined) next.webhookLan = Boolean(patch.webhookLan);
    if (patch.saveUsage !== undefined) next.saveUsage = Boolean(patch.saveUsage);
    if (patch.computerPerception !== undefined) {
      if (patch.computerPerception === "live" && !LIVE_PERCEPTION_ENABLED) throw new GatewayError("BAD_PERCEPTION", LIVE_SHELVED_MESSAGE);
      if (!(COMPUTER_PERCEPTION_MODES as readonly string[]).includes(patch.computerPerception)) throw new GatewayError("BAD_PERCEPTION", "Computer perception must be Screenshots.");
      next.computerPerception = patch.computerPerception;
    }
    if (patch.promptCacheTtl !== undefined) {
      if (!isPromptCacheTtl(patch.promptCacheTtl)) throw new GatewayError("BAD_SETTING", "Keep conversations ready must be 1 hour or 5 minutes.");
      next.promptCacheTtl = patch.promptCacheTtl;
    }
    if (patch.callReplies !== undefined) {
      if (!isCallReplies(patch.callReplies)) throw new GatewayError("BAD_SETTING", "Call replies must be Default, Fast on the whole call or Match the Bot.");
      next.callReplies = patch.callReplies;
    }
    if (patch.longContext !== undefined) {
      if (!isLongContextMode(patch.longContext)) throw new GatewayError("BAD_SETTING", "Long-context model must be On or Only when needed.");
      next.longContext = patch.longContext;
    }
    if (patch.trustedRecipients !== undefined) {
      const list = normalizeTrusted(patch.trustedRecipients);
      if (typeof list === "string") throw new GatewayError("BAD_SETTING", list);
      next.trustedRecipients = list;
    }
    this.save(next);
    return this.view();
  }

  /** Smarter approvals: the trusted list, re-checked on read (a hand-edited file can't smuggle in a non-address). */
  trusted(): string[] {
    const list = normalizeTrusted(this.s.trustedRecipients ?? []);
    return typeof list === "string" ? [] : list;
  }

  /**
   * Bug 52: why the last "Reachable on your local network" change did not take effect, or null. Set
   * only by the host's re-bind, never saved: it describes this run's listener, not a preference.
   */
  setWebhookLanError(message: string | null): void {
    if (this.lanError === message) return;
    this.lanError = message;
    this.onChange?.(this.view());
  }

  /** Set by the host when the tunnel reports (or loses) its URL; never set by the UI. */
  setPublicWebhookUrl(url: string | null): void {
    const next: HostSettings = structuredClone(this.s);
    next.publicWebhook = { ...next.publicWebhook, url };
    this.save(next);
  }

  memoryRecallOn(): boolean {
    return this.s.memoryRecall;
  }

  /** APR-12: append, skip duplicates, keep the newest 20. */
  addAllowRule(rule: string): { added: boolean; rule: string } {
    const r = rule.trim().slice(0, LIMITS.ruleMaxChars);
    const list = this.s.autoReviewInstructions.allowInstructions;
    if (!r || list.includes(r)) return { added: false, rule: r };
    const next: HostSettings = structuredClone(this.s);
    next.autoReviewInstructions.allowInstructions = [...list, r].slice(-LIMITS.rulesPerList);
    this.save(next);
    return { added: true, rule: r };
  }

  setPinned(id: string, pinned: boolean): string[] {
    const next: HostSettings = structuredClone(this.s);
    const without = next.pinnedAgentIds.filter((x) => x !== id);
    next.pinnedAgentIds = pinned ? [...without, id] : without;
    if (pinned && this.s.pinnedAgentIds.includes(id)) next.pinnedAgentIds = this.s.pinnedAgentIds;
    this.save(next);
    return [...this.s.pinnedAgentIds];
  }

  removeBot(id: string): void {
    if (this.s.pinnedAgentIds.includes(id)) this.setPinned(id, false);
  }

  /** Phase 5 settings keys (SET-17: memoryMode, weeklyBudget, mcpDisabledToolsByServerId, …) live beside Phase 1's fields. */
  extra<T>(key: string, fallback: T): T {
    const v = (this.s as unknown as Record<string, unknown>)[key];
    return v === undefined ? fallback : (v as T);
  }

  setExtra(key: string, value: unknown, notify = false): void {
    const next = structuredClone(this.s) as unknown as Record<string, unknown>;
    next[key] = value;
    this.save(next as unknown as HostSettings, notify);
  }

  setCompiled(map: Record<string, unknown>): void {
    const next: HostSettings = structuredClone(this.s);
    next.autoReviewCompiled = map;
    this.save(next, false);
  }

  private revNow(): number {
    return typeof this.s.rev === "number" && Number.isFinite(this.s.rev) ? this.s.rev : 0;
  }

  rulesVersion(): string {
    const { allowInstructions, blockInstructions } = this.s.autoReviewInstructions;
    return createHash("sha256").update(JSON.stringify([allowInstructions, blockInstructions])).digest("hex").slice(0, 16);
  }

  /** Disk first, memory second: a save that could not be written leaves the store — and so the
   * view the UI renders — exactly as it was, and tells the caller why in words it can show the
   * user. A settings change that silently does nothing is how "I can't even turn it into light
   * mode" stayed invisible. */
  private save(next: HostSettings, notify = true): void {
    next = { ...next, rev: this.revNow() + 1 };
    try {
      writeJsonAtomic(this.file, next, 0o640);
    } catch (e) {
      const reason = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      log.error("host settings could not be saved", { file: this.file, error: String(e) });
      throw new GatewayError("SETTINGS_NOT_SAVED", `Your settings could not be saved to ${this.file} (${reason}). Nothing was changed.`, 500);
    }
    this.s = next;
    if (notify) this.onChange?.(this.view());
  }
}
