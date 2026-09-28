import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, syncIfDurable, writeJsonAtomic } from "../../util/atomic-json";

/** Mirrors writeJsonAtomic's durability convention (tmp, fsync, rename) for plain-text files. */
function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, text);
    syncIfDurable(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export interface MemoryFact { id: string; content: string; createdAt: string; kind: "profile" | "log"; origin: "explicit" | "synthesis" | "legacy"; strength: number }
export type DreamChange =
  | { op: "create"; content: string; kind: "profile" | "log"; sourceEvidenceIds: string[] }
  | { op: "update"; id: string; content: string; kind: "profile" | "log"; sourceEvidenceIds: string[] }
  | { op: "remove"; id: string; sourceEvidenceIds: string[] };

export const normalizeFact = (c: string) => c.toLowerCase().replace(/\s+/g, " ").trim();
export const factId = (c: string) => createHash("sha1").update(normalizeFact(c)).digest("hex").slice(0, 16);
const LINE = /^- \((\d{4}-\d{2}-\d{2})\) (\[(?:note|episode)\] )?(.+)$/;

interface Origins { enabledAt: number; byId: Record<string, "synthesis" | "legacy"> }

/** MEM-07 over Phase 2's files (§4.2): profile.md, log/YYYY-MM.md; dreaming state in memory/.dreaming/. */
export class DreamMemoryPort {
  /** `redact`: the Phase 3 secret scanner's redact (I5), applied to every fact a dreaming pass writes. */
  constructor(private dataRoot: string, private now: () => number, private redact: (botId: string, text: string) => string = (_b, t) => t) {}

  private mem(botId: string, ...p: string[]): string { return path.join(this.dataRoot, "agents", botId, "memory", ...p); }
  private files(botId: string): { file: string; kind: "profile" | "log" }[] {
    const logDir = this.mem(botId, "log");
    return [
      { file: this.mem(botId, "profile.md"), kind: "profile" as const },
      ...(fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".md")).sort().map((f) => ({ file: path.join(logDir, f), kind: "log" as const })) : []),
    ].filter((x) => fs.existsSync(x.file));
  }
  private origins(botId: string): Origins { return readJson<Origins>(this.mem(botId, ".dreaming", "origins.json"), { enabledAt: 0, byId: {} }); }
  private today(): string { return new Date(this.now()).toISOString().slice(0, 10); }

  /** First pass after Dreaming is switched on: every existing fact is "legacy". */
  ensureInit(botId: string): void {
    const f = this.mem(botId, ".dreaming", "origins.json");
    if (fs.existsSync(f)) return;
    const byId: Origins["byId"] = {};
    for (const x of this.raw(botId)) byId[x.id] = "legacy";
    writeJsonAtomic(f, { enabledAt: this.now(), byId }, 0o640);
  }

  private raw(botId: string): { id: string; content: string; createdAt: string; kind: "profile" | "log"; file: string; line: number; tag: string }[] {
    return this.files(botId).flatMap(({ file, kind }) => fs.readFileSync(file, "utf8").split("\n").flatMap((l, line) => {
      const m = LINE.exec(l.trim());
      return m ? [{ id: factId(m[3]!), content: m[3]!, createdAt: m[1]!, kind, file, line, tag: m[2] ?? "" }] : [];
    }));
  }

  facts(botId: string): MemoryFact[] {
    const o = this.origins(botId);
    const meta = readJson<{ byId?: Record<string, { strength?: number }> }>(this.mem(botId, ".meta.json"), {});
    return this.raw(botId).map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt, kind: r.kind, origin: o.byId[r.id] ?? "explicit", strength: meta.byId?.[r.id]?.strength ?? 1 }));
  }

  expiryCandidates(botId: string): string[] {
    return this.raw(botId).filter((r) => r.tag.startsWith("[note]")).map((r) => r.id).filter((idv) => (this.facts(botId).find((f) => f.id === idv)?.strength ?? 1) < 0.05);
  }

  tombstoned(botId: string): Set<string> {
    return new Set(readJson<{ id: string }[]>(this.mem(botId, ".dreaming", "tombstones.json"), []).map((t) => t.id));
  }

  fingerprint(botId: string): string {
    return createHash("sha1").update(this.raw(botId).map((r) => r.id).join(",")).digest("hex").slice(0, 16);
  }

  apply(botId: string, input: DreamChange[]): void {
    const changes = input.map((c) => (c.op === "remove" ? c : { ...c, content: this.redact(botId, c.content) }));
    const o = this.origins(botId);
    const tombs = readJson<{ id: string; content: string; removedAt: number }[]>(this.mem(botId, ".dreaming", "tombstones.json"), []);
    const lines = new Map<string, string[]>();
    const read = (f: string) => { if (!lines.has(f)) lines.set(f, fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n") : []); return lines.get(f)!; };
    const target = (kind: "profile" | "log") => (kind === "profile" ? this.mem(botId, "profile.md") : this.mem(botId, "log", `${this.today().slice(0, 7)}.md`));
    const render = (kind: "profile" | "log", content: string) => `- (${this.today()}) ${kind === "log" ? "[note] " : ""}${content}`;
    const raw = this.raw(botId);
    for (const c of changes) {
      if (c.op === "create") {
        const f = target(c.kind);
        const ls = read(f);
        if (!ls.length && c.kind === "profile") ls.push("# Profile");
        ls.push(render(c.kind, c.content));
        o.byId[factId(c.content)] = "synthesis";
        continue;
      }
      const r = raw.find((x) => x.id === c.id);
      if (!r) continue;
      const ls = read(r.file);
      const idx = ls.findIndex((l) => { const m = LINE.exec(l.trim()); return !!m && factId(m[3]!) === c.id; });
      if (idx < 0) continue;
      if (c.op === "remove") {
        ls.splice(idx, 1);
        tombs.push({ id: c.id, content: r.content, removedAt: this.now() });
      } else if (c.kind === r.kind) {
        ls[idx] = render(c.kind, c.content);
        o.byId[factId(c.content)] = "synthesis";
      } else {
        ls.splice(idx, 1);
        read(target(c.kind)).push(render(c.kind, c.content));
        o.byId[factId(c.content)] = "synthesis";
      }
    }
    for (const [f, ls] of lines) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const text = ls.join("\n").replace(/\n*$/, "\n");
      writeFileAtomic(f, text);
    }
    writeJsonAtomic(this.mem(botId, ".dreaming", "origins.json"), o, 0o640);
    writeJsonAtomic(this.mem(botId, ".dreaming", "tombstones.json"), tombs.slice(-2000), 0o640);
  }

  nextRefreshAt(botId: string): number | null {
    const f = this.mem(botId, ".dreaming", "next-refresh-at");
    return fs.existsSync(f) ? Date.parse(fs.readFileSync(f, "utf8").trim()) || null : null;
  }

  setNextRefreshAt(botId: string, ms: number): void {
    const f = this.mem(botId, ".dreaming", "next-refresh-at");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeFileAtomic(f, new Date(ms).toISOString());
  }
}
