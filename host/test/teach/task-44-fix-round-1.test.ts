import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSlot } from "../../runner/turn-slot";
import { teachAnalyzeProvider } from "../../teach/analyze";
import { appendQueueEntry } from "../../teach/queue";
import type { SidecarEvent } from "../../teach/sidecar";
import { tmpConfig } from "../helpers";

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

const W = { title: "Expenses — Chromium", class: "chromium" };
const EVENTS: SidecarEvent[] = [
  { t: 0, type: "nav", url: "https://expenses.example/new", title: "New expense", tabId: "T1" },
  { t: 1000, type: "pointer", action: "down", x: 1, y: 1, button: 1, window: W },
  { t: 1000, type: "target", role: "textbox", name: "Amount", url: "https://expenses.example/new", bbox: null },
  { t: 1080, type: "pointer", action: "up", x: 1, y: 1, button: 1, window: W },
  { t: 1500, type: "field", role: "input", name: "amount", inputType: "text", value: "42.10" },
];

function setUp() {
  const cfg = tmpConfig();
  fs.mkdirSync(cfg.hostPrivate, { recursive: true });
  const sessionId = "teach-20260919-000000-abc";
  const dir = path.join(cfg.workspace, "teach-sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  appendQueueEntry({
    keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"),
    queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl"),
    entry: { sessionId, botId: "bot-1", sessionDir: dir, createdAt: 1 },
  });
  const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "teach", hidden: true, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
  const tool = teachAnalyzeProvider({ cfg, extractFrames: async (_v, picks) => picks.map((p) => path.join(dir, p.file)) })("bot-1", () => slot)[0]!;
  return { cfg, sessionId, dir, tool };
}

// Finding 1: host/teach/analyze.ts:175 wrote analysis.json with a plain fs.writeFileSync instead of the
// project's atomic tmp+fsync+rename convention (writeJsonAtomic, already used by recorder.ts:144 for
// session.json in this same session folder). A crash or concurrent read mid-write can leave a
// truncated/corrupt analysis.json for the next teach-pipeline tool.
describe("Task 44 fix round 1", () => {
  describe("finding 1: analysis.json is written atomically", () => {
    afterEach(() => vi.restoreAllMocks());

    // Final secfix round 3 (ruling 4): the atomic tmp+rename write is now writeHostOwnedFileAtomic (the recording
    // folder is host-owned under /workspace/.host-out/teach; every component is verified).
    it("analyze.ts imports writeHostOwnedFileAtomic and does not write analysis.json with a raw fs.writeFileSync", () => {
      const s = src("teach/analyze.ts");
      expect(s).toMatch(/import\s*\{[^}]*writeHostOwnedFileAtomic[^}]*\}\s*from\s*["']\.\.\/util\/host-owned-file["']/);
      expect(s).not.toMatch(/fs\.writeFileSync\(path\.join\(dir, "analysis\.json"\)/);
    });

    it("writing analysis.json goes through a rename (tmp file -> final path), not a direct write", async () => {
      const { dir, tool } = setUp();
      fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ goal: "File an expense", startedAtMs: 1, videoStartPtsMs: 250 }));
      fs.writeFileSync(path.join(dir, "events.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const renameSpy = vi.spyOn(fs, "renameSync");
      const r = await tool.handler({ session: path.basename(dir) });
      expect(r.isError).toBeUndefined();

      const analysisFile = path.join(dir, "analysis.json");
      expect(fs.existsSync(analysisFile)).toBe(true);
      const renamedToAnalysis = renameSpy.mock.calls.some((c) => String(c[1]) === analysisFile && /\.tmp$/.test(String(c[0])));
      expect(renamedToAnalysis).toBe(true);
    });
  });

  // Finding 2: host/teach/analyze.ts:166,168 ran fs.readFileSync/JSON.parse on session.json and each
  // events.jsonl line unguarded inside the async handler. A missing or corrupt session.json (e.g. a
  // queue entry outliving a deleted or partially-written session dir) threw out of the handler instead
  // of returning a structured {isError:true} result, unlike queue.ts:27-31 and bot-tools.ts's createAgent.
  describe("finding 2: a missing or corrupt session.json/events.jsonl returns a structured error", () => {
    it("returns isError:true instead of throwing when session.json is missing", async () => {
      const { tool, sessionId } = setUp();
      // No session.json written at all (dir exists but is empty/partially written).
      const r = await tool.handler({ session: sessionId });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(sessionId);
    });

    it("returns isError:true instead of throwing when session.json is corrupt JSON", async () => {
      const { dir, tool, sessionId } = setUp();
      fs.writeFileSync(path.join(dir, "session.json"), "{not valid json");
      const r = await tool.handler({ session: sessionId });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(sessionId);
    });

    it("returns isError:true instead of throwing when an events.jsonl line is corrupt JSON", async () => {
      const { dir, tool, sessionId } = setUp();
      fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ goal: "File an expense", startedAtMs: 1, videoStartPtsMs: 250 }));
      fs.writeFileSync(path.join(dir, "events.jsonl"), "{not valid json\n");
      const r = await tool.handler({ session: sessionId });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(sessionId);
    });
  });
});
