import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LIMITS } from "@synapse/shared";
import { z } from "zod";
import type { BotToolDef } from "../brain/types";
import type { HostConfig } from "../config";
import type { ToolProvider } from "../runner/turn-runner";
import { teachWorkDir } from "../util/host-out";
import { removeHostOwnedPath, writeHostOwnedFile, writeHostOwnedFileAtomic } from "../util/host-owned-file";
import { findQueueEntry } from "./queue";
import { looksSecret, SECRET_PARAM } from "./redact";
import type { SidecarEvent } from "./sidecar";

const run = promisify(execFile);

export interface Step {
  n: number; tStart: number; tEnd: number; kind: "click" | "key" | "navigate" | "field";
  target: { role: string; name: string; url: string | null } | null; key?: string; url?: string;
  fields: { name: string; value: string }[]; thinkingBefore: boolean;
}
export interface FramePick { stepN: number; atMs: number; file: string }
export interface ParamCandidate {
  source: "field" | "url"; label: string; value: string | null; secret: boolean;
  typeGuess: "string" | "date" | "time" | "email" | "phone" | "number" | "url" | "file" | "secret"; t: number;
}
type Extract = (video: string, picks: FramePick[], outDir: string, o?: { max?: number; videoOnly?: boolean }) => Promise<string[]>;

const nameKey = (s: Step) => (s.target?.name ? s.target.name.trim().toLowerCase() : null);

/** Stage 1: steps start at each pointer-down, Return, navigation and field commit. */
export function segment(events: SidecarEvent[]): Step[] {
  const evs = [...events].sort((a, b) => a.t - b.t);
  const raw: Step[] = [];
  let cur: Step | null = null;
  const open = (s: Omit<Step, "n" | "thinkingBefore" | "fields"> & { fields?: Step["fields"] }) => {
    cur = { n: 0, thinkingBefore: false, fields: [], ...s };
    raw.push(cur);
  };
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]!;
    if (e.type === "pointer" && e.action === "down") {
      const tgt = evs.slice(i + 1).find((x) => x.type === "target" && x.t === e.t);
      const target = tgt && tgt.type === "target" ? { role: tgt.role, name: tgt.name, url: tgt.url } : null;
      open({ tStart: e.t, tEnd: e.t, kind: "click", target });
    } else if (e.type === "key" && e.key === "Return") {
      open({ tStart: e.t, tEnd: e.t, kind: "key", target: null, key: "Return" });
    } else if (e.type === "nav") {
      open({ tStart: e.t, tEnd: e.t, kind: "navigate", target: { role: "page", name: e.title, url: e.url }, url: e.url });
    } else if (e.type === "field") {
      const c = cur as Step | null;
      const same = c && nameKey(c) === e.name.trim().toLowerCase() && e.t - c.tEnd <= LIMITS.teachMergeSameTargetMs;
      if (same) { c.fields.push({ name: e.name, value: e.value }); c.tEnd = e.t; }
      else open({ tStart: e.t, tEnd: e.t, kind: "field", target: { role: e.role, name: e.name, url: null }, fields: [{ name: e.name, value: e.value }] });
    } else if (cur && e.type !== "snapshot" && e.type !== "target") {
      (cur as Step).tEnd = Math.max((cur as Step).tEnd, e.t);
    }
  }
  // Merge events on the same target within 1.5 s.
  const merged: Step[] = [];
  for (const s of raw) {
    const prev = merged.at(-1);
    const k = nameKey(s);
    if (prev && k && nameKey(prev) === k && s.kind !== "navigate" && prev.kind !== "navigate" && s.tStart - prev.tEnd <= LIMITS.teachMergeSameTargetMs) {
      prev.tEnd = Math.max(prev.tEnd, s.tEnd);
      prev.fields.push(...s.fields);
      continue;
    }
    merged.push(s);
  }
  merged.forEach((s, i) => {
    s.n = i + 1;
    s.thinkingBefore = i > 0 && s.tStart - merged[i - 1]!.tEnd > LIMITS.teachThinkingGapMs;
  });
  return merged;
}

/** Stage 2: frames just before and just after each step, in video time, capped (evenly thinned, keeping the first and last). */
export function selectFrames(steps: Step[], o: { videoStartPtsMs: number; max: number }): FramePick[] {
  const all: FramePick[] = [];
  for (const s of steps) {
    const tag = String(s.n).padStart(3, "0");
    for (const [suffix, t] of [["a", s.tStart - 300], ["b", s.tEnd + 700]] as const) {
      const atMs = Math.max(0, t - o.videoStartPtsMs);
      if (all.some((p) => Math.abs(p.atMs - atMs) < 100)) continue;
      all.push({ stepN: s.n, atMs, file: `frames/s${tag}-${suffix}.jpg` });
    }
  }
  if (all.length <= o.max) return all;
  const out: FramePick[] = [];
  for (let i = 0; i < o.max; i++) out.push(all[Math.round((i * (all.length - 1)) / (o.max - 1))]!);
  return out;
}

function guess(value: string, inputType = ""): ParamCandidate["typeGuess"] {
  if (inputType === "file" || /fakepath/i.test(value) || /\.[a-z][a-z0-9]{1,3}$/i.test(value)) return "file";
  if (/^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return "date";
  if (/^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test(value)) return "time";
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value)) return "email";
  if (/^\+?[\d\s().-]{7,}$/.test(value) && /\d{3}/.test(value) && !/^\d+$/.test(value)) return "phone";
  if (/^[$€£]?\d+(?:[.,]\d+)?$/.test(value)) return "number";
  if (/^https?:\/\//.test(value)) return "url";
  return "string";
}

/** Stage 4a: host-side candidates; the drafting prompt decides which ones vary per run. */
export function paramCandidates(events: SidecarEvent[]): ParamCandidate[] {
  const out: ParamCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: ParamCandidate) => {
    const k = `${c.source}|${c.label}|${c.value}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  };
  for (const e of events) {
    if (e.type === "field") {
      // I8: a secret-looking name or value is a secret parameter, and its value is never carried
      if (e.value === "[redacted]" || SECRET_PARAM.test(e.name) || looksSecret(e.value)) { add({ source: "field", label: e.name, value: null, secret: true, typeGuess: "secret", t: e.t }); continue; }
      const value = e.inputType === "file" ? e.value.split(/[\\/]/).pop()! : e.value;
      add({ source: "field", label: e.name, value, secret: false, typeGuess: guess(value, e.inputType), t: e.t });
    } else if (e.type === "nav") {
      let u: URL;
      try { u = new URL(e.url); } catch { continue; }
      for (const [k, v] of u.searchParams) {
        if (SECRET_PARAM.test(k) || looksSecret(v)) add({ source: "url", label: k, value: null, secret: true, typeGuess: "secret", t: e.t });
        else add({ source: "url", label: k, value: v, secret: false, typeGuess: guess(v), t: e.t });
      }
    }
  }
  return out;
}

export async function defaultExtractFrames(video: string, picks: FramePick[], outDir: string, o: { max?: number; videoOnly?: boolean } = {}): Promise<string[]> {
  const max = o.max ?? LIMITS.teachFramesMax;
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  if (o.videoOnly) {
    await run("ffmpeg", ["-y", "-protocol_whitelist", "file", "-i", video, "-vf", "fps=1,scale=1280:-2", "-frames:v", String(max), path.join(framesDir, "f%04d.jpg")]);
    return fs.readdirSync(framesDir).sort().map((f) => path.join(framesDir, f));
  }
  const files: string[] = [];
  for (const p of picks) {
    const out = path.join(outDir, p.file);
    await run("ffmpeg", ["-y", "-ss", (p.atMs / 1000).toFixed(3), "-protocol_whitelist", "file", "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", out]);
    files.push(out);
  }
  const room = max - files.length;
  if (room > 0) {
    await run("ffmpeg", ["-y", "-protocol_whitelist", "file", "-i", video, "-vf", "select='gt(scene,0.3)',scale=1280:-2", "-vsync", "vfr", "-frames:v", String(room), path.join(framesDir, "k%04d.jpg")]);
    files.push(...fs.readdirSync(framesDir).filter((f) => f.startsWith("k")).sort().map((f) => path.join(framesDir, f)));
  }
  return files;
}

const TRACE_FORMAT = `{goal, steps: [{n, intent ≤120, action: click|type|select|key|navigate|scroll|drag|wait|open_app|upload|download,
 target: {kind: web|desktop, urlPattern?, role?, name?, window?}, value?: {literal?, source: typed|selected|clicked_text|file_dialog, redacted?},
 expectAfter: {urlPattern?, visibleText?: string[≤3]}, decision?: string, commit: boolean}]}`;

export function teachAnalyzeProvider(d: { cfg: HostConfig; extractFrames?: Extract }): ToolProvider {
  const extract = d.extractFrames ?? defaultExtractFrames;
  return (botId): BotToolDef[] => [{
    name: "TeachAnalyze",
    description: "Analyze a Teach a task recording (the session id from the recording message). Returns the step outline, key frames and parameter candidates for drafting a skill.",
    readOnly: false,
    schema: { session: z.string() },
    handler: async (a) => {
      const sessionId = String(a.session).trim().split("/").filter(Boolean).pop() ?? "";
      const entry = /^teach-[\w-]+$/.test(sessionId)
        ? findQueueEntry({ keyFile: path.join(d.cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(d.cfg.hostPrivate, "teach-queue.jsonl"), sessionId, botId })
        : null;
      if (!entry) return { text: `Unknown recording session "${String(a.session)}". Use the session id from the recording message.`, isError: true };
      const dir = entry.sessionDir;
      let session: { goal: string; videoStartPtsMs: number | null };
      let events: SidecarEvent[];
      try {
        session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as { goal: string; videoStartPtsMs: number | null };
        const evFile = path.join(dir, "events.jsonl");
        events = fs.existsSync(evFile) ? fs.readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SidecarEvent) : [];
      } catch (e) {
        return { text: `Could not read recording session "${sessionId}": ${(e as Error).message}`, isError: true };
      }
      // I8: ffmpeg reads only a real file the host published (a Bot-planted link to anything else is refused).
      try {
        const st = fs.lstatSync(path.join(dir, "demo.mp4"));
        if (st.isSymbolicLink() || !st.isFile()) return { text: `The recording video for "${sessionId}" is not a regular file.`, isError: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const videoOnly = events.length === 0;
      const steps = segment(events);
      const picks = selectFrames(steps, { videoStartPtsMs: session.videoStartPtsMs ?? 0, max: LIMITS.teachFramesMax });
      // Final secfix round 3 (ruling 4): ffmpeg writes only into a host-private scratch folder; the frames and
      // analysis.json are then published 0640 into the host-owned recording folder (every component host-owned,
      // verified per file). Nothing the host writes ever goes through a folder the Bot can change.
      const ws = d.cfg.workspace;
      const scratch = path.join(d.cfg.hostPrivate, "teach-work", sessionId);
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
      let frames: string[];
      const candidates = paramCandidates(events);
      const decisions = steps.filter((s) => s.thinkingBefore).length;
      try {
        const made = await extract(path.join(dir, "demo.mp4"), picks, scratch, { max: LIMITS.teachFramesMax, videoOnly });
        if (!removeHostOwnedPath(ws, path.join(dir, "frames"))) throw new Error("the recording folder is not host-owned");
        frames = [];
        for (const f of made) {
          const rel = path.relative(scratch, f);
          if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.lstatSync(f).isFile()) continue;
          const out = writeHostOwnedFile(ws, path.join(dir, path.dirname(rel)), path.basename(rel), fs.readFileSync(f), 0o640);
          if (!out) throw new Error("a frame could not be published");
          frames.push(out);
        }
        const analysis = { goal: session.goal, videoOnly, steps, frames, picks, candidates, traceFormat: TRACE_FORMAT };
        if (!writeHostOwnedFileAtomic(ws, dir, "analysis.json", JSON.stringify(analysis, null, 2), 0o640)) throw new Error("analysis.json could not be published");
      } catch (e) {
        return { text: `Could not publish the analysis of "${sessionId}": ${(e as Error).message}`, isError: true };
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      const secrets = candidates.filter((c) => c.secret).length;
      return {
        text: [
          `Analyzed ${sessionId}: ${steps.length} steps (${decisions} decision point${decisions === 1 ? "" : "s"}), ${frames.length} frames, ${candidates.length} parameter candidates (${secrets} secret).${videoOnly ? " No page details were recorded, so frames are sampled once per second." : ""}`,
          `Analysis: ${path.join(dir, "analysis.json")} · Frames: ${path.join(dir, "frames")}`,
          `Next: launch a watchVideo task on ${path.join(dir, "demo.mp4")} with these frames and the analysis, and have it write the step trace to ${path.join(teachWorkDir(d.cfg.workspace, sessionId), "trace.json")} (your work folder; create it if it's missing) in this format: ${TRACE_FORMAT}. Mark commit: true on steps with outside effects (submit, send, pay, delete, publish). Then draft the skill.`,
        ].join("\n"),
      };
    },
  }];
}
