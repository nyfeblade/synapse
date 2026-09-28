import fs from "node:fs";
import path from "node:path";
import { LIMITS, type B2BKind } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import type { RequestStore } from "./requests";

/** One message between two Bots. `text` is stored collapsed and ≤ 120 chars; `sha1` and `tokens` come from the full message (Task 26). */
export interface ThreadLine { at: number; from: string; to: string; kind: B2BKind; text: string; sha1: string; tokens: string[]; artifacts: string[]; rid?: string }
interface File { version: 1; lines: ThreadLine[] }
const MAX_LINES = 50;
const DIGEST_TEXT = 80;

const pairKey = (a: string, b: string) => [a, b].sort().join("__");

/** ORIG-09 §09.4: one file per pair of Bots in `/home/box/.host/b2b-threads/<idA>__<idB>.json`. */
export class ThreadStore {
  constructor(private dir: string, private now: () => number = Date.now) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(a: string, b: string): string {
    return path.join(this.dir, `${pairKey(a, b)}.json`);
  }

  lines(a: string, b: string): ThreadLine[] {
    return readJson<File>(this.file(a, b), { version: 1, lines: [] }).lines;
  }

  record(line: ThreadLine): void {
    const stored: ThreadLine = { ...line, text: line.text.replace(/\s+/g, " ").trim().slice(0, LIMITS.digestLineMax) };
    const lines = [...this.lines(line.from, line.to), stored].slice(-MAX_LINES);
    writeJsonAtomic(this.file(line.from, line.to), { version: 1, lines } satisfies File, 0o600);
  }

  /** Deterministic digest seen by `viewer` about its thread with `peer`: open requests, the last 3 exchanges, the files mentioned. ≤ 800 chars. */
  digest(viewer: string, peer: string, requests: RequestStore, nameOf: (id: string) => string): string {
    const name = nameOf(peer);
    const who = (id: string) => (id === viewer ? "you" : nameOf(id));
    const ago = (ms: number) => `${Math.max(1, Math.round((this.now() - ms) / 60_000))} min ago`;
    const clip = (s: string) => (s.length > DIGEST_TEXT ? `${s.slice(0, DIGEST_TEXT - 1)}…` : s);
    const open = [...requests.openBetween(viewer, peer), ...requests.openBetween(peer, viewer)].sort((a, b) => a.createdAt - b.createdAt);
    const openText = open.length
      ? open.map((r) => `${r.rid} (${r.from === viewer ? "you asked" : `${name} asked`}: "${clip(r.expects)}", ${ago(r.createdAt)})`).join("; ")
      : "none";
    const all = this.lines(viewer, peer);
    const recent = all.slice(-3).map((l) => `${who(l.from)}→${who(l.to)} ${l.kind} "${clip(l.text)}"`).join(" · ");
    const files = [...new Set(all.flatMap((l) => l.artifacts))].slice(-5);
    const parts = [`Thread with ${name} (id ${peer.slice(0, 4)}…): open: ${openText}.`];
    if (recent) parts.push(`Recent: ${recent}`);
    if (files.length) parts.push(`Files: ${files.join(", ")}`);
    const s = parts.join("\n");
    return s.length > LIMITS.digestMaxChars ? `${s.slice(0, LIMITS.digestMaxChars - 1)}…` : s;
  }

  removeBot(id: string): void {
    for (const f of fs.readdirSync(this.dir)) {
      if (f.replace(/\.json$/, "").split("__").includes(id)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
