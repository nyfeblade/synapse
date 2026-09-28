import path from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain } from "../../brain/fake-brain";
import { StubOneShot } from "../../brain/one-shot";
import { messageText, type TurnInput } from "../../brain/types";
import { ENGINEERING_TASK_IDLE_MS, leanMemoryGate } from "../../engineering/lean-profile";
import { SseHub } from "../../gateway/sse-hub";
import { createMemoryEngineHooks } from "../../memory/engine";
import { EpisodeWriter } from "../../memory/episodes";
import { MemoryExtractor } from "../../memory/extractor";
import { MemoryStore } from "../../memory/memory-store";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";
import type { TurnHooks } from "../../runner/hooks";

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A real TurnRunner over a FakeBrain, with a clock the test moves, and optional turn hooks. */
function setup(o: { hooks?: (bots: BotService, cfg: ReturnType<typeof tmpConfig>) => TurnHooks } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker(() => {});
  bots.setRuntimeView((id) => presence.view(id));
  let now = Date.UTC(2026, 8, 21, 14, 0);
  const runner = new TurnRunner({
    cfg, bots, presence, settings, trays: new TrayService(hub),
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 60_000, retryBaseMs: 1 }, now: () => now,
    hooks: o.hooks?.(bots, cfg),
  });
  const seen: TurnInput[] = [];
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => new FakeBrain(id, runner.wiring(id), (input) => { seen.push(input); return [{ tool: "mcp__bot__SendMessage", input: { content: "Done." } }]; }),
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const turn = async (text: string) => {
    const n = seen.length;
    runner.sendPrompt(id, text, `n${n}`);
    await until(() => seen.length === n + 1);
    await until(() => runner.isIdle(id));
    return seen[n]!.prompt.map(messageText).join("\n");
  };
  const hasClock = (t: string) => /<system_reminder>Now: /.test(t);
  return { id, bots, turn, hasClock, advance: (ms: number) => { now += ms; } };
}

describe("lean engineering profile: the clock rides the first turn of a task only", () => {
  it("engineering mode: turn 1 has the clock, turns 2-3 do not, a quiet gap starts a new task that has it again", async () => {
    const s = setup();
    s.bots.updateSettings(s.id, { engineeringMode: true });
    expect(s.hasClock(await s.turn("fix the failing test in parser.ts"))).toBe(true);
    s.advance(60_000);
    expect(s.hasClock(await s.turn("now run the whole suite"))).toBe(false);
    s.advance(5 * 60_000);
    expect(s.hasClock(await s.turn("commit it"))).toBe(false);
    s.advance(ENGINEERING_TASK_IDLE_MS);
    expect(s.hasClock(await s.turn("next: the lexer"))).toBe(true);
  });

  it("standard mode is unchanged: every turn has the clock; switching engineering back on starts a task", async () => {
    const s = setup();
    expect(s.hasClock(await s.turn("hi"))).toBe(true);
    expect(s.hasClock(await s.turn("and again"))).toBe(true);
    s.bots.updateSettings(s.id, { engineeringMode: true });
    expect(s.hasClock(await s.turn("start coding"))).toBe(true);
    expect(s.hasClock(await s.turn("keep going"))).toBe(false);
    s.bots.updateSettings(s.id, { engineeringMode: false });
    expect(s.hasClock(await s.turn("back to normal"))).toBe(true);
    s.bots.updateSettings(s.id, { engineeringMode: true });
    expect(s.hasClock(await s.turn("coding again"))).toBe(true);
  });
});

describe("lean engineering profile: batched memory extraction, an episode at compaction", () => {
  const run = async (engineering: boolean, o: { reply?: (system: string, user: string) => string; compact?: boolean } = {}) => {
    const calls: string[] = [];
    let engine: ReturnType<typeof createMemoryEngineHooks> | null = null;
    let store: MemoryStore | null = null;
    const s = setup({
      hooks: (bots, cfg) => {
        store = new MemoryStore({ cfg });
        const model = new StubOneShot((p) => {
          const kind = p.system.includes("journal") ? "episode" : "extract";
          calls.push(kind);
          return o.reply?.(p.system, p.user) ?? (kind === "episode" ? "Piper refactored the parser with the user." : "NONE");
        });
        const opts = { store, model, timeZone: () => "UTC", nameOf: () => "Piper", secrets: () => [] };
        // The production gate (app.ts wires the same function).
        engine = createMemoryEngineHooks({ extractor: new MemoryExtractor(opts), episodes: new EpisodeWriter({ ...opts, bots }), lean: leanMemoryGate(bots) });
        return engine;
      },
    });
    if (engineering) s.bots.updateSettings(s.id, { engineeringMode: true });
    const texts = ["Can you check the flight prices for Denver next week?", "Please draft the Q3 update for Dana with the numbers", "What did we decide about the newsletter?", "Remember that I prefer TypeScript over Python", "Please refactor the parser module to use a visitor", "Add tests for the tokenizer edge cases please"];
    const counts: number[] = [];
    for (const t of texts) { await s.turn(t); await new Promise((r) => setTimeout(r, 5)); counts.push(calls.filter((c) => c === "extract").length); }
    const beforeCompact = calls.filter((c) => c === "episode").length;
    if (o.compact) { engine!.compacted(s.id); }
    await engine!.drain();
    return { extract: calls.filter((c) => c === "extract").length, episode: calls.filter((c) => c === "episode").length, beforeCompact, counts, store: store!, id: s.id };
  };

  it("standard mode extracts and writes episodes (unchanged)", async () => {
    const r = await run(false);
    expect(r.extract).toBeGreaterThan(0);
    expect(r.episode).toBe(1);
  });

  it("engineering mode extracts at the batched cadence (one call per 3 memorable exchanges) and writes no per-turn episode", async () => {
    const r = await run(true);
    expect(r.counts).toEqual([0, 0, 1, 1, 1, 2]);
    expect({ extract: r.extract, episode: r.episode }).toEqual({ extract: 2, episode: 0 });
  });

  it("engineering mode writes one episode when the session compacts", async () => {
    const r = await run(true, { compact: true });
    expect(r.beforeCompact).toBe(0);
    expect(r.episode).toBe(1);
    expect(r.store.log({ kind: "agent", botId: r.id }).some((f) => f.kind === "episode" && /parser/.test(f.content))).toBe(true);
  });

  it("a fact stated in an engineering turn reaches memory", async () => {
    const r = await run(true, { reply: (system, user) => (system.includes("journal") ? "NONE" : user.includes("TypeScript over Python") ? "profile: Prefers TypeScript over Python" : "NONE") });
    expect(r.store.profile({ kind: "agent", botId: r.id }).map((f) => f.content)).toContain("Prefers TypeScript over Python");
  });
});

describe("lean engineering profile: production wiring", () => {
  it("app.ts hands every compaction (host /compact and auto) to the memory engine", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../../app.ts", import.meta.url), "utf8");
    expect(src).toMatch(/new Compactor\(\{[\s\S]*?onCompacted: \(bid\) => memoryEngine\.compacted\(bid\)/);
  });
});
