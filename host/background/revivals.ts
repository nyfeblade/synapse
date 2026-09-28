import { LIMITSC } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../prompts";
import type { HiddenSpec } from "../runner/turn-runner";
import type { PendingKind, PendingWakes } from "./pending-wakes";

export interface Completion { kind: PendingKind; botId: string; taskId: string; block: string }
interface Batch { blocks: Map<string, string>; timer: NodeJS.Timeout }

const SEP = String.fromCharCode(0);

/** EVT-02 #9/#10: completions arriving close together become one hidden background turn per Bot and kind. */
export class Revivals {
  private batches = new Map<string, Batch>();
  private sent = new Set<string>();

  constructor(private o: { enqueueHidden(botId: string, spec: HiddenSpec): void; pending: PendingWakes; batchMs?: number }) {}

  complete(c: Completion): void {
    if (this.sent.has(c.taskId)) return; // deduped by task id
    const key = `${c.botId}${SEP}${c.kind}`;
    let b = this.batches.get(key);
    if (!b) {
      b = { blocks: new Map(), timer: setTimeout(() => this.flush(key), this.o.batchMs ?? LIMITSC.revivalBatchMs) };
      this.batches.set(key, b);
    }
    b.blocks.set(c.taskId, c.block);
  }

  flushAll(): void {
    for (const key of [...this.batches.keys()]) this.flush(key);
  }

  private flush(key: string): void {
    const b = this.batches.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    this.batches.delete(key);
    const [botId, kind] = key.split(SEP) as [string, PendingKind];
    const results = [...b.blocks.values()].join("\n\n");
    const file = kind === "subagent" ? "wakes/subagent-done.md" : "wakes/shell-done.md";
    const ids = [...b.blocks.keys()];
    this.o.enqueueHidden(botId, {
      source: kind === "subagent" ? "subagent-done" : "shell-done", lane: "background", silenceAllowed: true,
      text: fillTemplate(loadPrompt(file), { RESULTS: results }).trimEnd(),
      // EVT-16: the durable markers survive until this turn actually starts. Between here and then the
      // exit code / report lives only in the in-memory scheduler task, and a quit or a crash discards
      // it — removing the markers now leaves ShellService.rewatchAtBoot and
      // SubagentService.recoverAtBoot nothing to replay, so the Bot never learns how its background
      // work ended (and CheckSubagent answers "No subagent <id>").
      onStart: () => { for (const id of ids) this.o.pending.remove(id); },
    });
    for (const id of ids) this.sent.add(id);
  }
}
