import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "@synapse/shared";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { ToolProvider } from "../runner/turn-runner";
import { readBoxFile, removeBoxPath } from "../util/box-file";
import { teachWorkDir } from "../util/host-out";
import type { TeachRecorder } from "./recorder";
import { lintTeachSkill, parseSkill, setSkillStatus } from "./skill";

/** States "rehearsed" may run from: ANALYZING/NEEDS_FIX auto-advance to DRAFTED first, DRAFTED/TESTED go straight to REHEARSING. */
const REHEARSE_FROM = new Set(["ANALYZING", "NEEDS_FIX", "DRAFTED", "TESTED"]);

interface RStep { n: number; status: string; note?: string }
interface TStep { n: number; intent?: string; commit?: boolean }

/** ORIG-08 §08.3: pass = every step before the first commit is ok and the run stopped there (or finished, if nothing commits). */
export function evaluateRehearsal(json: unknown, trace?: unknown): { pass: boolean; ok: number; total: number; stoppedBefore: string | null } {
  const steps = ([...((json as { steps?: RStep[] })?.steps ?? [])] as RStep[]).sort((a, b) => a.n - b.n);
  const tsteps = ((trace as { steps?: TStep[] } | undefined)?.steps ?? []) as TStep[];
  const commitN = tsteps.find((s) => s.commit)?.n ?? null;
  const stopIdx = steps.findIndex((s) => s.status === "stopped_before_commit");
  const before = stopIdx >= 0 ? steps.slice(0, stopIdx) : commitN !== null ? steps.filter((s) => s.n < commitN) : steps;
  const ok = before.filter((s) => s.status === "ok").length;
  const stoppedN = stopIdx >= 0 ? steps[stopIdx]!.n : null;
  const stoppedRight = commitN === null ? stopIdx < 0 || stoppedN !== null : stoppedN === commitN;
  const stoppedBefore = stoppedN === null ? null : tsteps.find((s) => s.n === stoppedN)?.intent ?? `step ${stoppedN}`;
  return { pass: before.length > 0 && ok === before.length && stoppedRight, ok, total: before.length, stoppedBefore };
}

export function rehearsalSummary(r: ReturnType<typeof evaluateRehearsal>): string {
  if (r.pass) return r.stoppedBefore ? `Rehearsal passed ${r.ok}/${r.total} steps and stopped before "${r.stoppedBefore}".` : `Rehearsal passed ${r.ok}/${r.total} steps.`;
  return `Rehearsal failed: ${r.ok}/${r.total} steps matched${r.stoppedBefore ? `, stopped before "${r.stoppedBefore}"` : ""}.`;
}

const err = (text: string): BotToolResult => ({ text, isError: true });

export function teachReviewProvider(d: { cfg: HostConfig; recorder: Pick<TeachRecorder, "current" | "setState" | "status">; write?: (file: string, text: string) => void }): ToolProvider {
  const failures = new Map<string, number>();
  const skillsRoot = path.join(d.cfg.claudeConfigDir, "skills") + path.sep;
  const move = (to: string[]) => { for (const s of to) d.recorder.setState(s as Parameters<TeachRecorder["setState"]>[0]); };
  return (botId): BotToolDef[] => [{
    name: "TeachReview",
    description: 'After a Teach a task rehearsal finishes, call with action "rehearsed"; when the user accepts the skill, call with action "accept".',
    readOnly: false,
    schema: { session: z.string(), skill_path: z.string(), action: z.enum(["rehearsed", "accept"]) },
    handler: async (a) => {
      const cur = d.recorder.current();
      if (!cur || cur.botId !== botId || cur.sessionId !== String(a.session)) return err(`"${String(a.session)}" isn't your current Teach a task recording.`);
      const skillPath = path.resolve(String(a.skill_path));
      if (!skillPath.startsWith(skillsRoot) || path.basename(skillPath) !== "SKILL.md" || !fs.existsSync(skillPath)) return err("skill_path must be a SKILL.md in your skills library.");
      const skillMd = fs.readFileSync(skillPath, "utf8");
      const problems = lintTeachSkill(skillMd);
      if (problems.length) return err(`Fix the skill first:\n- ${problems.join("\n- ")}`);
      // Same-session ownership: skill_path is otherwise authorized only by shared-library containment
      // plus the lint above, which says nothing about *this* session. Without this check, any Bot with
      // an active teach session could accept or mark-tested a different, unrelated skill.
      const skillMeta = (parseSkill(skillMd).front.metadata ?? {}) as Record<string, unknown>;
      if (skillMeta.teachSession !== cur.sessionId) return err("That skill wasn't drafted in this Teach a task session.");
      const state = d.recorder.status().state;
      if (a.action === "accept") {
        if (state !== "TESTED" && state !== "DRAFTED" && state !== "ANALYZING") return err(`Nothing to accept (Teach a task is ${state}).`);
        if (state === "ANALYZING") move(["DRAFTED"]);
        // setSkillStatus now fails closed (throws) rather than falling back to a local write when
        // cfg.brain === "claude" and skill_path doesn't resolve to a real skill id; caught here so
        // that stays a graceful tool error, not an uncaught exception (same reasoning as the
        // "Fix round 1, finding 1" whitelist below).
        try {
          setSkillStatus(skillPath, null, d.write, d.cfg);
        } catch (e) {
          return err(e instanceof GatewayError ? e.message : String(e));
        }
        move(["ACCEPTED"]);
        return { text: "The skill is live now; routines can use it. Tell the user in one short line." };
      }
      // Explicit whitelist, mirroring the "accept" branch above: without it, a late/duplicate
      // "rehearsed" call (e.g. after the skill was already ACCEPTED) fell through to an unconditional
      // move(["TESTED"|"NEEDS_FIX"]) that TeachRecorder.setState() rejects for most states, throwing an
      // uncaught GatewayError with nothing upstream to catch it (host/brain/sdk-wiring.ts's
      // toSdkMcpServer awaits the handler with no try/catch).
      if (!REHEARSE_FROM.has(state)) return err(`Nothing to rehearse (Teach a task is ${state}).`);
      // Final secfix round 3 (ruling 4): the Bot writes rehearsal.json and trace.json in its own (box-writable) work
      // folder; the host reads them only as real files reached through real folders (never a planted link).
      const work = teachWorkDir(d.cfg.workspace, cur.sessionId);
      const rehearsalFile = path.join(work, "rehearsal.json");
      const rehearsalText = readBoxFile(d.cfg.workspace, rehearsalFile);
      if (rehearsalText === null) return err(`No readable rehearsal.json in ${work} yet (it must be a regular file, not a link). Wait for the rehearsal task to finish.`);
      const traceText = readBoxFile(d.cfg.workspace, path.join(work, "trace.json"));
      let r: ReturnType<typeof evaluateRehearsal>;
      try {
        r = evaluateRehearsal(JSON.parse(rehearsalText), traceText === null ? undefined : JSON.parse(traceText));
      } catch (e) {
        return err(`rehearsal.json or trace.json isn't valid JSON: ${(e as Error).message}`);
      }
      // Evidence (rehearsalFile) is deleted only once every state transition below has succeeded,
      // and any transition failure is reported gracefully instead of thrown.
      try {
        if (state === "ANALYZING" || state === "NEEDS_FIX") move(["DRAFTED"]);
        if (d.recorder.status().state === "DRAFTED" || d.recorder.status().state === "TESTED") move(["REHEARSING"]);
        move([r.pass ? "TESTED" : "NEEDS_FIX"]);
      } catch (e) {
        return err(e instanceof GatewayError ? e.message : String(e));
      }
      removeBoxPath(d.cfg.workspace, rehearsalFile); // the next rehearsal writes a fresh one
      if (r.pass) {
        // Same reasoning as the "accept" branch above: setSkillStatus can now throw (fails closed).
        try {
          setSkillStatus(skillPath, "tested", d.write, d.cfg);
        } catch (e) {
          return err(e instanceof GatewayError ? e.message : String(e));
        }
        return { text: `${rehearsalSummary(r)} The skill is marked tested. Tell the user and ask whether to keep it.` };
      }
      const n = (failures.get(cur.sessionId) ?? 0) + 1;
      failures.set(cur.sessionId, n);
      if (n <= LIMITS.teachRehearsalRevisions) return { text: `${rehearsalSummary(r)} Revise the skill where it didn't match (revision ${n} of ${LIMITS.teachRehearsalRevisions}), save it, then run a new rehearsal.` };
      return { text: `${rehearsalSummary(r)} Two automatic revisions didn't fix it. Ask the user how to proceed.` };
    },
  }];
}
