import { LIMITS, type B2BRequest, type RequestKind } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { newRid } from "./ids";

interface File { version: 1; requests: B2BRequest[] }
const KEEP_CLOSED_MS = 7 * 86_400_000;

/** ORIG-09 §09.1: `b2b-requests.json`. Each request, question, blocker and handoff has an id and is answered by at most one result. */
export class RequestStore {
  private reqs: B2BRequest[];

  constructor(private file: string, private now: () => number = Date.now) {
    this.reqs = readJson<File>(file, { version: 1, requests: [] }).requests;
  }

  open(r: { from: string; to: string; kind: RequestKind; expects: string; taskId?: string; chainId: string }): B2BRequest {
    const req: B2BRequest = { rid: newRid(), from: r.from, to: r.to, kind: r.kind, expects: r.expects, chainId: r.chainId, createdAt: this.now(), status: "open", ...(r.taskId ? { taskId: r.taskId } : {}) };
    this.reqs.push(req);
    this.save();
    return req;
  }

  get(rid: string): B2BRequest | null {
    return this.reqs.find((r) => r.rid === rid) ?? null;
  }

  answer(rid: string, by: string, preview: string): void {
    const r = this.get(rid);
    if (!r || r.status !== "open") throw new Error(`request ${rid} is not open`);
    r.status = "answered";
    r.answeredBy = by;
    r.answeredAt = this.now();
    r.answerPreview = preview.replace(/\s+/g, " ").trim().slice(0, 200);
    this.save();
  }

  openBetween(from: string, to: string): B2BRequest[] {
    return this.reqs.filter((r) => r.status === "open" && r.from === from && r.to === to);
  }
  openTo(botId: string): B2BRequest[] {
    return this.reqs.filter((r) => r.status === "open" && r.to === botId);
  }
  openFrom(botId: string): B2BRequest[] {
    return this.reqs.filter((r) => r.status === "open" && r.from === botId);
  }

  /** G6: requests from→to that are open, or were answered within `sinceMs`. */
  recentBetween(from: string, to: string, sinceMs: number): B2BRequest[] {
    const t = this.now();
    return this.reqs.filter((r) => r.from === from && r.to === to && (r.status === "open" || (r.status === "answered" && t - (r.answeredAt ?? 0) <= sinceMs)));
  }

  terminate(rids: string[]): void {
    for (const r of this.reqs) if (rids.includes(r.rid) && r.status === "open") r.status = "terminated";
    this.save();
  }

  /** Open requests expire 24 h after creation; each is returned once, when it expires. */
  expireDue(): B2BRequest[] {
    const t = this.now();
    const due = this.reqs.filter((r) => r.status === "open" && t - r.createdAt >= LIMITS.openRequestExpiryMs);
    for (const r of due) r.status = "expired";
    const before = this.reqs.length;
    this.reqs = this.reqs.filter((r) => r.status === "open" || t - (r.answeredAt ?? r.createdAt) < KEEP_CLOSED_MS);
    if (due.length || this.reqs.length !== before) this.save();
    return due;
  }

  /** L4: waiter → set of Bots it waits on (open requests, questions and blockers; handoffs don't wait). */
  waitGraph(): Map<string, Set<string>> {
    const g = new Map<string, Set<string>>();
    for (const r of this.reqs) {
      if (r.status !== "open" || r.kind === "handoff") continue;
      const s = g.get(r.from) ?? new Set<string>();
      s.add(r.to);
      g.set(r.from, s);
    }
    return g;
  }

  removeBot(botId: string): void {
    this.reqs = this.reqs.filter((r) => r.from !== botId && r.to !== botId);
    this.save();
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, requests: this.reqs } satisfies File, 0o600);
  }
}
