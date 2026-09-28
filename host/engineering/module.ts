import { NO_LIMITS_CONFIRM, STR5, type BotSettings } from "@synapse/shared";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { postCard } from "../phase5/cards";
import type { HostModule, ModuleContext } from "../phase5/types";
import { systemPromptModeFor } from "../brain/spawn-options";
import { canOfferEngineering, engineeringSystemExtra, modeChangeNotice } from "./prompt";

const err = (text: string): BotToolResult => ({ text, isError: true });

export function applyEngineeringMode(cur: BotSettings, enabled: boolean): Partial<BotSettings> {
  const on = !!enabled;
  const patch: Partial<BotSettings> = { engineeringMode: on };
  if (cur.engineeringMode && !on) patch.engineeringOffered = false;
  if (on) patch.engineeringOffered = true;
  return patch;
}

export function createEngineeringModule(ctx: ModuleContext): HostModule {
  return {
    name: "engineering",
    handlers: {
      // feat-mac-access-parity: the per-Bot permission mode (Ask / Auto-accept edits / Full auto). Takes effect
      // immediately — it only steers the gate, no prompt/respawn needed.
      setAgentPermMode: (a) => {
        const mode = a.mode === "accept-edits" || a.mode === "full-auto" ? a.mode : "ask";
        // Bug 258: any mode choice leaves No limits (only its own confirm turns it on again).
        return { agent: ctx.bots.updateSettings(a.id, { permMode: mode, noLimits: undefined }) };
      },
      // Bug 258: No limits, on top of Full auto. A user-only command (a Bot can't reach it); turning it on needs the
      // confirm token the app's own dialog sends. The Mac keeps its own signed record and never reads this one.
      setAgentNoLimits: (a) => {
        if (a.enabled === true) {
          if (a.confirm !== NO_LIMITS_CONFIRM) throw new Error(STR5.noLimitsNeedsConfirm);
          return { agent: ctx.bots.updateSettings(a.id, { permMode: "full-auto", noLimits: true }) };
        }
        return { agent: ctx.bots.updateSettings(a.id, { noLimits: undefined }) };
      },
      // cost-diet-2 lever 1: the per-Bot "Save usage" switch (model routing). It only steers the per-turn router
      // (brain/model-router.ts), so it takes effect on the next turn with no respawn and no prompt change.
      // `null` clears it: the Bot follows the account-wide setting again.
      setAgentSaveUsage: (a) => ({ agent: ctx.bots.updateSettings(a.id, { saveUsage: a.enabled === null ? undefined : !!a.enabled }) }),
      setAgentEngineeringMode: (a) => {
        const cur = ctx.bots.summary(a.id).settings;
        const was = !!cur.engineeringMode;
        const on = !!a.enabled;
        const agent = ctx.bots.updateSettings(a.id, { ...applyEngineeringMode(cur, on), ...(on && !was ? { engineeringModeSince: ctx.now() } : {}) });
        if (on !== was) {
          // Takes effect on the NEXT turn, not the next compaction: re-render the frozen prompt (one
          // cache miss), and tell the Bot once. The mode is in the spawn key, so a warm CLI respawns.
          ctx.bots.invalidatePromptSnapshots(a.id);
          ctx.bots.noteModeChange(a.id, was, on, modeChangeNotice(on, systemPromptModeFor(ctx.cfg, a.id)));
        }
        return { agent };
      },
    },
    botTools: (botId, slot) => {
      const tool: BotToolDef = {
        name: "SuggestEngineeringMode",
        description: "Offer engineering mode once.",
        schema: {},
        readOnly: false,
        handler: async () => {
          const cur = ctx.bots.summary(botId).settings;
          if (cur.engineeringMode) return err("Engineering mode is already on.");
          if (!canOfferEngineering(cur)) return err("Engineering mode was already offered for this Bot.");
          const turn = slot();
          if (!turn) return err("Can only offer Engineering mode during a turn.");
          ctx.bots.updateSettings(botId, { engineeringOffered: true });
          postCard(ctx, botId, turn, { kind: "engineering-offer" });
          return { text: "The user was shown a card to turn Engineering mode on. Wait for their choice." };
        },
      };
      return [tool];
    },
    systemAppendExtra: (botId) => engineeringSystemExtra(ctx.bots.summary(botId).settings, systemPromptModeFor(ctx.cfg, botId)),
  };
}
