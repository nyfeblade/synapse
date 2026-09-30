import { STR, STR5, STR_HEALTH, STRAL, STRB, STRG, STRMA, STRO, STRS, STRV, STR_AUTH, STR_COST, STR_MCP, STR_PHONE, STR_TELEGRAM } from "@synapse/shared";
import { slugRow } from "../../deep-links";
import type { SettingsSectionId } from "./sections";

/**
 * Settings search (UI polish pass, brief 2): every preference, by its label and a few keywords, in
 * whichever section renders it. A hit jumps to that section and flashes the row, through the same
 * deep-link path a copied setting link uses (the row id is the slug of its visible label, which is
 * what SettingLinksLayer matches rows by).
 *
 * The list is written out, not scraped from the DOM, because only the open section is mounted —
 * searching has to find rows the user cannot see yet.
 */
export interface SettingEntry { section: SettingsSectionId; label: string; keywords?: string[]; row?: string }

const e = (section: SettingsSectionId, label: string, keywords: string[] = [], row?: string): SettingEntry => ({ section, label, keywords, row });

export function settingEntries(): SettingEntry[] {
  return [
    // General
    e("general", STR.timezone, ["time zone", "clock"]),
    e("auto-review", STR.autoReview, ["approval", "rules", "ask first", "allow", "permissions", "trusted people", "trusted recipients"]),
    e("general", STR.theme, ["appearance", "dark", "light", "mode"]),
    e("general", STRG.connectedAccounts, ["google", "gmail", "calendar", "drive"]),
    e("general", STR5.memory, ["remember", "recall"]),
    e("general", STR_HEALTH.workNotify, ["notifications", "finished", "done", "telegram", "long tasks"]),
    e("connections", STR_HEALTH.section, ["connectors", "health", "broken", "sign in", "reconnect", "mcp", "google", "composio", "github", "telegram"]),
    // Account
    e("account", STR_AUTH.keyLabel, ["api", "key", "anthropic", "sign in", "login"]),
    e("usage", STR_COST.apiSpend, ["usage", "spend", "billing", "cost"]),
    e("usage", STR_COST.monthlyBudget, ["budget", "spend", "cost", "cap", "limit"]),
    e("usage", STR5.keepConversationsReady, ["savings", "cache", "cost", "ttl"]),
    e("usage", STR5.callReplies, ["savings", "effort", "call", "voice", "cost"]),
    e("usage", STR5.longContextModel, ["savings", "1m", "context", "cost"]),
    // Voice
    e("voice", STR5.microphone, ["input", "mic", "audio"]),
    e("voice", STR5.speaker, ["output", "audio", "sound"]),
    e("voice", STR5.voiceModeLabel, ["voice", "engine", "kokoro", "natural"]),
    e("voice", STR5.callVoice, ["call", "voice"]),
    e("voice", STRV.callsFromBots, ["ring", "call me", "phone"]),
    e("voice", STRV.quietHours, ["do not disturb", "focus"]),
    e("voice", STRV.keepVoiceReady, ["latency", "warm"]),
    e("voice", STRV.callSounds, ["sounds", "chime"]),
    e("voice", STRV.callShortcut, ["hotkey", "keyboard", "shortcut"]),
    e("voice", STRV.wakeWord, ["hey", "listen", "wake"]),
    e("voice", STRV.whisperTitle, ["transcription", "dictation", "speech"]),
    e("voice", STR_PHONE.title, ["phone", "tailscale", "mobile"]),
    // Computer
    e("computer", STR5.computerName, ["name", "mac"]),
    e("computer", STR5.executionOnThisComputer, ["run", "commands", "files", "local"]),
    e("computer", STR5.keepBoxOnQuit, ["quit", "background", "box"]),
    e("computer", STR5.autoRunFolders, ["folders", "auto-run"]),
    e("computer", STRB.signinSection, ["browser", "sign in", "cookies"]),
    e("computer", STRMA.appsSection, ["mac apps", "permissions", "accessibility", "screen recording"]),
    e("computer", STR5.routeTraffic, ["network", "proxy", "vpn"]),
    e("computer", STR5.localNetwork, ["lan", "local network", "home network", "firewall"]),
    // 5.6: what Bots did on this Mac.
    e("activity", STRAL.section, ["action log", "history", "audit", "undo", "dry run", "touched", "export"], "activity"),
    // Schedules
    e("schedules", STRS.standup, ["briefing", "daily", "morning"]),
    e("schedules", STRS.standupTime, ["time", "briefing"]),
    e("schedules", STRS.quietHours, ["do not disturb", "night"]),
    // System
    e("system", STR5.automaticUpdates, ["update", "version", "upgrade"]),
    e("system", STRO.autoBackup, ["backup", "restore", "recovery"]),
    e("system", STRO.keepLast, ["backups", "archives"]),
    e("system", STRO.diagnostics, ["logs", "crash", "report", "problems"]),
    e("system", STRO.storage, ["disk", "space"]),
    e("system", STR_MCP.access, ["mcp", "claude desktop", "claude code", "cursor", "other apps", "connect"]),
    e("system", STR_TELEGRAM.access, ["telegram", "phone", "chat", "approvals", "botfather", "messages"]),
  ];
}

/** The rows matching `query`: every word of the query must appear in the label or a keyword. */
export function searchSettings(query: string, entries = settingEntries()): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries.filter((x) => {
    const hay = [x.label, ...(x.keywords ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const rowOf = (x: SettingEntry) => x.row ?? slugRow(x.label);
