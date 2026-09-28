import crypto from "node:crypto";
import type { BoxEvent, UsageRow } from "../coding/synapse";
import type { Mode } from "./metrics";
import type { CuTask, PromptCtx } from "./tasks";

export type { BoxEvent, UsageRow };

/** Everything the computer-use runner needs from the box. GatewayCuBox is the real one, FakeCuBox the offline one. */
export interface CuBox {
  readonly real: boolean;
  listBots(): Promise<{ id: string; name: string }[]>;
  createBot(name: string, model: string): Promise<string>;
  /** Gateway `setAgentComputerPerception`. */
  setPerception(id: string, mode: Mode): Promise<void>;
  /** Deletes only a Bot currently named bench-cu-<8>. */
  deleteBot(id: string): Promise<void>;
  subscribe(fn: (ev: BoxEvent) => void): Promise<() => void>;
  call(cmd: string, args: Record<string, unknown>): Promise<any>;
  /** usage.db rows for the Bot (the parent; its computerUse child is measured from its transcript). */
  usage(botId: string, sinceMs: number): Promise<UsageRow[]>;
  /** The Bot's child session transcripts (.jsonl contents), from its store's brain.childSessionFiles. */
  childTranscripts(botId: string): Promise<string[]>;
  /** Writes the sites and desk files under /workspace/bench-cu-<nonce> and starts the local server. */
  setup(nonce: string, tasks: CuTask[]): Promise<PromptCtx>;
  /** Re-creates one task's desk files (each mode starts from the same state). */
  resetTask(nonce: string, task: CuTask): Promise<void>;
  submissions(nonce: string): Promise<Record<string, Record<string, unknown>[]>>;
  readFiles(nonce: string, rels: string[]): Promise<Record<string, string | null>>;
  /** The box user's thunar.xml (null when missing). */
  xfconf(): Promise<string | null>;
  /** Stops the server and removes /workspace/bench-cu-<nonce>. */
  teardown(nonce: string): Promise<void>;
}

export const NONCE_RE = /^[a-z0-9]{8}$/;
export const newNonce = () => crypto.randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 8);
export const benchCuName = (nonce: string) => `bench-cu-${nonce}`;
export const isBenchCuName = (name: string) => /^bench-cu-[a-z0-9]{8}$/.test(name);
