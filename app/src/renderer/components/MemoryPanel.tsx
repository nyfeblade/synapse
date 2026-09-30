import { useState } from "react";
import { STRM, type MemoryFactView, type MemoryScopeRef, type MemoryTierChoice } from "@synapse/shared";
import { useAsync, useKeyedState } from "../async-resource";
import { callQuiet } from "../bridge";
import { messageOf } from "../error-channel";
import { useUi } from "../store";
import { Async } from "./Async";

import { PanelTabs } from "./PanelTabs";

/**
 * MEM-09: a viewer for a Bot's memory, so it stops being state the user can neither see nor act on (the recurring bug class, docs/HANDOFF.md). Every write goes through the host, so the
 * markdown files stay the source of truth. Reads and writes use `callQuiet` because every failure
 * is shown in place, in the list it belongs to, with Retry (bug 37's shape).
 */

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isNaN(t) ? d : DATE.format(t); };
const scopeKey = (s: MemoryScopeRef) => (s.kind === "project" ? `project:${s.slug}` : s.kind);
const newestFirst = (a: MemoryFactView, b: MemoryFactView) => b.date.localeCompare(a.date);

export function MemoryPanel({ botId }: { botId: string }) {
  const name = useUi((s) => s.bots[botId]?.profile.name ?? "");
  const projects = useAsync(() => callQuiet("getAgentMemories", { id: botId }), [botId]);
  return (
    <aside aria-label="Conversation details" className="panel wide" data-memory={botId}>
      <PanelTabs current="memory" />
      <RefreshNote botId={botId} name={name} />
      <MemoryList botId={botId} scope={{ kind: "agent" }} title={STRM.scopeAgent} />
      <MemoryList botId={botId} scope={{ kind: "user" }} title={STRM.scopeUser} />
      <MemoryList botId={botId} scope={{ kind: "team" }} title={STRM.scopeTeam} />
      <section aria-label={STRM.projects} className="memory-scope">
        <h3 className="panel-subtitle">{STRM.projects}</h3>
        <Async resource={projects} label={STRM.projects}>
          {(v) => (v.projects.length === 0
            ? <div className="muted">{STRM.noProjects}</div>
            : v.projects.map((slug) => <MemoryList key={slug} botId={botId} scope={{ kind: "project", slug }} title={STRM.project(slug)} />))}
        </Async>
      </section>
    </aside>
  );
}

/**
 * MEM-05: the Bot's memory section is frozen per compaction epoch, so an edit here is on disk at once
 * but not in the Bot's system prompt until the epoch changes. The host has no safe way to re-render
 * mid-epoch — the frozen text is the prompt-cache prefix and the CLI replays its recorded prompt — so
 * "Refresh now" is the one mechanism that bumps the epoch: compacting the conversation.
 */
function RefreshNote({ botId, name }: { botId: string; name: string }) {
  const [state, setState] = useKeyedState<"idle" | "busy" | "scheduled" | "unavailable">(botId, "idle");
  const [error, setError] = useKeyedState<string | null>(botId, null);
  const refresh = () => {
    setError(null);
    setState("busy");
    callQuiet("compactAgentNow", { id: botId }).then(
      (r) => setState(r.scheduled ? "scheduled" : "unavailable"),
      (e: unknown) => { setState("idle"); setError(messageOf(e)); },
    );
  };
  return (
    <section className="settings-card memory-refresh">
      <p className="memory-refresh-note">{STRM.freezeNote(name)}</p>
      <div className="settings-row memory-refresh-row">
        <button type="button" className="btn-outline" disabled={state === "busy"} onClick={refresh}>{STRM.refreshNow}</button>
      </div>
      {state === "scheduled" && <div className="status-box" role="status">{STRM.refreshScheduled}</div>}
      {state === "unavailable" && <div className="status-box" role="status">{STRM.refreshUnavailable}</div>}
      {error && <div className="error small" role="alert">{error}</div>}
    </section>
  );
}

function MemoryList({ botId, scope, title, hint }: { botId: string; scope: MemoryScopeRef; title: string; hint?: string }) {
  const key = `${botId}|${scopeKey(scope)}`;
  // Keyed by a string: a fresh `scope` object each render would refetch forever.
  const list = useAsync(() => callQuiet("getAgentMemories", { id: botId, scope }), [key]);
  const [editing, setEditing] = useKeyedState<string | null>(key, null);
  const [draft, setDraft] = useKeyedState(key, "");
  const [text, setText] = useKeyedState(key, "");
  const [tier, setTier] = useKeyedState<MemoryTierChoice>(key, "profile");
  const [confirming, setConfirming] = useKeyedState(key, false);
  const [error, setError] = useKeyedState<string | null>(key, null);
  const [busy, setBusy] = useState(false);

  const run = async (p: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      await p();
      after?.();
      list.reload();
    } catch (e) {
      setError(messageOf(e)); // what was typed stays, so the user can fix it
    } finally {
      setBusy(false);
    }
  };
  const ownerArg = (f: MemoryFactView) => (f.owner ? { owner: f.owner } : {});
  const save = (f: MemoryFactView) => void run(() => callQuiet("updateAgentMemory", { id: botId, scope, factId: f.id, ...ownerArg(f), content: draft }), () => setEditing(null));
  const remove = (f: MemoryFactView) => void run(() => callQuiet("deleteAgentMemory", { id: botId, scope, factId: f.id, ...ownerArg(f) }));
  const add = () => { if (text.trim()) void run(() => callQuiet("addAgentMemory", { id: botId, scope, content: text, tier }), () => setText("")); };
  const clear = () => void run(() => callQuiet("clearAgentMemories", { id: botId, scope }), () => setConfirming(false));
  const hasFacts = list.status === "ready" && list.value.facts.length > 0;

  const row = (f: MemoryFactView) => (
    <li key={`${f.owner ?? ""}:${f.id}`} className="memory-fact">
      {editing === f.id && f.content !== null ? (
        <div className="memory-edit">
          <textarea aria-label={STRM.editLabel} className="field-input" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{STRM.cancel}</button>
            <button type="button" className="btn-primary" disabled={busy || !draft.trim()} onClick={() => save(f)}>{STRM.save}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="memory-fact-text">
            {f.content === null ? <span className="muted">{STRM.hiddenSecret}</span> : <span>{f.content}</span>}
            <MemoryProvenance f={f} />
          </div>
          <span className="memory-fact-actions">
            {/* A hidden line has no text here to edit; it can only go. */}
            {f.content !== null && <button type="button" className="btn-outline small" disabled={busy} onClick={() => { setError(null); setDraft(f.content ?? ""); setEditing(f.id); }}>{STRM.edit}</button>}
            <button type="button" className="btn-outline small" disabled={busy} onClick={() => remove(f)}>{STRM.delete}</button>
          </span>
        </>
      )}
    </li>
  );

  const groups = (facts: MemoryFactView[]) => [
    { name: STRM.tierProfile, hint: STRM.tierProfileHint, facts: facts.filter((f) => f.tier === "profile") },
    { name: STRM.tierLog, hint: STRM.tierLogHint, facts: facts.filter((f) => f.tier === "log" && f.kind !== "note").sort(newestFirst) },
    { name: STRM.tierNote, hint: STRM.tierNoteHint, facts: facts.filter((f) => f.tier === "log" && f.kind === "note").sort(newestFirst) },
  ].filter((g) => g.facts.length > 0);

  return (
    <section aria-label={title} className="memory-scope">
      <div className="memory-scope-head">
        <h3 className="panel-subtitle">{title}</h3>
        {hasFacts && !confirming && <button type="button" className="danger-btn" onClick={() => { setError(null); setConfirming(true); }}>{STRM.clear}</button>}
      </div>
      {hint && <p className="muted small">{hint}</p>}
      {confirming && (
        <div className="memory-confirm">
          <span>{scope.kind === "user" ? STRM.clearAskUser : scope.kind === "team" ? STRM.clearAskTeam : STRM.clearAsk(title)}</span>
          <div className="row-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>{STRM.cancel}</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={clear}>{STRM.clearConfirm}</button>
          </div>
        </div>
      )}
      <Async resource={list} label={title}>
        {(v) => (v.facts.length === 0
          ? <div className="muted">{STRM.empty}</div>
          : groups(v.facts).map((g) => (
            <div key={g.name} role="group" aria-label={g.name} className="memory-tier">
              <div className="memory-tier-head"><span>{g.name}</span><span className="muted small">{g.hint}</span></div>
              <ul className="memory-facts">{g.facts.map(row)}</ul>
            </div>
          )))}
      </Async>
      <div className="memory-add">
        <input type="text" className="field-input" aria-label={STRM.addLabel(title)} placeholder={STRM.rememberPlaceholder} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <select aria-label={STRM.tierLabel} className="field-input memory-tier-select" value={tier} onChange={(e) => setTier(e.target.value as MemoryTierChoice)}>
          <option value="profile">{STRM.tierProfile}</option>
          <option value="log">{STRM.tierLog}</option>
          <option value="note">{STRM.tierNote}</option>
        </select>
        <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={add}>{STRM.add}</button>
      </div>
      {error && <div className="error small" role="alert">{error}</div>}
    </section>
  );
}

const msDate = (ms: number) => DATE.format(ms);

/**
 * Memory provenance: "learned from <Bot> · <date> · <source>", the chat message it came from (opens the chat there),
 * and, when it changed, what it used to be and when. A line the host's ledger hasn't seen yet keeps the old date / via.
 */
export function MemoryProvenance({ f }: { f: MemoryFactView }) {
  const jumpTo = useUi((s) => s.jumpTo);
  const p = f.provenance;
  const corrected = p && p.botId === null && p.source === "user" && (f.history?.length ?? 0) > 0;
  const who = p ? (p.botName ? STRM.learnedFrom(p.botName) : STRM.learnedFromYou) : f.ownerName ? STRM.via(f.ownerName) : null;
  return (
    <>
      <span className="memory-fact-meta muted small">
        {who && <span>{who}</span>}
        <time dateTime={f.date}>{p ? msDate(p.recordedAt) : fmtDate(f.date)}</time>
        {p && <span>{corrected ? STRM.sourceCorrected : STRM.source[p.source]}</span>}
        {p?.messageId && p.chatBotId && (
          <button type="button" className="link-btn small" aria-label={STRM.openSourceLabel(p.botName ?? "")} onClick={() => void jumpTo(p.chatBotId!, p.messageId!)}>{STRM.openSource}</button>
        )}
      </span>
      {f.history && f.history.length > 0 && (
        <details className="memory-history">
          <summary className="muted small">{STRM.history(f.history.length)}</summary>
          <ul>
            {f.history.map((h, i) => (
              <li key={i} className="muted small">
                <span>{h.content ?? STRM.hiddenSecret}</span>
                <span> · {STRM.historyLine(msDate(h.validFrom), h.validTo ? msDate(h.validTo) : "")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** The entry in Bot settings. A plain button: opening the screen makes no call until it renders. */
export function MemoryEntry({ onOpen }: { onOpen(): void }) {
  return (
    <div className="settings-card">
      <div className="settings-row" data-setting="memory">
        <span className="grow memory-entry-text"><span>{STRM.memory}</span></span>
        <button type="button" className="btn-outline" aria-label={STRM.openMemoryLabel} onClick={onOpen}>{STRM.openMemory}</button>
      </div>
    </div>
  );
}
