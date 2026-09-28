import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAC_CLAUDE_API_KEY_MSG, STR5, type MacClaudeAuth } from "@synapse/shared";
import { LocalExecDaemon, type BrowserCall, type BrowserResult, type MacAppCallMsg, type MacAppResultMsg } from "./daemon";
import { LocalExecutor } from "./executor";
import { LocalPolicyStore } from "./policy";
import { inspectPolicyKey, loadPolicyKey, resetPolicyKey, type PolicyKeyResult } from "./policy-key";
import { retireMacClaudeLogin } from "./login-scrub";
import { clearMacApiKey, loadMacApiKey, saveMacApiKey } from "./mac-api-key";
import { MacKeyProxy } from "./mac-key-proxy";
import { MacUsageQueue } from "./mac-usage-queue";

export const SCRATCH_PREFIX = "bots-local-policy-";
/** Re-review fix E: claude usage reports on this Mac waiting for the host (numbers and a Bot id only). */
export const MAC_USAGE_QUEUE_FILE = "mac-usage-queue.json";

let scratch: { root: string; dir: string } | null = null;
let cleanupHooked = false;

/** Removes this process's scratch policy folder (quit), and is safe to call more than once. */
export function disposeScratchPolicy(): void {
  if (!scratch) return;
  try { fs.rmSync(scratch.dir, { recursive: true, force: true }); } catch { /* already gone */ }
  scratch = null;
}

/** Scratch folders a previous run could not remove (it was killed): they hold nothing anyone can use. Only
 *  ones untouched for a day go, so another app instance's live folder is never taken from under it. */
export function sweepStaleScratch(root: string, now = Date.now()): void {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(SCRATCH_PREFIX)) continue;
    const p = path.join(root, n);
    try {
      if (now - fs.statSync(p).mtimeMs < 24 * 3_600_000) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* not ours to remove */ }
  }
}

function scratchDir(root: string): string {
  if (scratch && scratch.root === root) return scratch.dir;
  disposeScratchPolicy();
  sweepStaleScratch(root);
  scratch = { root, dir: fs.mkdtempSync(path.join(root, SCRATCH_PREFIX)) };
  if (!cleanupHooked) {
    cleanupHooked = true;
    process.once("exit", disposeScratchPolicy);
    // The app's quit ends this utility process with a signal, which skips "exit": clean up, then end as asked.
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { disposeScratchPolicy(); process.exit(0); });
  }
  return scratch.dir;
}

/**
 * The Mac's local-exec daemon over this profile, exactly as the coordinator builds it on every connect.
 *
 * Bug 225: the policy files are signed with the profile's own key file (policy-key.ts), never the keychain, so this
 * is durable on every normal launch. `legacyKey` (the old keychain-derived key, only asked for while no key file
 * exists) is used once to carry still-valid files over.
 *
 * Fail closed only for a key file that is tampered with or unreadable (a link, not ours, readable by others, the
 * wrong size): the run keeps its records in a scratch folder of its own (removed on quit), leaves the real files
 * untouched, and is non-durable — nothing can be GRANTED (a card's "Always" acts as "once"), turning an ability off
 * always works, and getLocalPolicyStatus tells Settings to offer Reset permissions (resetLocalPolicy).
 */
export function createLocalDaemon(o: {
  userData: string; legacyKey?: Buffer; log?(s: string): void; call(cmd: string, args: unknown): Promise<unknown>; tmpRoot?: string; heartbeatMs?: number;
  browser?(c: BrowserCall): Promise<BrowserResult>; browserOrigin?(botId: string): Promise<string | null>; macapp?(c: MacAppCallMsg): Promise<MacAppResultMsg>;
  /** Bug 258 (fix round): verify a per-dialog No limits nonce with main (single-use). */
  verifyNoLimits?(nonce: string): Promise<boolean>;
  /** tests only: the key proxy's upstream (a local fake Messages API). */
  keyUpstream?: string;
  /** Called after Reset permissions made a new key: the caller builds the daemon again (the new one is durable). */
  onReset?(): void;
}): { daemon: LocalExecDaemon; policy: LocalPolicyStore; durable: boolean; policyDir: string; keyProxy: MacKeyProxy; macKey: MacKeyStore } {
  const userData = o.userData;
  const log = o.log ?? ((s: string) => console.error(s));
  let k: PolicyKeyResult;
  try { k = loadPolicyKey(userData, { legacyKey: o.legacyKey, log }); } catch { k = { ok: false, reason: "unreadable" }; }
  const durable = k.ok;
  if (!k.ok) log(`local-exec: the permission key file can't be trusted (${k.reason}); permissions are not saved until they are reset in Settings.`);
  const policyDir = durable ? userData : scratchDir(o.tmpRoot ?? os.tmpdir());
  // Ruling A: the app's own data is never an auto-run place.
  const policy = new LocalPolicyStore(policyDir, Date.now, k.ok ? k.key : randomBytes(32), { userData: () => userData });
  const resetPolicy = async (): Promise<{ ok: boolean }> => {
    const r = resetPolicyKey(userData);
    if (!r.ok && r.reason === "sound") throw new Error(STR5.localPolicyResetRefused);
    if (r.ok) { disposeScratchPolicy(); o.onReset?.(); }
    return { ok: r.ok };
  };
  // synapse-public migration: an older install's Bots-only Claude login token (userData only) is removed; it is never used.
  if (retireMacClaudeLogin(userData)) log("local-exec: removed the old Claude login token for Bots on this Mac; claude uses the Anthropic API key only.");
  // Wrapped claude runs get a per-run token for this loopback proxy, never the key (the Mac's
  // copy, mac-api-key.ts). The host is asked before each claude run (hostClaudeAuth); each answer's usage goes back to
  // the host (recordMacUsage) so the spend view, the ladder and the budgets count it.
  // Review fix 4: the Mac copy is read with the key file as it is now, and saved through here, which creates the key file
  // on demand exactly as the policy store does (loadPolicyKey, with its one-time migration), never in main.
  const policyKeyNow = (): Buffer | null => { const r = inspectPolicyKey(userData); return r?.ok ? r.key : null; };
  const claudeAuthFor = hostClaudeAuth((c, a) => o.call(c, a));
  // Re-review fix E: a report the host can't take now waits in a bounded queue on disk and is retried with backoff.
  const usageQueue = new MacUsageQueue({ file: path.join(userData, MAC_USAGE_QUEUE_FILE), send: (r) => o.call("recordMacUsage", r), log });
  const keyProxy = new MacKeyProxy({
    key: () => { const pk = policyKeyNow(); return pk ? loadMacApiKey(userData, pk) : null; }, upstream: o.keyUpstream, log,
    onUsage: (u) => { void usageQueue.report(u); },
    // Re-review fix C: the budget is asked again per model request (cached ~30 s), not only when the run starts.
    allow: async (botId) => {
      const a = await claudeAuthFor(botId);
      if (!a) return null;
      if (!a.keySaved) return { ok: false, message: MAC_CLAUDE_API_KEY_MSG };
      return a.spend;
    },
  });
  const macKey: MacKeyStore = {
    save: async (value) => {
      let r: PolicyKeyResult;
      try { r = loadPolicyKey(userData, { legacyKey: o.legacyKey, log }); } catch { r = { ok: false, reason: "unreadable" }; }
      if (!r.ok) return { ok: false, error: STR5.localPolicyKeyBroken };
      try { saveMacApiKey(userData, r.key, value); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    clear: () => clearMacApiKey(userData),
    has: () => { const pk = policyKeyNow(); return !!pk && loadMacApiKey(userData, pk) !== null; },
  };
  // feat-mac-access-parity: full access (CLI parity) — commands and file ops run anywhere the user can, bounded
  // by the protected NEVER guard; the layered permissions (fixed rules → reviewer → cards) gate the rest.
  const daemon = new LocalExecDaemon({
    call: o.call, policy, executor: new LocalExecutor({ root: () => policy.current().localRoot, userData: () => userData, fullAccess: () => true, claudeAuth: claudeAuthFor, keyProxy }),
    browser: o.browser, browserOrigin: o.browserOrigin, macapp: o.macapp, verifyNoLimits: o.verifyNoLimits, durable, resetPolicy, ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
  });
  return { daemon, policy, durable, policyDir, keyProxy, macKey };
}

/** The Mac's copy of the API key, kept by the coordinator (main asks for it over the parent port: "mac-key"). */
export interface MacKeyStore { save(key: string): Promise<{ ok: boolean; error?: string }>; clear(): void; has(): boolean }

/**
 * Review fixes 1, 3, 6: before every claude run on this Mac the host is asked (macClaudeAuth) whether it has a key
 * saved and whether this Bot may spend. No cache, so a change applies to the next run at once; if the host can't be
 * asked the answer is null and a run that signs in is refused (never a guess).
 */
export function hostClaudeAuth(call: (cmd: string, args: unknown) => Promise<unknown>): (botId: string) => Promise<MacClaudeAuth | null> {
  return async (botId) => {
    try {
      const v = (await call("macClaudeAuth", { botId })) as Partial<MacClaudeAuth> | null;
      if (!v || typeof v !== "object" || typeof v.keySaved !== "boolean") return null;
      const ttl = v.promptCacheTtl === "5m" || v.promptCacheTtl === "1h" ? { promptCacheTtl: v.promptCacheTtl } : {}; // review round 3: the Savings setting
      return { keySaved: v.keySaved === true, spend: { ok: v.spend?.ok === true, message: typeof v.spend?.message === "string" ? v.spend.message : null }, ...ttl };
    } catch {
      return null;
    }
  };
}
