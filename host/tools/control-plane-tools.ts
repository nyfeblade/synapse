import { AVATAR_COLORS, AVATAR_SHAPES, LIMITS, normalizeAvatarColor, normalizeAvatarShape, STR, isModelId, type AvatarShape, type BotSettings, type ModelId } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { CreationLedger } from "../runner/creation-ledger";
import type { StateTargetHandler, ToolProvider, TurnRunner } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import type { HostSettingsStore } from "../store/host-settings";
import { OWN_DESCRIPTION } from "./bot-tools";

export interface ControlPlaneDeps {
  bots: BotService;
  runner: Pick<TurnRunner, "deleteBot" | "kickstart">;
  creations: CreationLedger;
  settings: HostSettingsStore;
  routines: { removeBot(botId: string): void; pauseAll(botId: string): number; reindexBot(botId: string): void } | null;
  now(): number;
}

const err = (text: string): BotToolResult => ({ text, isError: true });
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Optional fields shared by CreateAgent and UpdateAgent (ORIG-17 §17.1). */
const OPTIONAL = {
  title: z.string().optional(),
  avatar_shape: z.string().optional(),
  avatar_color: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  speech_rate: z.number().min(0.5).max(2).optional(),
  spoken_language: z.string().optional(),
  notify_on_updates: z.boolean().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
};

interface Parsed { profile: { title?: string; avatarShape?: AvatarShape; avatarColor?: string; model?: ModelId }; settings: Partial<BotSettings>; pinned?: boolean }

function parseOptional(a: Record<string, unknown>): Parsed | string {
  const out: Parsed = { profile: {}, settings: {} };
  if (a.title !== undefined) out.profile.title = String(a.title);
  if (a.avatar_shape !== undefined) {
    const s = normalizeAvatarShape(a.avatar_shape); // bug 292: an old id still works
    if (!s) return `Unknown avatar_shape "${String(a.avatar_shape)}". Use one of: ${AVATAR_SHAPES.join(", ")}.`;
    out.profile.avatarShape = s;
  }
  if (a.avatar_color !== undefined) {
    const c = normalizeAvatarColor(a.avatar_color);
    if (!c) return `Unknown avatar_color "${String(a.avatar_color)}". Use one of: ${AVATAR_COLORS.join(", ")}.`;
    out.profile.avatarColor = c;
  }
  if (a.model !== undefined) {
    if (!isModelId(a.model)) return `Unknown model "${String(a.model)}".`;
    out.profile.model = a.model;
  }
  if (a.voice !== undefined) out.settings.voice = String(a.voice);
  if (a.speech_rate !== undefined) out.settings.speechRate = Number(a.speech_rate);
  if (a.spoken_language !== undefined) out.settings.spokenLanguage = String(a.spoken_language);
  if (a.notify_on_updates !== undefined) out.settings.notifyOnAgentUpdates = Boolean(a.notify_on_updates);
  if (a.hidden !== undefined) out.settings.hiddenFromSidebar = Boolean(a.hidden);
  if (a.pinned !== undefined) out.pinned = Boolean(a.pinned);
  return out;
}

function capError(d: ControlPlaneDeps, botId: string): string | null {
  if (d.creations.countSince(botId, HOUR) >= LIMITS.botCreatedBotsPerHour) return STR.botCreateHourCap;
  if (d.creations.countSince(botId, DAY) >= LIMITS.botCreatedBotsPerDay) return STR.botCreateDayCap;
  return null;
}

/** CHAT-03: the same inline row the UI posts, in the calling Bot's chat. */
function postCreatedRow(d: ControlPlaneDeps, callerId: string, newId: string, name: string): void {
  const [id] = d.bots.auxEntryIds(callerId, 1);
  d.bots.appendEntry(callerId, { kind: "event", id: id!, createdAt: d.now(), event: { type: "bot-created", botId: newId, name } });
}

function applyExtras(d: ControlPlaneDeps, id: string, p: Parsed): void {
  if (Object.keys(p.settings).length) d.bots.updateSettings(id, p.settings);
  if (p.pinned !== undefined) d.bots.setPinned(id, p.pinned);
}

export function controlPlaneProvider(d: ControlPlaneDeps): ToolProvider {
  return (botId: string, _slot: () => TurnSlot | null): BotToolDef[] => {
    const createAgent: BotToolDef = {
      name: "CreateAgent",
      description: "Create a new Bot with a name and standing instructions (description), and optionally its label, avatar, model, voice, notifications, pin and hide. Ask the user before creating several Bots. The new Bot does not run until you message it (unless kickstart is true).",
      readOnly: false,
      schema: { name: z.string(), description: z.string().optional(), ...OPTIONAL, kickstart: z.boolean().optional() },
      handler: async (a) => {
        const cap = capError(d, botId);
        if (cap) return err(cap);
        const name = String(a.name ?? "").trim();
        if (!name) return err("name is required.");
        const p = parseOptional(a);
        if (typeof p === "string") return err(p);
        let id: string;
        try {
          id = d.bots.create({ name, description: a.description === undefined ? undefined : String(a.description), ...p.profile, origin: "bot", kickstart: a.kickstart === true });
        } catch (e) {
          return err(e instanceof GatewayError ? e.message : String(e));
        }
        d.creations.record(botId); // counts even if the extras below fail
        applyExtras(d, id, p);
        postCreatedRow(d, botId, id, d.bots.summary(id).profile.name);
        if (a.kickstart === true) d.runner.kickstart(id);
        return { text: `Created agent "${d.bots.summary(id).profile.name}" (id: ${id}). Message it with SendToAgent` };
      },
    };

    const updateAgent: BotToolDef = {
      name: "UpdateAgent",
      description: "Update another Bot's or group's name, description, label, avatar, model, voice, notifications, pin, hide or archived state. Empty fields are left unchanged.",
      readOnly: false,
      schema: { agent_id: z.string(), name: z.string().optional(), description: z.string().optional(), ...OPTIONAL, archived: z.boolean().optional() },
      handler: async (a) => {
        const id = String(a.agent_id);
        if (!d.bots.has(id)) return err(`No Bot with id ${id}.`);
        // I7 ruling: standing instructions stay user-authored; a Bot can't rewrite its own through UpdateAgent.
        if (id === botId && a.description !== undefined && String(a.description).trim()) return err(OWN_DESCRIPTION);
        const p = parseOptional(a);
        if (typeof p === "string") return err(p);
        const before = d.bots.summary(id).profile.name;
        const patch: { name?: string; description?: string } & Parsed["profile"] = { ...p.profile };
        if (a.name !== undefined && String(a.name).trim()) patch.name = String(a.name);
        if (a.description !== undefined && String(a.description).trim()) patch.description = String(a.description);
        try {
          const s = d.bots.update(id, patch);
          applyExtras(d, id, p);
          if (a.archived !== undefined) d.bots.setArchived(id, Boolean(a.archived));
          if (s.profile.name !== before) {
            const [eid] = d.bots.auxEntryIds(id, 1);
            d.bots.appendEntry(id, { kind: "event", id: eid!, createdAt: d.now(), event: { type: "renamed", name: s.profile.name } });
          }
          return { text: `Updated agent "${s.profile.name}".` };
        } catch (e) {
          return err(e instanceof GatewayError ? e.message : String(e));
        }
      },
    };

    const duplicateAgent: BotToolDef = {
      name: "DuplicateAgent",
      description: "Duplicate a Bot: its profile, settings, enabled skills, avatar and routines (not its conversation or memory). Groups can't be duplicated.",
      readOnly: false,
      schema: { agent_id: z.string() },
      handler: async (a) => {
        const id = String(a.agent_id);
        if (!d.bots.has(id)) return err(`No Bot with id ${id}.`);
        if (d.bots.summary(id).group) return err(STR.groupsCantDuplicate);
        const cap = capError(d, botId);
        if (cap) return err(cap);
        let copy: string;
        try {
          copy = d.bots.duplicate(id, "bot");
        } catch (e) {
          return err(e instanceof GatewayError ? e.message : String(e));
        }
        d.creations.record(botId);
        d.routines?.pauseAll(copy); // I1: a Bot's duplicate starts with every copied routine PAUSED
        d.routines?.reindexBot(copy);
        const src = d.bots.summary(id).profile.name;
        const name = d.bots.summary(copy).profile.name;
        postCreatedRow(d, botId, copy, name);
        return { text: `Duplicated "${src}" as "${name}" (id: ${copy}). Message it with SendToAgent` };
      },
    };

    const archiveAgent: BotToolDef = {
      name: "ArchiveAgent",
      description: "Archive a Bot: hide it from the sidebar and pause all its routines. Undo with UpdateAgent archived:false.",
      readOnly: false,
      schema: { agent_id: z.string() },
      handler: async (a) => {
        const id = String(a.agent_id);
        if (!d.bots.has(id)) return err(`No Bot with id ${id}.`);
        if (id === botId) return err("Not archived: a Bot can't archive itself.");
        d.bots.setArchived(id, true);
        const n = d.routines?.pauseAll(id) ?? 0;
        return { text: `Archived "${d.bots.summary(id).profile.name}" and paused ${n} routine${n === 1 ? "" : "s"}. UpdateAgent with archived:false restores it.` };
      },
    };

    const deleteAgent: BotToolDef = {
      name: "DeleteAgent",
      description: "Permanently delete another Bot or a group, with its conversation and routines. Requires confirm:true. Auto-review always asks the user first unless an Allow rule names deleting Bots.",
      readOnly: false,
      schema: { agent_id: z.string(), confirm: z.boolean().optional() },
      handler: async (a) => {
        const id = String(a.agent_id);
        if (a.confirm !== true) return err("Not deleted: set confirm:true to delete.");
        if (id === botId) return err(STR.cantDeleteSelf);
        if (!d.bots.has(id)) return err(`No Bot with id ${id}.`);
        const name = d.bots.summary(id).profile.name;
        await d.runner.deleteBot(id); // I7: the app's one ordered delete (deleteBotFully) — it owns routine and Phase 4 cleanup
        return { text: `Deleted "${name}".` };
      },
    };

    return [createAgent, updateAgent, duplicateAgent, archiveAgent, deleteAgent];
  };
}

/** update_state target:"settings" (TOOL-15 + ORIG-17 keys). */
export function settingsTarget(bots: BotService, settings: HostSettingsStore): StateTargetHandler {
  return async (botId, _slot, a) => {
    if (a.model !== undefined) {
      if (!isModelId(a.model)) return err(`Not saved — unknown model "${String(a.model)}".`);
      bots.update(botId, { model: a.model });
    }
    const patch: Partial<BotSettings> = {};
    if (a.voice !== undefined) patch.voice = String(a.voice);
    if (a.speech_rate !== undefined) {
      const r = Number(a.speech_rate);
      if (!(r >= 0.5 && r <= 2)) return err("Not saved — speech_rate must be between 0.5 and 2.");
      patch.speechRate = r;
    }
    if (a.spoken_language !== undefined) patch.spokenLanguage = String(a.spoken_language);
    if (a.hidden_from_sidebar !== undefined) patch.hiddenFromSidebar = Boolean(a.hidden_from_sidebar);
    if (a.notify_on_updates !== undefined) patch.notifyOnAgentUpdates = Boolean(a.notify_on_updates);
    if (Object.keys(patch).length) bots.updateSettings(botId, patch);
    if (a.pinned !== undefined) settings.setPinned(botId, Boolean(a.pinned));
    return { text: "Updated your settings." };
  };
}

/** Keys a Bot may never change (ORIG-17 user-only list; floor F8). */
const USER_ONLY: [string[], string][] = [
  [["auto_review_enabled", "auto_review", "allow_instructions", "block_instructions", "auto_review_rules"], "Auto-review"],
  [["local_execution", "execution_policy"], "Local execution"],
  [["trusted_recipients", "trustedRecipients", "trusted_people", "trusted"], "Auto-review → Trusted people"],
];

/** update_state target:"account_settings" {user_time_zone} (ORIG-17). */
export function accountSettingsTarget(settings: HostSettingsStore): StateTargetHandler {
  return async (_botId, _slot, a) => {
    for (const [keys, row] of USER_ONLY) if (keys.some((k) => a[k] !== undefined)) return err(STR.userOnly(row));
    if (a.user_time_zone === undefined) return err("Not saved — the only account setting a Bot can change is user_time_zone.");
    const tz = String(a.user_time_zone);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return err(`Not saved — unknown time zone "${tz}". Use an IANA name such as America/New_York.`);
    }
    settings.update({ userTimeZone: tz });
    return { text: `Updated the account time zone to ${tz}.` };
  };
}
