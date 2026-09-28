import { LIMITS5 } from "@synapse/shared";
import { factId, type DreamChange, type MemoryFact } from "./port";

type Ctx = { facts: MemoryFact[]; evidenceIds: string[]; mode: "evidence" | "temporal"; tombstones: Set<string>; expiryCandidates: string[] };

export function validateChanges(raw: unknown, c: Ctx): { ok: true; changes: DreamChange[]; dropped: string[] } | { ok: false; reason: string } {
  const list = (raw as { changes?: unknown })?.changes;
  if (!Array.isArray(list)) return { ok: false, reason: "missing changes array" };
  if (list.length > LIMITS5.dreamMaxChanges) return { ok: false, reason: "more than 64 changes" };
  const byId = new Map(c.facts.map((f) => [f.id, f]));
  const touched = new Set<string>();
  for (const x of list as { id?: unknown }[]) {
    if (typeof x?.id !== "string") continue;
    if (touched.has(x.id)) return { ok: false, reason: "two changes touch the same fact" };
    touched.add(x.id);
  }
  const valid = new Set([...c.evidenceIds, ...(c.mode === "temporal" ? ["clock"] : [])]);
  const out: DreamChange[] = [];
  const dropped: string[] = [];
  const drop = (why: string) => void dropped.push(why);
  for (const x of list as Record<string, unknown>[]) {
    const ids = Array.isArray(x.sourceEvidenceIds) ? (x.sourceEvidenceIds as unknown[]).map(String) : [];
    if (!ids.length || ids.some((i) => !valid.has(i))) { drop("uncited or unknown evidence"); continue; }
    const real = ids.filter((i) => i !== "clock");
    const content = typeof x.content === "string" ? x.content.trim() : "";
    const kind = x.kind === "profile" || x.kind === "log" ? x.kind : null;
    if (x.op === "create") {
      if (!content || content.length > LIMITS5.dreamContentMax || !kind) { drop("bad create"); continue; }
      if (!real.length) { drop("create without evidence"); continue; }
      const key = factId(content);
      if (c.tombstones.has(key) || byId.has(key) || out.some((o) => o.op === "create" && factId(o.content) === key)) { drop("tombstoned or duplicate create"); continue; }
      out.push({ op: "create", content, kind, sourceEvidenceIds: ids });
      continue;
    }
    const target = typeof x.id === "string" ? byId.get(x.id) : undefined;
    if (!target) { drop("unknown fact"); continue; }
    if (target.origin === "explicit") { drop("explicit fact"); continue; }
    if (x.op === "remove") {
      if (!real.length && (target.kind === "profile" || !c.expiryCandidates.includes(target.id))) { drop("clock can't remove this"); continue; }
      out.push({ op: "remove", id: target.id, sourceEvidenceIds: ids });
      continue;
    }
    if (x.op === "update") {
      if (!content || content.length > LIMITS5.dreamContentMax || !kind) { drop("bad update"); continue; }
      const dup = byId.get(factId(content));
      if (dup && dup.id !== target.id) { out.push({ op: "remove", id: target.id, sourceEvidenceIds: ids }); continue; }
      out.push({ op: "update", id: target.id, content, kind, sourceEvidenceIds: ids });
      continue;
    }
    drop("unknown op");
  }
  return { ok: true, changes: out, dropped };
}
