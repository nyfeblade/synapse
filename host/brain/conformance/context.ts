import { execFile } from "node:child_process";
import fs from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { HELPER_MODEL, scrubClaudeLogin } from "@synapse/shared";
import type { HostConfig } from "../../config";
import { meteredQueryFn, type QueryFn } from "../../usage/metered-query";
import { log } from "../../util/log";
import { buildBotEnv, buildSystemPrompt, systemPromptModeFor } from "../spawn-options";
import { claudeExecutableFor, DISALLOWED_TOOLS } from "../tool-policy";
import type { ConformanceFlags } from "./flags";
import type { ConformanceContext } from "./types";
import { claudeVersion } from "../../claude/spawn";

const PROBE_APPEND = "You are an automated conformance probe. Follow the user's instructions exactly and briefly.";

/** Review round 3 (S6): through the one claude spawn helper (never an inherited login, even for --version). */
export function detectCliVersion(executable?: string): Promise<string | null> {
  return claudeVersion(executable);
}

export function createConformanceContext(cfg: HostConfig, runAs: ConformanceFlags["runAs"], queryFn?: QueryFn): ConformanceContext {
  return {
    // The probes spend real (small) model calls at startup; they are recorded like any other host call.
    cfg, runAs, queryFn: meteredQueryFn({ purpose: "setup", botId: null }, queryFn), now: Date.now,
    baseOptions: (extra: Partial<Options> = {}): Options => ({
      model: HELPER_MODEL,
      cwd: cfg.workspace,
      settingSources: [],
      permissionMode: "default",
      persistSession: false,
      disallowedTools: [...DISALLOWED_TOOLS],
      // BRAIN-03: the probes run under whichever prompt an engineering-OFF Bot runs under — standalone
      // by default since 2026-09-21, the preset under SYNAPSE_SYSTEM_PROMPT=preset. Checks that pin their
      // own systemPrompt (CT-08's long append, CT-09's tool-less string) still override this.
      systemPrompt: buildSystemPrompt(systemPromptModeFor(cfg, "conformance"), PROBE_APPEND),
      env: buildBotEnv({ cfg, botId: "conformance" }),
      pathToClaudeCodeExecutable: claudeExecutableFor(runAs, cfg),
      ...extra,
    }),
    boxUid: () =>
      new Promise((resolve) => execFile("id", ["-u", "box"], { env: scrubClaudeLogin(process.env) }, (err, out) => resolve(err ? null : Number(String(out).trim())))),
    log: (msg, f) => log.info(`conformance: ${msg}`, f),
  };
}
