import { isModelId } from "@synapse/shared";
import { providerRoute, type ModelRoute } from "../../brain/provider/provider-brain";

/**
 * The Messages route: how the provider loop calls a Claude model (a Claude Bot whose coding agents are set to Synapse's
 * own loop). Since 2026-09-30 it is the one Claude route every part of Synapse uses (Bot turns, helpers, coding agents):
 * the Anthropic Messages adapter and providerFetch, which sends the call only through the Claude auth proxy, budgeted,
 * metered once and reported to the proxy.
 */
export function claudeRoute(ref: string): ModelRoute | null {
  return isModelId(ref) ? providerRoute(ref) : null;
}
