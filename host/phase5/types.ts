import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CatalogAuthor, CatalogCategory, CatalogDetail, LadderLevel } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { BotToolDef } from "../brain/types";
import type { HostConfig } from "../config";
import type { CommandHandlers } from "../gateway/server";
import type { SseHub } from "../gateway/sse-hub";
import type { TurnObserver } from "../runner/observers";
import type { HiddenSpec } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import type { HostSettingsStore } from "../store/host-settings";
import type { TrayService } from "../trays/trays";

/** Background model work the usage ladder can hold back (I11 template drafts, I13 coding agents). */
export type BackgroundKind = "dreaming" | "followups" | "email-poll" | "template-draft" | "coding";
export interface LadderLike {
  level(): LadderLevel;
  usagePct(): number | null;
  allowsBackground(kind: BackgroundKind): boolean;
}

/** The un-throttled fallback: no Marketplace usage module wired yet, or the ladder is at L0. */
export const NORMAL_LADDER: LadderLike = { level: () => "L0", usagePct: () => null, allowsBackground: () => true };

/** What a HostModule gets to read and act through, without importing the composition root. */
export interface ModuleContext {
  cfg: HostConfig;
  hub: SseHub;
  settings: HostSettingsStore;
  bots: BotService;
  trays: TrayService;
  now(): number;
  flags(): ConformanceFlags;
  enqueueHidden(botId: string, spec: HiddenSpec): void;
  isIdle(botId: string): boolean;
  slot(botId: string): TurnSlot | null;
  sendPrompt(botId: string, text: string, clientNonce: string, meta?: { voiceDurationMs?: number; hints?: string[] }): { entryId: string };
  ladder(): LadderLike;
}

/** A pluggable slice of the host: its own gateway handlers, turn observers, extra bot tools, MCP
 *  servers and disallowed-tool list, folded into the composition root without touching app.ts per module. */
export interface HostModule {
  name: string;
  handlers: CommandHandlers;
  observers?: TurnObserver[];
  /** Wraps Phase 1 handlers that this module extends (e.g. dismissTray's new action, PLG-06 @-mention
   *  hints, ORIG-11 activity observation). Called with the merged base set; Task 32 applies each
   *  module's wrappers in module order. */
  wrapHandlers?(base: CommandHandlers): Partial<CommandHandlers>;
  /** `base` is the tool list built so far; returning a tool with an existing name replaces that tool. */
  botTools?(botId: string, slot: () => TurnSlot | null, base?: BotToolDef[]): BotToolDef[];
  mcpServers?(botId: string): Record<string, McpServerConfig>;
  disallowedTools?(): string[];
  /**
   * A module's own system-prompt notes, appended after the frozen prompt snapshot. Whatever a module
   * returns here lands in the SAME system block as the base prompt, and that block is one prompt-cache
   * unit: if the composed text changes between two turns of a session, the whole block (measured at
   * 6,142 tokens on 2026-09-19) is re-written at the cache-write rate instead of read at the
   * cache-read rate. So this must be stable turn to turn — it may vary with durable state (whether a
   * connector is installed), never with the turn. host/test/perf/prompt-stability.test.ts holds the line.
   */
  systemAppendExtra?(botId: string): string;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

// ---------- catalog source contracts shared by Tracks M and T (Task 10 re-exports these) ----------
export interface PluginCatalogItem { id: string; name: string; description: string; category: CatalogCategory | null; toolCount?: number; marketplace: string }
export interface PluginSource {
  list(): PluginCatalogItem[];
  install(id: string): Promise<{ serverIds: string[] }>;
  uninstall(id: string): Promise<void>;
  isInstalled(id: string): boolean;
  hasCommandServer(id: string): boolean;
  detail(id: string): CatalogDetail | null;
}
export interface TemplateCatalogItem { id: string; source: "starter" | "local-template"; name: string; description: string; author?: CatalogAuthor; category: CatalogCategory | null; featured: boolean; added: boolean }
export interface TemplateSource { list(): TemplateCatalogItem[] }
