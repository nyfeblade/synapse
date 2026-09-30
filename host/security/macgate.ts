import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_NEEDS_APPROVAL, type LocalExecRequest, type PermMode } from "@synapse/shared";
import { bindHash, LocalPolicyStore } from "../../app/src/coordinator/local-exec/policy";

/**
 * The Mac gate: the app's own local-exec policy (app/src/coordinator/local-exec/policy.ts), the check every command
 * a Bot sends to your Mac passes on the Mac itself, whatever the host said. Here it runs against a throwaway home in
 * a temp folder with a throwaway policy key; nothing on this machine's real home is read or run.
 */
export interface MacBench {
  home: string;
  dir: string;
  policy: LocalPolicyStore;
  req(command: string, o?: Partial<LocalExecRequest>): LocalExecRequest;
  dispose(): void;
}

/**
 * `project: true` makes ~/code/app a project folder the owner has let Bots work in (a local root and an auto-run
 * root), as the app's Mac settings do: the setting Auto-accept edits needs before it writes anything on its own.
 */
export function macBench(mode: PermMode = "ask", o: { project?: boolean } = {}): MacBench {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sec-mac-")));
  const userData = path.join(home, "Library", "Application Support", "Synapse");
  const dir = path.join(home, "policy");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(home, "code", "app"), { recursive: true });
  const policy = new LocalPolicyStore(dir, Date.now, Buffer.alloc(32, 7), { home: () => home, userData: () => userData });
  if (o.project) policy.update({ localRoot: home, addAutoRunRoot: path.join(home, "code", "app") });
  policy.setBotMode("b1", mode);
  let n = 0;
  return {
    home, dir, policy,
    req: (command, o = {}) => ({ execId: `mac${++n}`, botId: "b1", approvalId: null, op: "run-command", command, cwd: path.join(home, "code", "app"), ...o }),
    dispose: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** The Mac's answer as a suite outcome: ran, needs your approval (a card), or refused. */
export function macOutcome(v: { ok: boolean; reason?: string }): { outcome: "allow" | "ask" | "deny"; detail: string } {
  if (v.ok) return { outcome: "allow", detail: "The Mac ran it." };
  const r = v.reason ?? "";
  return r.startsWith(LOCAL_NEEDS_APPROVAL) ? { outcome: "ask", detail: r.slice(LOCAL_NEEDS_APPROVAL.length).trim() } : { outcome: "deny", detail: r };
}

export { bindHash };
