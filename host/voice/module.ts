import { SPEECH_RATES, type BotSettings } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { HostModule, ModuleContext } from "../phase5/types";

/** 192400 → "3m 12s"; under a minute → "42s". */
function callLength(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** BOT-24: per-Bot voice, speech rate and spoken-language settings. */
export function createVoiceModule(ctx: Pick<ModuleContext, "bots">): HostModule {
  return {
    name: "voice",
    handlers: {
      setAgentVoice: (a) => {
        const patch: Partial<BotSettings> = {};
        if (a.voice !== undefined) patch.voice = a.voice === null ? null : String(a.voice).slice(0, 100);
        if (a.speechRate !== undefined) {
          if (!(SPEECH_RATES as readonly number[]).includes(a.speechRate)) throw new GatewayError("BAD_ARGS", "Speed must be 0.75x, 1x, 1.25x, 1.5x or 2x.");
          patch.speechRate = a.speechRate;
        }
        if (a.spokenLanguage !== undefined) {
          if (a.spokenLanguage !== null && !LANG.test(a.spokenLanguage)) throw new GatewayError("BAD_ARGS", "Language must be a locale like en-US.");
          patch.spokenLanguage = a.spokenLanguage;
        }
        return { agent: ctx.bots.updateSettings(a.id, patch) };
      },
      // Voice calls: the call's start and end, as notices around the turns it produced.
      noteVoiceCall: (a) => {
        if (a.phase !== "started" && a.phase !== "ended") throw new GatewayError("BAD_ARGS", "Unknown call phase.");
        if (!ctx.bots.has(a.id)) throw new GatewayError("NOT_FOUND", "That chat doesn't exist.", 404);
        const [id] = ctx.bots.auxEntryIds(a.id, 1);
        ctx.bots.appendEntry(a.id, { kind: "notice", id: id!, text: a.phase === "started" ? "Voice call started" : `Voice call ended · ${callLength(a.durationMs ?? 0)}`, createdAt: Date.now() });
        return {};
      },
    },
  };
}
