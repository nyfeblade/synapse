import fs from "node:fs";
import path from "node:path";
import { parseAcpModelRef, type AcpVendorId } from "@synapse/shared";
import { AcpBrain } from "../../brain/acp/acp-brain";
import { AcpSessionMap } from "../../brain/acp/acp-sessions";
import type { AcpSpawn } from "../../brain/acp/spawn";
import type { ProviderSessionStore } from "../../brain/provider/session-store";
import type { BotFileRunner } from "../../walls/bot-file";
import { createCodingShellTool, type CodingShell } from "./coding-tools";
import { LoopChild } from "./loop-child";
import { codingPolicy, type CodingGate, type Realpaths } from "./policy";
import type { CodingEngine } from "./types";
import { codingWiring } from "./wiring";

/**
 * An `acp:<vendor>` engine: a vendor's own coding CLI (Cursor, GitHub Copilot, Kimi Code, …) as a coding agent, on the
 * owner's own subscription, through AcpBrain. The CLI runs as the Bot's own account in the Bot's home, works in the
 * agent's worktree, and every permission it asks (a command, an edit, a read) is answered by the shared coding policy
 * and the Bot's approval gate, exactly as for the other engines; its terminals are the Bot's shell in the worktree,
 * its file reads and writes go through bot-file. Installing and signing in to a vendor CLI is the Coding CLIs setting.
 */
export interface AcpEngineDeps {
  hostPrivate: string;
  gate: CodingGate | null;
  realpaths?: Realpaths;
  files: BotFileRunner;
  shell: CodingShell;
  store: ProviderSessionStore;
  spawn: AcpSpawn;
  consented(v: AcpVendorId): boolean;
  home?(botId: string): string | null;
  newId(): string;
  maxModelCalls?: number;
  now?(): number;
  log?(m: string, f?: Record<string, unknown>): void;
}

export function acpEngine(vendor: AcpVendorId, d: AcpEngineDeps): CodingEngine {
  // The coding agents' own vendor sessions, apart from the Bots' chat sessions (acp-sessions.json).
  const dir = path.join(d.hostPrivate, "coding-acp");
  let sessions: AcpSessionMap | null = null;
  const map = () => { if (!sessions) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); sessions = new AcpSessionMap(dir); } return sessions; };
  return {
    id: `acp:${vendor}`,
    runs: (model) => parseAcpModelRef(model) === vendor,
    start: ({ botId, agentId, cwd, model, prompt }) => {
      let signal = new AbortController().signal;
      let sid: string | null = null;
      const shell = createCodingShellTool({ botId, agentId, cwd, files: d.files, shell: d.shell, signal: () => signal }, "Shell");
      const brain = new AcpBrain({
        botId, spawn: d.spawn, store: d.store, sessions: map(), files: d.files,
        wiring: codingWiring({ policy: codingPolicy({ hostPrivate: d.hostPrivate, gate: d.gate, ...(d.realpaths ? { realpaths: d.realpaths } : {}) }, botId, cwd), cwd, botTools: () => [shell] }),
        getSessionId: () => sid, setSessionId: (s) => { sid = s; },
        model: () => model, cwd: () => cwd, consented: d.consented, newId: d.newId,
        home: () => d.home?.(botId) ?? null,
        preamble: () => `You are a coding agent working for a Synapse Bot, in the git worktree ${cwd}. Do the task completely, check your work, and finish with a short report.`,
        ...(d.now ? { now: d.now } : {}),
        ...(d.log ? { log: d.log } : {}),
      });
      return new LoopChild({ engine: `acp:${vendor}`, key: agentId, model, brain, maxModelCalls: d.maxModelCalls ?? 300, onStep: (s) => { signal = s; }, ...(d.now ? { now: d.now } : {}) }, prompt);
    },
  };
}
