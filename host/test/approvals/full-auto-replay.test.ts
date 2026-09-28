import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFixedRules, localPermAction, type PermMode, type SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool } from "../../review/classify";
import { hostCallStatic } from "../../review/mac-floor";
import { isOwnershipAction } from "../../review/ownership";
import { analyzeShell } from "../../review/static";
import type { ReviewOutcome } from "../../review/types";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

/**
 * full-auto-quiet — THE MEASUREMENT.
 *
 * A replay of a typical coding task and a typical everyday task, one tool call at a time, through the real
 * ApprovalGate with the Bot in Full auto. `cardsBefore` re-applies the OLD Full-auto policy exactly as it stood
 * (the fixed ALWAYS-ASK list, the Mac floor's forceCard, the ownership gates, every Google write, and the
 * F7/F8/F9 static floor); `cardsAfter` is what the gate really does now. The target is ZERO cards unless one of
 * the five categories is genuinely hit — the coding task hits none, and the everyday task hits exactly the two
 * the user named (a send and a spend).
 */
const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };
const MAC = { home: "/Users/me", projectDirs: ["/Users/me/proj"] as string[] };

interface Step { tool: string; input: Record<string, unknown> }
const sh = (command: string, cwd = "/Users/me/proj"): Step => ({ tool: "mcp__bot__ExternalShell", input: { command, cwd } });
const box = (command: string): Step => ({ tool: "Bash", input: { command } });

/** A typical coding task: read the repo, change two files, run the checks, commit and push. */
const CODING: Step[] = [
  box("git status --porcelain"),
  box("ls -la src"),
  { tool: "Read", input: { file_path: "src/invoice.ts" } },
  { tool: "Grep", input: { pattern: "roundCents", path: "src" } },
  { tool: "Edit", input: { file_path: "src/invoice.ts" } },
  { tool: "Write", input: { file_path: "test/invoice.test.ts" } },
  box("npm install"),
  box("npm run typecheck"),
  box("npm test"),
  box("rm -rf dist"),
  box("npm run build"),
  box("git config --global --add safe.directory /workspace"), // the transcript case: a card before, none now
  box("git config --global user.email me@example.com"),
  box("git add -A"),
  box("git commit -m 'fix: round cents half-up'"),
  sh("git push origin main"),
  box("git log --oneline -5"),
];

/** A typical everyday task: find a document, summarise it, reply, and renew a subscription. */
const EVERYDAY: Step[] = [
  sh("ls ~/Downloads", "/Users/me"),
  sh("find ~/Documents -name '*.pdf'", "/Users/me"),
  { tool: "mcp__google__gmail_search", input: { query: "from:accounts@example.com" } },
  { tool: "mcp__google__gmail_read", input: { id: "m1" } },
  { tool: "mcp__google__drive_search", input: { query: "invoice" } },
  sh("cat ~/Documents/notes.md", "/Users/me"),
  sh("curl -s https://api.example.com/fx/latest", "/Users/me"),                                  // reading the web
  sh("osascript -e 'tell application \"Finder\" to get name of every file of folder \"Documents\"'", "/Users/me"),
  { tool: "Write", input: { file_path: "summary.md" } },
  sh("cp /Users/me/proj/summary.md /Users/me/proj/out/summary.md"),
  { tool: "mcp__google__calendar_create", input: { summary: "Review the invoice", start: "10:00", end: "10:30" } },
  { tool: "mcp__bot__update_state", input: { target: "routine", action: "create", name: "weekly-invoice", prompt: "check invoices" } },
  { tool: "mcp__google__gmail_draft", input: { to: "accounts@example.com", subject: "Invoice", body: "Attached." } },
  { tool: "mcp__google__gmail_send", input: { to: "accounts@example.com", subject: "Invoice", body: "Attached." } }, // SEND → a card
  { tool: "mcp__bot__Browser", input: { action: "open", url: "https://shop.example.com/plans" } },
  { tool: "mcp__bot__Browser", input: { action: "snapshot" } },
  { tool: "mcp__bot__Browser", input: { action: "click", ref: "e12", value: "Subscribe" } }, // MONEY → a card
];

function setup(mode: PermMode) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Replay" });
  // Bug 71: the scripts the replay runs exist, as they do in a real project (a script the gate can't read is a card).
  fs.writeFileSync(path.join(cfg.workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "tsc -b" } }));
  fs.writeFileSync(path.join(cfg.workspace, "build.py"), "print('built')\n");
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  let reviews = 0;
  const reviewer: ReviewerLike = { review: async () => { reviews++; return ALLOW; }, clearCache: () => {} };
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS,
    onDeferredResolution: () => {}, permMode: () => mode, macEnv: () => MAC,
    googleEmail: () => "me@example.com", googleBuiltin: () => true,
    googleCardFacts: async () => ({ lines: ["To: accounts@example.com"] }),
  });
  const cards = () => bots.tail(id, 200).filter((x): x is SendMessageEntry => x.kind === "send-message" && x.message.type === "auto-review-approval");
  return { id, cfg, gate, cards, reviews: () => reviews };
}

/** The OLD Full-auto policy, transcribed: what raised a card before this change. */
function cardsBefore(steps: Step[], cfg: ReturnType<typeof tmpConfig>): string[] {
  const out: string[] = [];
  for (const [i, s] of steps.entries()) {
    const call = { toolName: s.tool, input: s.input, toolUseId: `b${i}` };
    const cls = classifyTool(call, { workspace: cfg.workspace, hostPrivate: cfg.hostPrivate, walls: cfg, googleEmail: "me@example.com", googleBuiltin: true });
    if (cls.hardDeny || !cls.surface || !cls.target) continue;
    const macSt = cls.surface === "host_shell" ? hostCallStatic(call, cfg.workspace) : null;
    // Old rule: in Full auto the Mac cards on a floor hit; ownership actions, Google writes and the fixed
    // ALWAYS-ASK always card; so does an F7/F8/F9 static floor on a box command.
    if (macSt && macSt.floorHits.length > 0) { out.push(`${s.tool}: mac floor`); continue; }
    if (cls.target.action === "google_write") { out.push(`${s.tool}: google write`); continue; }
    if (isOwnershipAction(cls.target) || cls.target.action === "create_agent") { out.push(`${s.tool}: ownership`); continue; }
    const perm = cls.surface === "host_shell" ? localPermAction({ op: "run-command", command: String(s.input.command ?? ""), cwd: String(s.input.cwd ?? "") }, MAC.home, MAC.home) : null;
    if (perm && evaluateFixedRules(perm, { home: MAC.home, projectDirs: MAC.projectDirs }).verdict === "always-ask") { out.push(`${s.tool}: fixed always-ask`); continue; }
    if (cls.surface === "box_shell" && cls.target.action === "shell") {
      const st = analyzeShell(String(s.input.command ?? ""), { workspace: cfg.workspace, cwd: cfg.workspace });
      if (st.floorHits.some((f) => f === "F7" || f === "F8" || f === "F9")) { out.push(`${s.tool}: F-floor`); continue; }
    }
    if (cls.surface === "box_shell" && cls.target.action === "write_file") { out.push(`${s.tool}: git-control write`); continue; }
  }
  return out;
}

async function replay(steps: Step[], mode: PermMode) {
  const s = setup(mode);
  const asked: string[] = [];
  for (const [i, step] of steps.entries()) {
    const d = await s.gate.preToolUse(s.id, { toolName: step.tool, input: step.input, toolUseId: `t${i}` });
    if (d.decision === "ask" || d.decision === "defer") asked.push(`${step.tool} ${JSON.stringify(step.input).slice(0, 60)}`);
  }
  return { asked, before: cardsBefore(steps, s.cfg), reviews: s.reviews() };
}

describe("Full auto: the card count on a replay", () => {
  // MEASURED: 3 cards before (two `git config --global` F8 git-control floors and the `git push origin main`
  // fixed ALWAYS-ASK), 0 after. None of the 17 steps is destruction, sending, money or a security change.
  it("a typical coding task: 3 cards before, 0 after", async () => {
    const r = await replay(CODING, "full-auto");
    expect(r.before.length, `old policy cards: ${r.before.join(" | ")}`).toBe(3);
    expect(r.asked, "Full auto raises no card for routine coding work").toEqual([]);
    expect(r.reviews, "and pays for no reviewer call").toBe(0);
  });

  // MEASURED: 5 cards before (two Mac-floor hits on an ordinary `curl` read and an `osascript` Finder query, plus
  // every Google write: a calendar event, a draft and the send), 2 after — the send and the spend, and nothing else.
  it("a typical everyday task: 5 cards before, 2 after — the send and the spend", async () => {
    const r = await replay(EVERYDAY, "full-auto");
    expect(r.before.length, `old policy cards: ${r.before.join(" | ")}`).toBe(5);
    expect(r.asked.length, `asked: ${r.asked.join(" | ")}`).toBe(2);
    expect(r.asked[0]).toContain("gmail_send");
    expect(r.asked[1]).toContain("Browser");
  });

  // ORIG-GOOGLE: a send card is never the blind "send your draft" — the recipients and the content hash the send is
  // pinned to are fetched host-side BEFORE the card, in Full auto too.
  it("the Full-auto send card still carries the host-side recipient facts", async () => {
    const s = setup("full-auto");
    const call = { toolName: "mcp__google__gmail_send", input: { to: "accounts@example.com", subject: "Invoice", body: "Attached." }, toolUseId: "g1" };
    expect((await s.gate.preToolUse(s.id, call)).decision).toBe("ask");
    void s.gate.canUseTool(s.id, call, new AbortController().signal);
    const card = s.cards().at(-1)!.message as { approval: { details: string | null; reason: string } };
    expect(card.approval.details).toContain("accounts@example.com");
    expect(card.approval.details).toContain("Content hash:");
    expect(card.approval.reason).toMatch(/sends an email/i);
  });

  // Bug 194 (live, 2026-09-24): an Engineer Bot in Full auto raised five cards, all "This overwrites a file outside
  // the Bot's own workspace.", for ordinary commands whose only "file" was the /dev/null sink. Real gate, real fs.
  it("the live /dev/null cards: ordinary dev commands that discard output raise no card", async () => {
    const LIVE: Step[] = [
      { tool: "mcp__bot__Shell", input: { command: "which xvfb-run Xvfb 2>/dev/null; echo done" } },
      { tool: "mcp__bot__Shell", input: { command: "pkill -9 -f chromium 2>/dev/null; pkill -9 -f Xvfb 2>/dev/null; sleep 1; echo killed" } },
      { tool: "mcp__bot__Shell", input: { command: "which chromium chromium-browser google-chrome 2>/dev/null; python3 -c \"import playwright\" 2>&1 | tail -1; pip3 show playwright 2>&1 | head -3" } },
      box("python3 build.py && chromium --headless --screenshot=shot2_table.png \"file:///workspace/index.html\" 2>/dev/null\nls -la shot2_table.png"),
      box("npm test > /dev/null 2>&1"),
      { tool: "mcp__bot__Shell", input: { command: "npm test &>/dev/null; npm test >>/dev/null; npm run build >> build.log 2>&1; npm test 2>&1 | tee /dev/null" } },
    ];
    const r = await replay(LIVE, "full-auto");
    expect(r.asked, `asked: ${r.asked.join(" | ")}`).toEqual([]);
    expect(r.reviews).toBe(0);
    // Bug 71: the live run's `npx --yes playwright --version` downloads and runs a package the gate can't see, so it
    // is now a card (never a silent run, never a flat deny), in Full auto too.
    const n = await replay([{ tool: "mcp__bot__Shell", input: { command: "npx --yes playwright --version 2>&1 | tail -5" } }], "full-auto");
    expect(n.asked).toHaveLength(1);
  });

  // Security review of d3903c1b: the other direction, through the real gate and the real fs. An existing file
  // outside every workspace (/usr/bin/true stands in for the user's file; nothing is run — and /tmp, where a test
  // dir would live on Linux, is a Bot workspace) emptied or modified through a descriptor alias or an append/&>
  // redirect still raises a card, and so does an append to a disk device.
  it("still cards a write to the user's file through a descriptor alias or any write-capable redirect", async () => {
    const f = "/usr/bin/true";
    const cmds = [
      `cat <${f} >/dev/stdin`, `echo x 1<${f} >/dev/stdout`, `echo x 3<${f} >/dev/fd/3`, `exec 3<${f}; echo x >/dev/fd/3`,
      `exec 3<${f}; truncate -s0 /dev/fd/3`, `echo x &> ${f}`, `echo x >> ${f}`, `echo x 1<>${f}`, "cat img >> /dev/sda",
    ];
    const asked: string[] = [];
    for (const [i, command] of cmds.entries()) {
      const s = setup("full-auto"); // one gate per command, so a raised card can't hold the next behind the barrier
      const d = await s.gate.preToolUse(s.id, { toolName: "mcp__bot__Shell", input: { command }, toolUseId: `x${i}` });
      if (d.decision === "ask" || d.decision === "defer") asked.push(command);
    }
    expect(asked).toEqual(cmds);
  });

  it("the other modes are untouched: Ask still consults the reviewer for the same work", async () => {
    const r = await replay(CODING, "ask");
    expect(r.reviews).toBeGreaterThan(0);
  });
});
