import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newSlot } from "../../runner/turn-slot";
import { paramCandidates, segment, selectFrames, teachAnalyzeProvider } from "../../teach/analyze";
import { appendQueueEntry } from "../../teach/queue";
import type { SidecarEvent } from "../../teach/sidecar";
import { tmpConfig } from "../helpers";

const W = { title: "Expenses — Chromium", class: "chromium" };
const click = (t: number, role: string, name: string, url = "https://expenses.example/new"): SidecarEvent[] => [
  { t, type: "pointer", action: "down", x: 1, y: 1, button: 1, window: W },
  { t, type: "target", role, name, url, bbox: null },
  { t: t + 80, type: "pointer", action: "up", x: 1, y: 1, button: 1, window: W },
];
const EVENTS: SidecarEvent[] = [
  { t: 0, type: "nav", url: "https://expenses.example/new", title: "New expense", tabId: "T1" },
  ...click(1000, "textbox", "Amount"),
  { t: 1200, type: "text", chars: 5 },
  { t: 1500, type: "field", role: "input", name: "amount", inputType: "text", value: "42.10" },
  ...click(2000, "textbox", "Amount"),
  ...click(12_000, "combobox", "Category"),
  { t: 12_500, type: "field", role: "select", name: "category", inputType: "select-one", value: "Meals" },
  ...click(13_000, "button", "Receipt"),
  { t: 13_400, type: "field", role: "input", name: "receipt", inputType: "file", value: "C:\\fakepath\\receipt.pdf" },
  { t: 14_000, type: "field", role: "input", name: "password", inputType: "password", value: "[redacted]" },
  { t: 15_000, type: "key", key: "Return" },
  { t: 15_100, type: "nav", url: "https://expenses.example/done?report=881&date=2026-09-18", title: "Submitted", tabId: "T1" },
];

describe("segment (ORIG-08 §08.2 stage 1)", () => {
  it("splits at pointer-down, Return, navigation and field commits; merges the same target within 1.5 s; marks >8 s gaps", () => {
    const steps = segment(EVENTS);
    expect(steps.map((s) => [s.n, s.kind, s.kind === "navigate" ? s.url : s.target?.name ?? s.key, s.thinkingBefore])).toEqual([
      [1, "navigate", "https://expenses.example/new", false],
      [2, "click", "Amount", false],
      [3, "click", "Category", true],
      [4, "click", "Receipt", false],
      [5, "field", "password", false],
      [6, "key", "Return", false],
      [7, "navigate", "https://expenses.example/done?report=881&date=2026-09-18", false],
    ]);
    expect(steps[1]).toMatchObject({ tStart: 1000, tEnd: 2080, fields: [{ name: "amount", value: "42.10" }] });
  });
});

describe("selectFrames (stage 2)", () => {
  it("takes tStart−300 ms and tEnd+700 ms per step in video time, deduped, capped", () => {
    const steps = segment(EVENTS);
    const picks = selectFrames(steps, { videoStartPtsMs: 250, max: 120 });
    expect(picks[0]).toEqual({ stepN: 1, atMs: 0, file: "frames/s001-a.jpg" });
    expect(picks.find((p) => p.file === "frames/s002-b.jpg")!.atMs).toBe(2080 + 700 - 250);
    expect(new Set(picks.map((p) => p.file)).size).toBe(picks.length);
    const capped = selectFrames(steps, { videoStartPtsMs: 0, max: 5 });
    expect(capped).toHaveLength(5);
    expect(capped[0]!.file).toBe("frames/s001-a.jpg");
    expect(capped.at(-1)!.file).toBe("frames/s007-b.jpg");
  });
});

describe("paramCandidates (stage 4a)", () => {
  it("proposes field values, typed guesses, URL query values and secret slots", () => {
    const c = paramCandidates(EVENTS);
    expect(c.map((x) => [x.source, x.label, x.value, x.typeGuess, x.secret])).toEqual([
      ["field", "amount", "42.10", "number", false],
      ["field", "category", "Meals", "string", false],
      ["field", "receipt", "receipt.pdf", "file", false],
      ["field", "password", null, "secret", true],
      ["url", "report", "881", "number", false],
      ["url", "date", "2026-09-18", "date", false],
    ]);
  });
});

describe("TeachAnalyze tool", () => {
  it("analyzes a signed session of the calling Bot and refuses anything else", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    const dir = path.join(cfg.workspace, "teach-sessions", "teach-20260918-171200-abc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ goal: "File an expense", startedAtMs: 1, videoStartPtsMs: 250, sidecarVersion: 1 }));
    fs.writeFileSync(path.join(dir, "events.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n");
    appendQueueEntry({ keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl"), entry: { sessionId: "teach-20260918-171200-abc", botId: "bot-1", sessionDir: dir, createdAt: 1 } });
    const extracted: number[] = [];
    const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "teach", hidden: true, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
    const tool = teachAnalyzeProvider({ cfg, extractFrames: async (_v, picks) => { extracted.push(picks.length); return picks.map((p) => path.join(dir, p.file)); } })("bot-1", () => slot)[0]!;
    expect(tool.name).toBe("TeachAnalyze");
    const r = await tool.handler({ session: "teach-20260918-171200-abc" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("7 steps (1 decision point)");
    expect(r.text).toContain(path.join(dir, "trace.json"));
    const analysis = JSON.parse(fs.readFileSync(path.join(dir, "analysis.json"), "utf8"));
    expect(analysis).toMatchObject({ goal: "File an expense", videoOnly: false });
    expect(analysis.steps).toHaveLength(7);
    expect(analysis.candidates).toHaveLength(6);
    expect(extracted).toEqual([12]);
    const other = teachAnalyzeProvider({ cfg, extractFrames: async () => [] })("bot-2", () => slot)[0]!;
    expect((await other.handler({ session: "teach-20260918-171200-abc" })).isError).toBe(true);
    expect((await tool.handler({ session: "../../etc" })).isError).toBe(true);
  });
});
