import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { botDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { writeTextAtomic } from "../util/atomic-text";
import { LOG_HEADER, PROFILE_HEADER, dedupeKey, factId, isoDate, monthOf, normalizeFact, parseFacts, renderLine, type Fact, type FactKind, type Tier } from "./facts";
import { ledgerRef, type FactLedger, type Provenance } from "./ledger";

/** agent = private to its Bot; user (about the user) and team (team knowledge) = one shard per writer, read by every Bot; project = its members. */
export type Scope = { kind: "agent"; botId: string } | { kind: "user"; botId: string } | { kind: "team"; botId: string } | { kind: "project"; botId: string; slug: string };
export interface FactMeta { confirmedAt?: number; confirmCount?: number; recalledAt?: number; recallCount?: number }
export interface AddResult { added: boolean; fact: Fact }

/** A write that says nothing about itself: the Bot wrote it from what it gathered. */
const defaultProvenance = (s: Scope): Provenance => ({ botId: s.botId, chatId: null, messageId: null, source: "inferred", confidence: 0.7 });
/** The memory screen's add and "Correct this": the user said it, at the highest confidence. */
export const USER_PROVENANCE: Provenance = { botId: null, chatId: null, messageId: null, source: "user", confidence: 1 };
/** A new fact supersedes a same-key fact only when its confidence is at least this close to the old one's (a web hint never overturns the user). */
const SUPERSEDE_MARGIN = 0.2;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODE = 0o640;

export function scopeLabel(s: Scope): string {
  return s.kind === "agent" ? "your memory" : s.kind === "user" ? "user memory" : s.kind === "team" ? "team memory" : `project "${s.slug}"`;
}

export class MemoryStore {
  private subs = new Set<(s: Scope) => void>();
  /** Bots whose memory was cleared on delete: a job still in flight must not write (and recreate folders) for them. */
  private gone = new Set<string>();
  private now: () => number;
  constructor(private d: { cfg: HostConfig; now?: () => number; ledger?: FactLedger }) {
    this.now = d.now ?? Date.now;
  }

  get ledger(): FactLedger | undefined {
    return this.d.ledger;
  }

  subscribe(cb: (s: Scope) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  private changed(s: Scope): void {
    for (const cb of this.subs) cb(s);
  }

  dir(s: Scope): string {
    if (s.kind === "agent") return path.join(botDir(this.d.cfg, s.botId), "memory");
    if (s.kind === "user") { botDir(this.d.cfg, s.botId); return path.join(this.d.cfg.dataRoot, "user-memory", "agents", s.botId); }
    if (s.kind === "team") { botDir(this.d.cfg, s.botId); return path.join(this.d.cfg.dataRoot, "team-memory", "agents", s.botId); }
    if (!SLUG.test(s.slug)) throw new GatewayError("BAD_PROJECT", `Invalid project name "${s.slug}".`);
    botDir(this.d.cfg, s.botId);
    return path.join(this.d.cfg.dataRoot, "projects", s.slug, "memory", "agents", s.botId);
  }

  profile(s: Scope): Fact[] {
    const f = path.join(this.dir(s), "profile.md");
    return fs.existsSync(f) ? parseFacts(fs.readFileSync(f, "utf8"), "profile") : [];
  }
  /** All log facts, oldest file first, file order within a month. */
  log(s: Scope): Fact[] {
    const dir = path.join(this.dir(s), "log");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).sort()
      .flatMap((n) => parseFacts(fs.readFileSync(path.join(dir, n), "utf8"), "log"));
  }
  all(s: Scope): Fact[] {
    return [...this.profile(s), ...this.log(s)];
  }

  private assertLive(s: Scope): void {
    if (this.gone.has(s.botId)) throw new GatewayError("NO_SUCH_BOT", "No such Bot.");
  }

  /**
   * Writes one fact (or confirms the same one). With the ledger: records its provenance, and a fact whose
   * (subject, predicate) the ledger can read supersedes the current same-key facts of its scope group: their
   * lines leave the markdown (the current view) and their ledger rows are ended, never deleted.
   */
  add(s: Scope, f: { content: string; tier: Tier; kind: FactKind; date?: string }, prov?: Provenance): AddResult {
    this.assertLive(s);
    const content = normalizeFact(f.content);
    if (!content) throw new GatewayError("EMPTY_FACT", "Not saved — the fact is empty.");
    const key = dedupeKey(content);
    const existing = this.all(s).find((x) => dedupeKey(x.content) === key);
    if (existing) {
      this.confirm(s, existing.id);
      this.d.ledger?.record(ledgerRef(s), { factId: existing.id, text: existing.content, date: existing.date }, prov ?? defaultProvenance(s));
      return { added: false, fact: existing };
    }
    const date = f.date ?? isoDate(this.now());
    const fact: Fact = { id: factId(content), date, kind: f.kind, content, tier: f.tier, createdAt: Date.parse(`${date}T00:00:00Z`) };
    this.writeLine(s, fact);
    if (this.d.ledger) this.recordAndSupersede(s, fact, prov ?? defaultProvenance(s));
    this.changed(s);
    return { added: true, fact };
  }

  /**
   * The extractor's `remove: <old>` next to its replacement, and any explicit "this replaces that": the new fact is
   * written and the old one is superseded by it, whether or not the ledger can read either sentence's key.
   */
  supersede(s: Scope, oldContent: string, f: { content: string; tier: Tier; kind: FactKind; date?: string }, prov?: Provenance): AddResult & { replaced: boolean } {
    const target = normalizeFact(oldContent);
    const old = this.all(s).find((x) => x.content === target);
    const r = this.add(s, f, prov);
    if (!old || old.id === r.fact.id) return { ...r, replaced: false };
    if (this.all(s).some((x) => x.id === old.id)) this.removeLine(s, old);
    const ref = ledgerRef(s);
    this.d.ledger?.end(ref.shard, old.id, this.d.ledger.current(ref.shard, r.fact.id)?.id ?? null);
    this.changed(s);
    return { ...r, replaced: true };
  }

  private recordAndSupersede(s: Scope, fact: Fact, prov: Provenance): void {
    const ledger = this.d.ledger!;
    const row = ledger.record(ledgerRef(s), { factId: fact.id, text: fact.content, date: fact.date }, prov);
    if (!row.subject || !row.predicate) return;
    const group = this.group(s);
    const byShard = new Map(group.map((g) => [ledgerRef(g).shard, g]));
    for (const old of ledger.withKey([...byShard.keys()], row.subject, row.predicate)) {
      if (old.id === row.id || row.confidence < old.confidence - SUPERSEDE_MARGIN) continue;
      const os = byShard.get(old.shard)!;
      if (this.gone.has(os.botId)) continue;
      const line = this.all(os).find((x) => x.id === old.factId);
      if (line) this.removeLine(os, line);
      ledger.end(old.shard, old.factId, row.id);
      if (os !== s) this.changed(os);
    }
  }

  /** The shards one fact can supersede in: its own, or every writer's shard of a shared scope. */
  private group(s: Scope): Scope[] {
    if (s.kind === "user") return [s, ...this.userShardOwners().filter((o) => o !== s.botId).map((botId): Scope => ({ kind: "user", botId }))];
    if (s.kind === "team") return [s, ...this.teamShardOwners().filter((o) => o !== s.botId).map((botId): Scope => ({ kind: "team", botId }))];
    if (s.kind === "project") {
      const dir = path.join(this.d.cfg.dataRoot, "projects", s.slug, "memory", "agents");
      const members = fs.existsSync(dir) ? fs.readdirSync(dir).filter((o) => o !== s.botId) : [];
      return [s, ...members.map((botId): Scope => ({ kind: "project", botId, slug: s.slug }))];
    }
    return [s];
  }

  private fileOf(s: Scope, f: { tier: Tier; date: string }): string {
    return f.tier === "profile" ? path.join(this.dir(s), "profile.md") : path.join(this.dir(s), "log", `${monthOf(f.date)}.md`);
  }
  private writeLine(s: Scope, fact: Fact): void {
    const file = this.fileOf(s, fact);
    const header = fact.tier === "profile" ? PROFILE_HEADER : LOG_HEADER;
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : header;
    writeTextAtomic(file, `${prev.endsWith("\n") ? prev : `${prev}\n`}${renderLine(fact)}\n`, MODE);
  }
  /** Markdown only: the line leaves the current view; the ledger is the caller's business. */
  private removeLine(s: Scope, hit: Fact): void {
    const file = this.fileOf(s, hit);
    if (!fs.existsSync(file)) return;
    const kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => {
      const p = parseFacts(line, hit.tier)[0];
      return !(p && p.content === hit.content);
    });
    writeTextAtomic(file, kept.join("\n"), MODE);
  }

  /**
   * MEM-03: forget requires the exact text (after whitespace normalization).
   * mode "forget" (the user, the Bot's forget action): the ledger row and its history are deleted too.
   * mode "retract" (the extractor's unpaired `remove:`): the fact is no longer true; the ledger keeps it as history.
   */
  remove(s: Scope, exact: string, mode: "forget" | "retract" = "forget"): Fact | null {
    const target = normalizeFact(exact);
    const hit = this.all(s).find((x) => x.content === target);
    if (!hit) return null;
    this.removeLine(s, hit);
    const shard = ledgerRef(s).shard;
    if (mode === "forget") this.d.ledger?.forget(shard, hit.id);
    else this.d.ledger?.end(shard, hit.id, null);
    this.changed(s);
    return hit;
  }

  /** The memory screen (MEM-09, designed) acts by id: a hidden (secret-looking) line has no text on the renderer to send back. */
  removeById(s: Scope, id: string): Fact | null {
    const hit = this.all(s).find((x) => x.id === id);
    return hit ? this.remove(s, hit.content) : null;
  }

  /**
   * "Correct this": rewrites one line in place (same file, same date, same kind; only the text changes). An edit onto an
   * existing fact merges into it. In the ledger the correction is a new user-sourced row that supersedes the old one.
   */
  replace(s: Scope, id: string, text: string, prov: Provenance = USER_PROVENANCE): Fact {
    this.assertLive(s);
    const content = normalizeFact(text);
    if (!content) throw new GatewayError("EMPTY_FACT", "Not saved — the fact is empty.");
    const facts = this.all(s);
    const hit = facts.find((x) => x.id === id);
    if (!hit) throw new GatewayError("NO_SUCH_FACT", "That memory isn't there any more. It may have just been changed; reload to see the current list.", 404);
    const nextId = factId(content);
    const ref = ledgerRef(s);
    const dup = nextId !== hit.id ? facts.find((x) => x.id === nextId) : undefined;
    if (dup) {
      this.removeLine(s, hit);
      const into = this.d.ledger?.record(ref, { factId: dup.id, text: dup.content, date: dup.date }, prov);
      this.d.ledger?.end(ref.shard, hit.id, into?.id ?? null);
      this.changed(s);
      return dup;
    }
    const file = this.fileOf(s, hit);
    const lines = fs.readFileSync(file, "utf8").split("\n").map((line) => {
      const p = parseFacts(line, hit.tier)[0];
      return p && p.content === hit.content ? renderLine({ date: hit.date, kind: hit.kind, content }) : line;
    });
    writeTextAtomic(file, lines.join("\n"), MODE);
    if (this.d.ledger && nextId !== hit.id) {
      const row = this.d.ledger.record(ref, { factId: nextId, text: content, date: hit.date }, prov);
      this.d.ledger.end(ref.shard, hit.id, row.id);
    }
    this.changed(s);
    return { ...hit, id: nextId, content };
  }

  /** Empties one scope's files (profile, every log month, reinforcement metadata) and its ledger rows. Returns how many facts went. */
  clear(s: Scope): number {
    const n = this.all(s).length;
    const dir = this.dir(s);
    fs.rmSync(path.join(dir, "profile.md"), { force: true });
    fs.rmSync(path.join(dir, "log"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, ".meta.json"), { force: true });
    this.d.ledger?.clearShard(ledgerRef(s).shard);
    this.changed(s);
    return n;
  }

  meta(s: Scope): Record<string, FactMeta> {
    return readJson<Record<string, FactMeta>>(path.join(this.dir(s), ".meta.json"), {});
  }
  private writeMeta(s: Scope, m: Record<string, FactMeta>): void {
    if (this.gone.has(s.botId)) return; // a stale recall hit on a deleted Bot's fact: nothing to touch
    writeJsonAtomic(path.join(this.dir(s), ".meta.json"), m, MODE);
  }
  private confirm(s: Scope, id: string): void {
    const m = this.meta(s);
    const cur = m[id] ?? {};
    m[id] = { ...cur, confirmedAt: this.now(), confirmCount: (cur.confirmCount ?? 0) + 1 };
    this.writeMeta(s, m);
  }
  touchRecalled(s: Scope, ids: string[]): void {
    if (!ids.length) return;
    const m = this.meta(s);
    for (const id of ids) m[id] = { ...(m[id] ?? {}), recalledAt: this.now(), recallCount: (m[id]?.recallCount ?? 0) + 1 };
    this.writeMeta(s, m);
  }

  // ---- projects (MEM-02) ----
  private projectsFile(botId: string): string {
    return path.join(botDir(this.d.cfg, botId), "projects.json");
  }
  projects(botId: string): string[] {
    return readJson<{ projects: string[] }>(this.projectsFile(botId), { projects: [] }).projects;
  }
  projectExists(slug: string): boolean {
    return SLUG.test(slug) && fs.existsSync(path.join(this.d.cfg.dataRoot, "projects", slug, "project.md"));
  }
  createProject(slug: string, botId: string, description = ""): void {
    if (!SLUG.test(slug)) throw new GatewayError("BAD_PROJECT", `Invalid project name "${slug}". Use lowercase letters, digits and dashes.`);
    const file = path.join(this.d.cfg.dataRoot, "projects", slug, "project.md");
    if (!fs.existsSync(file)) writeTextAtomic(file, `# ${slug}\n${description.trim()}\n`, MODE);
    this.joinProject(botId, slug);
  }
  joinProject(botId: string, slug: string): void {
    if (!this.projectExists(slug)) throw new GatewayError("NO_PROJECT", `project "${slug}" doesn't exist yet; create it or join it before using it`);
    const list = this.projects(botId);
    if (!list.includes(slug)) writeJsonAtomic(this.projectsFile(botId), { projects: [...list, slug] }, MODE);
  }
  leaveProject(botId: string, slug: string): void {
    writeJsonAtomic(this.projectsFile(botId), { projects: this.projects(botId).filter((p) => p !== slug) }, MODE);
  }
  checkProjectScope(botId: string, slug: string): string | null {
    if (!this.projectExists(slug)) return `project "${slug}" doesn't exist yet; create it or join it before using it`;
    if (!this.projects(botId).includes(slug)) return `you're not a member of project "${slug}" yet`;
    return null;
  }

  userShardOwners(): string[] {
    const dir = path.join(this.d.cfg.dataRoot, "user-memory", "agents");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }
  teamShardOwners(): string[] {
    const dir = path.join(this.d.cfg.dataRoot, "team-memory", "agents");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }
  /** BOT-09: a deleted Bot's user, team and project shards go with it (its agent folder is removed by BotService), and so do its ledger rows. */
  clearBot(botId: string): void {
    this.gone.add(botId);
    fs.rmSync(path.join(botDir(this.d.cfg, botId), "memory"), { recursive: true, force: true });
    fs.rmSync(path.join(this.d.cfg.dataRoot, "user-memory", "agents", botId), { recursive: true, force: true });
    fs.rmSync(path.join(this.d.cfg.dataRoot, "team-memory", "agents", botId), { recursive: true, force: true });
    const projects = path.join(this.d.cfg.dataRoot, "projects");
    const slugs = fs.existsSync(projects) ? fs.readdirSync(projects).filter((p) => SLUG.test(p)) : [];
    for (const p of slugs) fs.rmSync(path.join(projects, p, "memory", "agents", botId), { recursive: true, force: true });
    this.d.ledger?.clearOwner(botId);
    for (const slug of slugs) this.changed({ kind: "project", botId, slug });
    this.changed({ kind: "agent", botId });
    this.changed({ kind: "user", botId });
    this.changed({ kind: "team", botId });
  }
}
