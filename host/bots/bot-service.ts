import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AVATAR_COLORS, AVATAR_MATERIALS, AVATAR_MOTIONS, DEFAULT_AVATAR_SHAPE, normalizeAvatarColor, normalizeAvatarShape, LIMITS, STR, activityEntryId, isAgentMessage, isEffortLevel, isModelId, isSafeFolderId,
  type Activity, type AvatarMaterial, type AvatarMotion, type AvatarShape, type AwaitingUser, type BotProfile, type BotSettings, type BotSummary, type EffortLevel, type ModelId,
  type Presence, type SidebarMarker, type TranscriptEntry, type UserMessageEntry,
} from "@synapse/shared";
import { ANIM_LIMITS, validateAvatarClip, type AvatarClip } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { SseHub } from "../gateway/sse-hub";
import { BotStore } from "../store/bot-store";
import type { HostSettingsStore } from "../store/host-settings";
import { agentsDir, botDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import type { BotAccounts } from "../walls/bot-accounts";
import { cliSessionFile } from "../walls/bot-uid";


type RosterOp = "added" | "removed" | "renamed";
interface RosterChange { id: string; name: string; op: RosterOp }
export interface RuntimeView { presence: Presence; activity: Activity | null; running: boolean }
export interface BotRecord { id: string; store: BotStore; profile: BotProfile; settings: BotSettings; group: { memberIds: string[] } | null }
interface UnreadState { lastActivityAt: number; lastViewedAt: number; isManuallyUnread: boolean; unreadCount: number }
interface Counters { userSeq: number; turnNo: number; userMessageEpoch: number }

export function markerOf(s: { awaiting: AwaitingUser | null; unread: boolean; running: boolean }): SidebarMarker {
  if (s.awaiting) return "blocked";
  if (s.unread) return "unread";
  return s.running ? "working" : null;
}

const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
const stripMarkdown = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#>~]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").trim();
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)] as T;
const defaultUnread = (): UnreadState => ({ lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 });

/** A profile.json is the host's file, but it is re-validated on load anyway: only clips that pass the
 *  DSL's validator reach the renderer, and never more than the cap. */
function cleanClips(v: unknown): AvatarClip[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AvatarClip[] = [];
  for (const c of v) { const r = validateAvatarClip(c); if (r.ok && out.length < ANIM_LIMITS.maxClips && !out.some((o) => o.name === r.clip.name)) out.push(r.clip); }
  return out;
}
/** Bug 292: an id saved or sent before the rename is accepted and stored as its Synapse id. */
function checkAvatarShape(shape: AvatarShape): AvatarShape {
  const s = normalizeAvatarShape(shape);
  if (!s) throw new GatewayError("BAD_AVATAR", "Unknown avatar shape.");
  return s;
}
function checkAvatarColor(color: string): string {
  const c = normalizeAvatarColor(color);
  if (!c) throw new GatewayError("BAD_AVATAR", "Unknown avatar color.");
  return c;
}
function checkAvatarMaterial(material: AvatarMaterial): void {
  if (!(AVATAR_MATERIALS as readonly string[]).includes(material)) throw new GatewayError("BAD_AVATAR", "Unknown avatar material.");
}
function checkAvatarMotion(motion: AvatarMotion): void {
  if (!(AVATAR_MOTIONS as readonly string[]).includes(motion)) throw new GatewayError("BAD_AVATAR", "Unknown avatar motion.");
}

export class BotService {
  private bots = new Map<string, BotRecord>();
  private runtimeView: (id: string) => RuntimeView = () => ({ presence: "idle", activity: null, running: false });
  private now: () => number;
  private visibleHooks = new Set<(botId: string, entry: TranscriptEntry) => void>();
  /** 4.3b: connector modules copy the source's account grants onto a user-made copy. */
  private duplicateHooks = new Set<(srcId: string, copyId: string, origin: "user" | "bot") => void>();
  /** settings-persist: each Bot's publish sequence, and this run's id (BotSummary.rev / .epoch). */
  private revs = new Map<string, number>();
  readonly epoch = randomUUID();

  /** `deleteSession`: removes a real-brain session file through the root-owned helper (box only, gate M-2). */
  constructor(private d: {
    cfg: HostConfig; hub: SseHub; settings: HostSettingsStore; now?: () => number; deleteSession?: (file: string) => void;
    /** Bug #66: per-Bot OS accounts (walls/bot-accounts.ts); absent = every Bot runs as box. */
    accounts?: BotAccounts;
  }) {
    this.now = d.now ?? Date.now;
  }

  setRuntimeView(fn: (id: string) => RuntimeView): void {
    this.runtimeView = fn;
  }

  loadAll(): void {
    for (const ent of fs.readdirSync(agentsDir(this.d.cfg), { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      // Controller ruling (Task 5): botDir() throws GatewayError("INVALID_BOT_ID", …) for non-UUID ids.
      // Filter stray non-UUID folders before calling it so listing doesn't throw on them.
      if (!isSafeFolderId(ent.name)) continue;
      const dir = botDir(this.d.cfg, ent.name);
      const profile = readJson<BotProfile | null>(path.join(dir, "profile.json"), null);
      if (!profile) continue;
      if (profile.avatarAnimations !== undefined) profile.avatarAnimations = cleanClips(profile.avatarAnimations);
      // Bug 292: a profile saved with the old avatar ids shows (and is saved next time) with the Synapse ones.
      profile.avatarShape = normalizeAvatarShape(profile.avatarShape) ?? DEFAULT_AVATAR_SHAPE;
      profile.avatarColor = normalizeAvatarColor(profile.avatarColor) ?? profile.avatarColor;
      const settings = readJson<BotSettings>(path.join(dir, "settings.json"), { notifyOnAgentUpdates: true, hiddenFromSidebar: false });
      const groupFile = readJson<{ version: 1; memberIds: string[] } | null>(path.join(dir, "group.json"), null);
      this.bots.set(ent.name, { id: ent.name, store: new BotStore(path.join(dir, "store.db")), profile, settings, group: groupFile ? { memberIds: [...groupFile.memberIds] } : null });
      if (!groupFile) this.d.accounts?.ensure(ent.name); // bug #66: idempotent; re-applies the account's layout
    }
  }

  ids(): string[] {
    return [...this.bots.keys()];
  }
  has(id: string): boolean {
    return this.bots.has(id);
  }
  require(id: string): BotRecord {
    const b = this.bots.get(id);
    if (!b) throw new GatewayError("NOT_FOUND", "No such Bot.", 404);
    return b;
  }

  activeAgentId(): string | null {
    return readJson<{ activeAgentId: string | null }>(path.join(agentsDir(this.d.cfg), "active-agent.json"), { activeAgentId: null }).activeAgentId;
  }
  private setActive(id: string | null): void {
    writeJsonAtomic(path.join(agentsDir(this.d.cfg), "active-agent.json"), { activeAgentId: id }, 0o640);
  }

  create(a: { name?: string; description?: string; title?: string; avatarShape?: AvatarShape; avatarColor?: string; avatarMaterial?: AvatarMaterial; avatarMotion?: AvatarMotion; effort?: EffortLevel; model?: ModelId; origin: "user" | "bot"; kickstart: boolean; group?: { memberIds: string[] } }): string {
    if (this.bots.size >= LIMITS.maxBots) throw new GatewayError("MAX_BOTS", STR.maxBots, 409);
    const shape = a.avatarShape !== undefined ? checkAvatarShape(a.avatarShape) : undefined;
    const color = a.avatarColor !== undefined ? checkAvatarColor(a.avatarColor) : undefined;
    if (a.avatarMaterial !== undefined) checkAvatarMaterial(a.avatarMaterial);
    if (a.avatarMotion !== undefined) checkAvatarMotion(a.avatarMotion);
    if (a.effort !== undefined && !isEffortLevel(a.effort)) throw new GatewayError("BAD_ARGS", "Unknown effort.");
    const id = randomUUID();
    const dir = botDir(this.d.cfg, id);
    fs.mkdirSync(dir, { recursive: true });
    // Bug #66: the account (and its staging dirs' group) exists before anything is staged for the Bot.
    if (!a.group) this.d.accounts?.ensure(id);
    const profile: BotProfile = {
      name: collapse(a.name ?? "") || STR.newBotName,
      title: (a.title ?? "").trim().slice(0, 24),
      description: a.description ?? "",
      avatarShape: shape ?? DEFAULT_AVATAR_SHAPE,
      avatarColor: color ?? pick(AVATAR_COLORS.slice(1)),
      avatarKind: "shape",
      avatarMotion: a.avatarMotion ?? "curious",
      ...(a.avatarMaterial ? { avatarMaterial: a.avatarMaterial } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.model ? { model: a.model } : {}),
    };
    const settings: BotSettings = { notifyOnAgentUpdates: true, hiddenFromSidebar: false };
    writeJsonAtomic(path.join(dir, "profile.json"), profile, 0o640);
    writeJsonAtomic(path.join(dir, "settings.json"), settings, 0o640);
    if (a.group) writeJsonAtomic(path.join(dir, "group.json"), { version: 1, memberIds: a.group.memberIds }, 0o640);
    const store = new BotStore(path.join(dir, "store.db"));
    const t = this.now();
    store.setKv("createdAt", t);
    store.setKv("updatedAt", t);
    store.setKv("origin", a.origin);
    store.setKv("counters", { userSeq: 0, turnNo: 0, userMessageEpoch: 0 } satisfies Counters);
    if (a.kickstart && !a.group) store.setKv("introductionPending", "1");
    this.bots.set(id, { id, store, profile, settings, group: a.group ? { memberIds: [...a.group.memberIds] } : null });
    this.appendEntry(id, {
      kind: "event", id: activityEntryId("b", 1), createdAt: t,
      event: a.group ? { type: "group-created", groupId: id, name: profile.name } : { type: "bot-created", botId: id, name: profile.name },
    });
    this.publish(id);
    this.invalidatePromptSnapshots();
    this.noteRosterChange(id, "added", profile.name);
    return id;
  }

  update(id: string, patch: { name?: string; title?: string; description?: string; model?: ModelId; avatarShape?: AvatarShape; avatarColor?: string; avatarMaterial?: AvatarMaterial; avatarMotion?: AvatarMotion; effort?: EffortLevel }): BotSummary {
    const b = this.require(id);
    const next: BotProfile = { ...b.profile };
    if (patch.name !== undefined) {
      const name = collapse(patch.name);
      if (!name) throw new GatewayError("BLANK_NAME", "The name can't be blank.");
      next.name = name;
    }
    if (patch.title !== undefined) next.title = patch.title.trim().slice(0, 24);
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.model !== undefined) {
      if (!isModelId(patch.model)) throw new GatewayError("BAD_MODEL", `Unknown model ${String(patch.model)}`);
      next.model = patch.model;
    }
    if (patch.avatarShape !== undefined) {
      next.avatarShape = checkAvatarShape(patch.avatarShape);
    }
    if (patch.avatarColor !== undefined) {
      next.avatarColor = checkAvatarColor(patch.avatarColor);
    }
    if (patch.avatarMaterial !== undefined) {
      checkAvatarMaterial(patch.avatarMaterial);
      next.avatarMaterial = patch.avatarMaterial;
    }
    if (patch.avatarMotion !== undefined) {
      checkAvatarMotion(patch.avatarMotion);
      next.avatarMotion = patch.avatarMotion;
    }
    if (patch.effort !== undefined) {
      if (!isEffortLevel(patch.effort)) throw new GatewayError("BAD_ARGS", "Unknown effort.");
      next.effort = patch.effort;
    }
    const changed: string[] = [];
    if (next.name !== b.profile.name) changed.push(`name "${next.name}"`);
    if (next.title !== b.profile.title) changed.push(`label "${next.title}"`);
    if (next.description !== b.profile.description) changed.push("description (see your instructions)");
    if (next.name !== b.profile.name) this.noteRosterChange(id, "renamed", next.name);
    if (changed.length) b.store.setKv("profileUpdatePending", `Your profile was updated: ${changed.join(", ")}. Current description: ${next.description || "(empty)"}`);
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "profile.json"), next, 0o640);
    b.profile = next;
    b.store.setKv("updatedAt", this.now());
    this.publish(id);
    return this.summary(id);
  }

  /** BOT-18: image avatars live in the Bot folder as avatar.<ext>; the profile records the kind and a version for cache-busting. */
  setAvatarImage(id: string, ext: "png" | "jpg" | "webp" | "gif" | "svg" | null): BotSummary {
    const rec = this.require(id);
    rec.profile = { ...rec.profile, avatarKind: ext ? "image" : "shape", avatarVersion: (rec.profile.avatarVersion ?? 0) + 1 };
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "profile.json"), rec.profile, 0o640);
    this.publish(id);
    return this.summary(id);
  }

  /** Bot-authored avatar animations: the caller has validated every clip (update_state target "avatar"). */
  setAvatarAnimations(id: string, clips: AvatarClip[], cue?: { name: string }): BotSummary {
    const rec = this.require(id);
    const next: BotProfile = { ...rec.profile, avatarAnimations: clips };
    if (!clips.length) delete next.avatarAnimations;
    if (cue) next.avatarCue = { name: cue.name, seq: (rec.profile.avatarCue?.seq ?? 0) + 1 };
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "profile.json"), next, 0o640);
    rec.profile = next;
    this.publish(id);
    return this.summary(id);
  }

  remove(id: string): void {
    const b = this.require(id);
    this.noteRosterChange(id, "removed", b.profile.name);
    // Current session plus every rolled-over one (Phase 2 rollover keeps older root-owned files).
    // I6: child subagent sessions (recorded as they start) are this Bot's session files too.
    const rolled = [...this.brainKv<{ file: string }[]>(id, "rolledSessionFiles", []), ...this.brainKv<{ file: string }[]>(id, "previousSessionIds", []), ...this.brainKv<{ file: string }[]>(id, "childSessionFiles", [])];
    const sessionFiles = [...new Set([this.sessionFilePath(id), ...rolled.map((r) => r.file)].filter((f): f is string => typeof f === "string" && f.length > 0))];
    b.store.close();
    this.bots.delete(id);
    fs.rmSync(botDir(this.d.cfg, id), { recursive: true, force: true });
    // A real-brain session file lives under ~/.claude/projects/**, which is box:bots-owned —
    // bothost has no write bits there (see host/brain/conformance/session-file.ts). `{ force: true }`
    // only suppresses ENOENT, not EACCES, so this can throw against the real box (Task 34 Bug 1).
    // Same pattern as the CT-14 cleanupSynthesizedSession helper: EACCES is best-effort, anything
    // else still propagates. On the real box, app.ts injects `deleteSession` (the root-owned
    // bot-claude-delete-session helper, gate M-2), which actually removes the file.
    for (const sessionFile of sessionFiles) {
      if (this.d.deleteSession) { this.d.deleteSession(sessionFile); continue; }
      try {
        fs.rmSync(sessionFile, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
        log.warn("could not remove real-brain session file (bothost has no write bits there)", { id, sessionFile, error: String(err) });
      }
    }
    this.d.accounts?.remove(id); // bug #66: after its session files; kills its processes, frees its uid, deletes its home
    this.d.settings.removeBot(id);
    let active = this.activeAgentId();
    if (active === id || (active && !this.bots.has(active))) {
      const newest = [...this.bots.values()].sort((x, y) => y.store.getKv<number>("updatedAt", 0) - x.store.getKv<number>("updatedAt", 0))[0];
      active = newest?.id ?? null;
      this.setActive(active);
    }
    this.d.hub.publish({ channel: "agents", payload: { removedId: id, activeAgentId: active } });
    this.invalidatePromptSnapshots();
  }

  /** B2B-07 / RTN-21: roster or routine-list changes re-render the appended prompt on the Bot's next spawn (one respawn; rare). */
  invalidatePromptSnapshots(botId?: string): void {
    const targets = botId ? [this.bots.get(botId)].filter((b): b is BotRecord => Boolean(b)) : [...this.bots.values()];
    for (const b of targets) b.store.deleteKv("agentProfilePromptSnapshot");
  }

  open(id: string): BotSummary {
    const b = this.require(id);
    this.setActive(id);
    const u = b.store.getKv<UnreadState>("unreadState", defaultUnread());
    b.store.setKv("unreadState", { ...u, lastViewedAt: this.now(), isManuallyUnread: false, unreadCount: 0 });
    this.publish(id);
    return this.summary(id);
  }

  setPinned(id: string, pinned: boolean): string[] {
    this.require(id);
    return this.d.settings.setPinned(id, pinned);
  }

  /** BOT-08 copy set: profile, settings (hidden forced off), enabled skills, avatar, routine definitions. Not conversation, memory, projects or attachments. */
  /** 4.3b: called after a Bot is duplicated (the copy exists, its settings copied). */
  onDuplicate(fn: (srcId: string, copyId: string, origin: "user" | "bot") => void): void { this.duplicateHooks.add(fn); }

  duplicate(id: string, origin: "user" | "bot" = "user"): string {
    const src = this.require(id);
    const srcDir = botDir(this.d.cfg, id);
    if (fs.existsSync(path.join(srcDir, "group.json"))) throw new GatewayError("GROUP_DUPLICATE", STR.groupsCantDuplicate, 409);
    const p = src.profile;
    const copy = this.create({
      name: `${p.name}${STR.copySuffix}`, title: p.title, description: p.description, avatarShape: p.avatarShape, avatarColor: p.avatarColor,
      ...(p.avatarMaterial ? { avatarMaterial: p.avatarMaterial } : {}),
      ...(p.avatarMotion ? { avatarMotion: p.avatarMotion } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.model ? { model: p.model } : {}), origin, kickstart: false,
    });
    const dst = botDir(this.d.cfg, copy);
    // ORIG-GOOGLE: Google access is the user's per-Bot choice; a copy a Bot makes starts with it off.
    // Bug 258: No limits is confirmed per Bot, never copied (a copy starts in the source's mode without it).
    const { archived: _a, google, noLimits: _nl, ...keep } = src.settings;
    this.updateSettings(copy, { ...keep, hiddenFromSidebar: false, ...(origin === "user" && google ? { google } : {}) });
    const wf = path.join(srcDir, "enabled-workflows.json");
    if (fs.existsSync(wf)) fs.copyFileSync(wf, path.join(dst, "enabled-workflows.json"));
    for (const f of fs.readdirSync(srcDir)) if (/^avatar\.(png|jpg|webp|gif|svg)$/.test(f)) fs.copyFileSync(path.join(srcDir, f), path.join(dst, f));
    const autos = path.join(srcDir, "automations");
    if (fs.existsSync(autos)) {
      for (const r of fs.readdirSync(autos, { withFileTypes: true })) {
        const def = readJson<Record<string, unknown> | null>(path.join(autos, r.name, "automation.json"), null);
        if (!r.isDirectory() || !def) continue;
        // Copied as-is (Active stays Active, BOT-08), minus run state and the webhook identity, which must stay unique per routine.
        delete def.lastRunAt;
        delete def.webhook;
        delete def.raisedNotices;
        writeJsonAtomic(path.join(dst, "automations", r.name, "automation.json"), def, 0o640);
      }
    }
    this.publish(copy);
    for (const fn of this.duplicateHooks) { try { fn(id, copy, origin); } catch { /* a connector's copy is best effort */ } }
    return copy;
  }

  /** ORIG-17 ArchiveAgent: hidden from the sidebar and marked archived; reversible. */
  setArchived(id: string, archived: boolean): BotSummary {
    return this.updateSettings(id, { archived, hiddenFromSidebar: archived });
  }

  updateSettings(id: string, patch: Partial<BotSettings>): BotSummary {
    const b = this.require(id);
    const next: BotSettings = { ...b.settings, ...patch };
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "settings.json"), next, 0o640);
    b.settings = next;
    b.store.setKv("updatedAt", this.now());
    this.publish(id);
    return this.summary(id);
  }

  setGroupMemberIds(id: string, memberIds: string[]): BotSummary {
    const b = this.require(id);
    if (!b.group) throw new GatewayError("NOT_A_GROUP", "Not a group.", 400);
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "group.json"), { version: 1, memberIds }, 0o640);
    b.group = { memberIds: [...memberIds] };
    b.store.setKv("updatedAt", this.now());
    this.publish(id);
    return this.summary(id);
  }

  summary(id: string): BotSummary {
    const b = this.require(id);
    const rt = this.runtimeView(id);
    const awaiting = b.store.getKv<AwaitingUser | null>("awaitingUserResponse", null);
    const u = b.store.getKv<UnreadState>("unreadState", defaultUnread());
    const unread = u.isManuallyUnread || u.unreadCount > 0;
    return {
      id, profile: b.profile, settings: b.settings, presence: rt.presence, activity: rt.activity, running: rt.running, awaiting,
      marker: markerOf({ awaiting, unread, running: rt.running }),
      statusLine: awaiting?.reason ?? b.store.getKv<string>("lastPreview", ""),
      createdAt: b.store.getKv<number>("createdAt", 0),
      updatedAt: b.store.getKv<number>("updatedAt", 0),
      lastBotMessageAt: b.store.getKv<number>("lastBotMessageAt", 0),
      ...(b.store.getKv<boolean>("lastBotMessageQuiet", false) ? { lastBotMessageQuiet: true } : { lastBotMessageQuiet: false }),
      group: b.group ? { memberIds: [...b.group.memberIds] } : null,
      archived: b.settings.archived ?? false,
      rev: this.revs.get(id) ?? 0,
      epoch: this.epoch,
    };
  }

  list(): BotSummary[] {
    return this.ids().map((id) => this.summary(id)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  publish(id: string): void {
    if (!this.bots.has(id)) return;
    // settings-persist: every published change moves the Bot's sequence on, so a snapshot computed before it
    // (a slower response, the startup list) is recognisably older than the event that carries it.
    this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
    this.d.hub.publish({ channel: "agent-upserted", payload: { agent: this.summary(id) } });
  }

  /** CHAT-23: called synchronously before a visible entry (send-message, or an outbound agent message) is stored. */
  onBeforeVisibleAppend(fn: (botId: string, entry: TranscriptEntry) => void): () => void {
    this.visibleHooks.add(fn);
    return () => this.visibleHooks.delete(fn);
  }

  /** Ids for writes outside a turn (peer deliveries, host events): a fresh turn number each call, so `t<n>a<k>` never collides. */
  auxEntryIds(id: string, n: number): string[] {
    const turn = this.nextTurnNo(id);
    return Array.from({ length: n }, (_, k) => activityEntryId(turn, k + 1));
  }

  // ---- transcript ----
  appendEntry(id: string, entry: TranscriptEntry): void {
    const visible = entry.kind === "send-message" || (entry.kind === "message" && isAgentMessage(entry) && Boolean(entry.toAgent));
    if (visible) for (const h of this.visibleHooks) h(id, entry);
    this.require(id).store.append(entry);
    this.d.hub.publish({ channel: "transcript", payload: { botId: id, op: "append", entry } });
  }
  updateEntry(id: string, entry: TranscriptEntry): void {
    this.require(id).store.update(entry);
    this.d.hub.publish({ channel: "transcript", payload: { botId: id, op: "update", entry } });
  }
  getEntry(id: string, entryId: string): TranscriptEntry | null {
    return this.require(id).store.get(entryId);
  }
  tail(id: string, limit: number): TranscriptEntry[] {
    return this.require(id).store.tail(limit);
  }
  publishTyping(id: string, typing: boolean, partialText: string | null): void {
    this.d.hub.publish({ channel: "transcript", payload: { botId: id, op: "typing", typing, partialText } });
  }

  // ---- counters and kv ----
  private counters(id: string): Counters {
    return this.require(id).store.getKv<Counters>("counters", { userSeq: 0, turnNo: 0, userMessageEpoch: 0 });
  }
  private setCounters(id: string, c: Counters): void {
    this.require(id).store.setKv("counters", c);
  }
  nextUserSeq(id: string): number {
    const c = this.counters(id);
    c.userSeq += 1;
    this.setCounters(id, c);
    return c.userSeq;
  }
  latestUserSeq(id: string): number {
    return this.counters(id).userSeq;
  }
  nextTurnNo(id: string): number {
    const c = this.counters(id);
    c.turnNo += 1;
    this.setCounters(id, c);
    return c.turnNo;
  }
  userMessageEpoch(id: string): number {
    return this.counters(id).userMessageEpoch;
  }
  bumpUserMessageEpoch(id: string): number {
    const c = this.counters(id);
    c.userMessageEpoch += 1;
    this.setCounters(id, c);
    return c.userMessageEpoch;
  }
  confirmedUserSeq(id: string): number {
    return this.require(id).store.getKv<number>("confirmedUserSeq", 0);
  }
  confirmUserSeq(id: string, n: number): void {
    if (n > this.confirmedUserSeq(id)) this.require(id).store.setKv("confirmedUserSeq", n);
  }
  /** Agent entries are never the user's words (§4.3, decision 6). */
  userMessagesAfter(id: string, seq: number): UserMessageEntry[] {
    return this.require(id).store.tail(500).filter(
      (e): e is UserMessageEntry => e.kind === "message" && !isAgentMessage(e) && /^t\d+u$/.test(e.id) && Number(e.id.slice(1, -1)) > seq,
    );
  }
  sessionId(id: string): string | null {
    return this.require(id).store.getKv<{ sessionId: string | null }>("brain", { sessionId: null }).sessionId;
  }
  setSessionId(id: string, sessionId: string): void {
    const b = this.require(id);
    const brain = b.store.getKv<Record<string, unknown>>("brain", {});
    b.store.setKv("brain", { ...brain, sessionId, model: b.profile.model ?? "claude-sonnet-5", createdAt: this.now(), compactionEpoch: (brain.compactionEpoch as number | undefined) ?? 0 });
  }
  clearSessionId(id: string): void {
    const b = this.require(id);
    const brain = b.store.getKv<Record<string, unknown>>("brain", {});
    b.store.setKv("brain", { ...brain, sessionId: null });
  }
  sessionFilePath(id: string): string | null {
    const sid = this.sessionId(id);
    return sid ? cliSessionFile(this.d.cfg, id, sid) : null; // bug #66: the Bot's own config dir once migrated
  }
  recordRequestId(id: string, rec: { id: string; at: number; prompt: string; source: string }): void {
    const b = this.require(id);
    const list = b.store.getKv<typeof rec[]>("requestIds", []);
    b.store.setKv("requestIds", [...list, { ...rec, prompt: rec.prompt.slice(0, 200) }].slice(-LIMITS.requestIdLedger));
  }
  setAwaiting(id: string, a: AwaitingUser | null): void {
    const b = this.require(id);
    if (a) b.store.setKv("awaitingUserResponse", a);
    else b.store.deleteKv("awaitingUserResponse");
    this.publish(id);
  }
  noteBotMessage(id: string, text: string, o: { quiet?: boolean } = {}): void {
    const b = this.require(id);
    const t = this.now();
    b.store.setKv("lastBotMessageQuiet", o.quiet === true);
    b.store.setKv("lastPreview", stripMarkdown(text).slice(0, 200));
    b.store.setKv("lastBotMessageAt", t);
    b.store.setKv("updatedAt", t);
    const u = b.store.getKv<UnreadState>("unreadState", defaultUnread());
    const viewing = this.activeAgentId() === id;
    b.store.setKv("unreadState", { ...u, lastActivityAt: t, unreadCount: viewing ? 0 : u.unreadCount + 1, lastViewedAt: viewing ? t : u.lastViewedAt });
    this.publish(id);
  }
  seedNameIfDefault(id: string, text: string): void {
    const b = this.require(id);
    if (b.profile.name !== STR.newBotName || this.latestUserSeq(id) !== 1) return;
    const name = collapse(text).slice(0, LIMITS.nameSeedMax).trim();
    if (name) this.update(id, { name });
  }
  /**
   * A live Bot keeps the teammates list it was spawned with, so a Bot-list change is queued for every
   * other Bot as a tiny hidden reminder (changed names and ids only). Coalesced per id: added→renamed
   * stays "added" with the new name, added→removed cancels out, anything→removed is "removed".
   */
  private noteRosterChange(id: string, op: RosterOp, name: string): void {
    for (const other of this.bots.values()) {
      if (other.id === id) continue;
      const pending = other.store.getKv<RosterChange[]>("rosterUpdatePending", []);
      const i = pending.findIndex((c) => c.id === id);
      const prev = i >= 0 ? pending[i]! : null;
      if (prev) pending.splice(i, 1);
      if (prev?.op === "added" && op === "removed") { /* came and went: nothing to say */ }
      else pending.push({ id, name, op: prev?.op === "added" && op === "renamed" ? "added" : op });
      if (pending.length) other.store.setKv("rosterUpdatePending", pending);
      else other.store.deleteKv("rosterUpdatePending");
    }
  }
  takeRosterUpdate(id: string): string | null {
    const b = this.bots.get(id);
    if (!b) return null;
    const pending = b.store.getKv<RosterChange[]>("rosterUpdatePending", []);
    if (!pending.length) return null;
    b.store.deleteKv("rosterUpdatePending");
    return `Your Bot list changed: ${pending.map((c) => `${c.op} ${c.name} (id: ${c.id})`).join("; ")}.`;
  }
  takeProfileUpdate(id: string): string | null {
    const b = this.require(id);
    const v = b.store.getKv<string | null>("profileUpdatePending", null);
    if (v) b.store.deleteKv("profileUpdatePending");
    return v;
  }
  /**
   * Engineering mode switch: a one-time notice for the Bot's next turn (taken with the profile/roster
   * reminders). Two switches before that turn collapse into one; a switch back to where the Bot last
   * was cancels the notice, since its prompt never changed as far as it can tell.
   */
  noteModeChange(id: string, from: boolean, to: boolean, text: string): void {
    const b = this.require(id);
    const prev = b.store.getKv<{ from: boolean; text: string } | null>("modeChangePending", null);
    const origin = prev ? prev.from : from;
    if (origin === to) b.store.deleteKv("modeChangePending");
    else b.store.setKv("modeChangePending", { from: origin, text });
  }
  takeModeUpdate(id: string): string | null {
    const b = this.require(id);
    const v = b.store.getKv<{ from: boolean; text: string } | null>("modeChangePending", null);
    if (v) b.store.deleteKv("modeChangePending");
    return v?.text ?? null;
  }
  introductionPending(id: string): boolean {
    return this.require(id).store.getKv<string | null>("introductionPending", null) === "1";
  }
  clearIntroduction(id: string): void {
    this.require(id).store.deleteKv("introductionPending");
  }
  compactionEpoch(id: string): number {
    return this.require(id).store.getKv<{ compactionEpoch?: number }>("brain", {}).compactionEpoch ?? 0;
  }
  bumpCompactionEpoch(id: string): number {
    const b = this.require(id);
    const brain = b.store.getKv<Record<string, unknown>>("brain", {});
    const next = ((brain.compactionEpoch as number | undefined) ?? 0) + 1;
    b.store.setKv("brain", { ...brain, compactionEpoch: next });
    return next;
  }
  brainKv<T>(id: string, key: string, fallback: T): T {
    return this.require(id).store.getKv<T>(`brain.${key}`, fallback);
  }
  setBrainKv(id: string, key: string, value: unknown): void {
    this.require(id).store.setKv(`brain.${key}`, value);
  }
  /** BRAIN-03 / MEM-05 / CTX-03: the appended prompt (memory, skills, profile) is frozen per compaction epoch. */
  promptSnapshot(id: string, render: () => string): string {
    const b = this.require(id);
    const epoch = this.compactionEpoch(id);
    const snap = b.store.getKv<{ render: string; compactionEpoch: number } | null>("agentProfilePromptSnapshot", null);
    if (snap && snap.compactionEpoch === epoch) return snap.render;
    const r = render();
    b.store.setKv("agentProfilePromptSnapshot", { render: r, compactionEpoch: epoch });
    return r;
  }

  private writeSettings(id: string, next: BotSettings): BotSummary {
    const b = this.require(id);
    writeJsonAtomic(path.join(botDir(this.d.cfg, id), "settings.json"), next, 0o640);
    b.settings = next;
    b.store.setKv("updatedAt", this.now());
    this.publish(id);
    return this.summary(id);
  }

  /** BOT-10: hidden Bots keep running and receiving messages; hiding also unpins. */
  setHidden(id: string, hidden: boolean): BotSummary {
    const b = this.require(id);
    if (hidden) this.d.settings.removeBot(id);
    return this.writeSettings(id, { ...b.settings, hiddenFromSidebar: hidden });
  }

  setNotify(id: string, enabled: boolean): BotSummary {
    const b = this.require(id);
    return this.writeSettings(id, { ...b.settings, notifyOnAgentUpdates: enabled });
  }

  /** BOT-14 Mark as Unread / Read. */
  setUnread(id: string, unread: boolean): BotSummary {
    const b = this.require(id);
    const u = b.store.getKv<UnreadState>("unreadState", defaultUnread());
    b.store.setKv("unreadState", unread ? { ...u, isManuallyUnread: true } : { ...u, isManuallyUnread: false, unreadCount: 0, lastViewedAt: this.now() });
    this.publish(id);
    return this.summary(id);
  }
}
