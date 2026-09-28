import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermMode, SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { TEXT } from "../../review/texts";
import type { ReviewOutcome } from "../../review/types";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// Bug 71 (usability ruling): a command whose scripts Synapse couldn't see or follow never runs silently and is never a
// flat deny. It is an approval card showing the exact command and saying so, in EVERY mode, Full auto included, and
// with Auto-review off; the reviewer is not asked (it couldn't see the script either).

const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };

function setup(mode: PermMode, autoReview = true) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  if (!autoReview) settings.update({ autoReviewEnabled: false });
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Unbound" });
  fs.writeFileSync(path.join(cfg.workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "cross-env A=1 npm run evil", evil: "node evil.js" } }));
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  let reviews = 0;
  const reviewer: ReviewerLike = { review: async () => { reviews++; return ALLOW; }, clearCache: () => {} };
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {}, permMode: () => mode });
  const cards = () => bots.tail(id, 200).filter((x): x is SendMessageEntry => x.kind === "send-message" && x.message.type === "auto-review-approval");
  return { id, gate, cards, reviews: () => reviews };
}

describe("an unbound command is a card in every mode (bug 71 usability ruling)", () => {
  const UNBOUND = ["npm run lint", "python3 missing.py", "bash -c 'npm run evil'", "npx some-package --yes"];
  for (const [mode, autoReview] of [["ask", true], ["accept-edits", true], ["full-auto", true], ["ask", false], ["full-auto", false]] as const) {
    it(`${mode}${autoReview ? "" : ", Auto-review off"}: never runs silently, never a flat deny; the card shows the exact command`, async () => {
      for (const [i, command] of UNBOUND.entries()) {
        const s = setup(mode, autoReview); // one gate per command, so a card can't hold the next behind the barrier
        const call = { toolName: "Bash", input: { command }, toolUseId: `u${i}` };
        const d = await s.gate.preToolUse(s.id, call);
        expect(d.decision, `${command}`).toBe("ask");
        expect((d as { reason?: string }).reason).toBe(TEXT.unboundCard);
        void s.gate.canUseTool(s.id, call, new AbortController().signal);
        const card = s.cards().at(-1)!.message as { approval: { command: string | null; reason: string } };
        expect(card.approval.command).toBe(command);
        expect(card.approval.reason).toMatch(/^Synapse couldn't see everything this will run/);
        expect(s.reviews(), "the reviewer can't see the script either, so it isn't asked").toBe(0);
      }
    });
  }

  it("a script it can follow (node --test) is no card: it binds and runs the ordinary path", async () => {
    const s = setup("full-auto");
    const d = await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command: "npm test" }, toolUseId: "t1" });
    expect(d.decision).toBe("allow");
    expect(s.cards()).toHaveLength(0);
  });
});
