import { PromptCache, weighted, type Input, type Seg } from "./cache";
import { EPISODE_PENDING_MAX, MEM_IDLE_FLUSH_MS, type Policy } from "./params";
import type { Conversation, ToolCall } from "./workload";

/**
 * The replay engine: one conversation through one policy, no model calls. Per user message it
 * builds each model call's prompt as content blocks, runs them through the prompt-cache model, and
 * adds the calls the message causes: memory extraction / episodes / dreaming, and a compaction when
 * the policy's trigger fires.
 *
 * Prompt layout (both products): [tools][system base][frozen memory @epoch][system rest][history…].
 * History holds, per message, the user block (text + per-message envelope, recall, restore) then one
 * block per tool_use and one per tool_result. A compaction replaces history with a summary (plus a
 * kept tail on the hosted agent) and bumps the epoch, which re-renders the memory block — so the cache
 * breaks right after the system base.
 *
 * cost-diet-2 switches (absent on every older policy, which replays exactly as before):
 *   route         a simple message (no tool calls) runs on a cheaper model with its OWN prompt cache
 *                 (caches are model-scoped), its own prefix and token count; its tokens are priced by
 *                 `priceRatio` in `weighted`, and a share escalates (the cheap attempt is paid, then
 *                 the whole message reruns on the main model).
 *   endTurnOnSend a final SendMessage ends the turn: no closing call.
 *   deferredTool  a work message that needs a deferred tool pays one ToolSearch call first.
 *   batch         memory extraction every N memorable exchanges, flushed at idle, compaction and the end.
 *   atCompaction  episodes written at compaction (or when the pending list is full).
 */
export interface Usage extends Input { output: number }
export interface MessageResult {
  i: number; session: number; t: number;
  /** Chat model calls for this message (tool calls + the closing call + an archive search), on either model. */
  calls: number;
  /** The chat calls only: what one usage.db `runs` row records for a user turn. */
  chat: Usage;
  /** Everything this message costs on the main model: chat + main-model memory calls + a compaction. */
  main: Usage;
  /** The routed (cheaper) model's chat calls, in ITS tokens: priced by the route's priceRatio in `weighted`. */
  simple: Usage;
  routed: boolean;
  escalated: boolean;
  /** Cost-weighted input in main-model units (the cheap model's share scaled by its price). */
  weighted: number;
  /** Output in main-model price units. */
  outEq: number;
  firstCallRead: number;
  mainHelperCalls: number;
  /** Calls on a helper model (Haiku 4.5, gemini-2.5-flash): own column, never blended. */
  helper: { calls: number; input: number; output: number };
  compacted: boolean;
  /** Cache read of the first chat call after this message's compaction. */
  postCompactRead: number | null;
  /** Largest context (prompt + output) of this message's chat calls. */
  ctx: number;
}
export interface SimResult { policy: string; ttlMs: number; messages: MessageResult[]; compactions: number; extracted: number }

const zero = (): Usage => ({ fresh: 0, write: 0, read: 0, output: 0 });
const add = (a: Usage, b: Input, output = 0) => { a.fresh += b.fresh; a.write += b.write; a.read += b.read; a.output += output; };
const sum = (segs: Seg[]) => segs.reduce((a, s) => a + s.tokens, 0);
/** Model latency between calls [inferred]; Synapse compacts after idleCompactAfterMs 30 s (LIM) [documented]. */
const CALL_MS = 4_000, IDLE_COMPACT_MS = 30_000;
/** A seeded uniform per message and purpose, so a policy's own events never shift the workload's draws. */
function draw(i: number, salt: number): number {
  let x = Math.imul(i + 1, 2654435761) ^ Math.imul(salt + 7, 40503);
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function simulate(conv: Conversation, p: Policy): SimResult {
  const { mode, ttlMs } = p.cache;
  const chatCache = new PromptCache(mode, ttlMs), simpleCache = new PromptCache(mode, ttlMs);
  const xCache = new PromptCache(mode, ttlMs), eCache = new PromptCache(mode, ttlMs), dCache = new PromptCache(mode, ttlMs);
  const mem = { profile: 0, log: 0 };
  const renderMem = () => p.memory.headerTokens + Math.min(Math.floor(mem.profile), p.memory.profileMax) * p.memory.factTokens
    + Math.min(Math.min(Math.floor(mem.log), p.memory.recentMax) * p.memory.factTokens, p.memory.recentTokens);
  let epoch = 0, frozenMem = renderMem(), compactions = 0, turnsSince = 0, restorePending = false, extracted = 0;
  let history: Seg[] = [], msgStarts: number[] = [];
  let pendingEpisode: number[] = [];
  let pendingX: number[] = [];
  let lastMainAt = -Infinity, onSimple = false, lastEnd = -Infinity;
  let awaitingPost = null as MessageResult | null; // set inside compact(); `as` keeps TS from narrowing it to null
  const limit = Math.min(p.window * p.compactAtRatio, p.historyCap === null ? Infinity : p.historyCap + fixed());
  const batch = Math.max(1, p.extraction.batch ?? 1);
  function fixed() { return p.prefix.tools + p.prefix.systemBase + p.prefix.systemRest; }
  const prefix = (): Seg[] => [
    { id: "tools", tokens: p.prefix.tools }, { id: "sys", tokens: p.prefix.systemBase },
    { id: `mem@${epoch}`, tokens: frozenMem }, { id: "sysRest", tokens: p.prefix.systemRest },
  ];
  const simplePrompt = (): Seg[] => {
    const r = p.route!, k = r.tokenRatio;
    return [{ id: "s-tools", tokens: r.prefix.tools }, { id: "s-sys", tokens: r.prefix.system }, { id: `mem@${epoch}`, tokens: Math.round(frozenMem * k) },
      ...history.map((s) => ({ id: s.id, tokens: Math.round(s.tokens * k) }))];
  };

  function compact(r: MessageResult, t: number, keepFrom: number) {
    flushExtraction(r, t);
    if (p.episodes.atCompaction) flushEpisode(r, t);
    const req: Seg = { id: `sumreq@${epoch}`, tokens: p.summary.requestTokens };
    add(r.main, chatCache.call([...prefix(), ...history, req], t), p.summary.outputTokens);
    lastMainAt = t;
    const tail = history.slice(keepFrom);
    const offset = keepFrom;
    epoch++; compactions++; turnsSince = 0;
    frozenMem = renderMem();
    history = [{ id: `sum@${epoch}`, tokens: p.summary.outputTokens }, ...tail];
    msgStarts = msgStarts.filter((s) => s >= offset).map((s) => s - offset + 1);
    restorePending = p.restoreTokens > 0;
    r.compacted = true;
    awaitingPost = r;
  }
  const tailStart = () => (p.summary.tailMessages > 0 && msgStarts.length ? msgStarts[Math.max(0, msgStarts.length - p.summary.tailMessages)]! : history.length);

  function helperCall(r: MessageResult, model: "main" | "helper", cache: PromptCache, prompt: Seg[], output: number, t: number) {
    const u = cache.call(prompt, t);
    if (model === "main") { add(r.main, u, output); r.mainHelperCalls++; }
    else { r.helper.calls++; r.helper.input += u.fresh + u.write + u.read; r.helper.output += output; }
  }
  const liveFacts = () => renderMem() + Math.min(p.extraction.relatedFacts, Math.floor(mem.profile + mem.log)) * p.memory.factTokens;
  function flushExtraction(r: MessageResult, t: number) {
    if (!pendingX.length) return;
    helperCall(r, p.extraction.model, xCache, [
      { id: "xsys", tokens: p.extraction.systemTokens }, { id: `xmem@${Math.floor(mem.profile + mem.log)}`, tokens: liveFacts() }, { id: `xex${r.i}.${extracted}`, tokens: pendingX.reduce((a, b) => a + b, 0) },
    ], p.extraction.outputTokens * pendingX.length, t);
    for (let k = 0; k < pendingX.length; k++) addFacts();
    extracted += pendingX.length;
    pendingX = [];
  }
  function flushEpisode(r: MessageResult, t: number) {
    if (!pendingEpisode.length) return;
    helperCall(r, p.episodes.model, eCache, [{ id: "esys", tokens: p.episodes.systemTokens }, { id: `ep${r.i}.${compactions}`, tokens: pendingEpisode.reduce((a, b) => a + b, 0) }], p.episodes.outputTokens, t);
    pendingEpisode = [];
    mem.log += 1;
  }

  const messages: MessageResult[] = [];
  for (const m of conv.messages) {
    const r: MessageResult = {
      i: m.i, session: m.session, t: m.t, calls: 0, chat: zero(), main: zero(), simple: zero(), routed: false, escalated: false, weighted: 0, outEq: 0, firstCallRead: 0,
      mainHelperCalls: 0, helper: { calls: 0, input: 0, output: 0 }, compacted: false, postCompactRead: null, ctx: 0,
    };
    if (pendingX.length && m.t - lastEnd > MEM_IDLE_FLUSH_MS) flushExtraction(r, lastEnd + MEM_IDLE_FLUSH_MS);
    const tools: ToolCall[] = [...m.tools];
    if (p.archiveSearch && compactions > 0 && m.archiveDraw < p.archiveSearch.fireRate) {
      tools.unshift({ kind: "work", name: "archive_search", argTokens: p.archiveSearch.argTokens, resultTokens: p.archiveSearch.hitsTokens, durationMs: 500 });
    }
    if (p.deferredTool && m.tools.some((c) => c.kind === "work") && draw(m.i, 2) < p.deferredTool.fireRate) {
      tools.unshift({ kind: "work", name: "ToolSearch", argTokens: p.deferredTool.argTokens, resultTokens: p.deferredTool.schemaTokens, durationMs: 300 });
    }
    let userTokens = m.userTokens + p.perMessageOverhead;
    if (p.recall && m.recallDraw < p.recall.fireRate) userTokens += p.recall.tokens;
    if (restorePending) { userTokens += p.restoreTokens; restorePending = false; }
    msgStarts.push(history.length);
    history.push({ id: `u${m.i}`, tokens: userTokens });
    turnsSince++;

    // ---- lever 1: which model runs this message ----
    const isSimple = m.tools.every((c) => c.kind === "reply");
    if (p.route && isSimple) {
      const cold = m.t - lastMainAt > ttlMs;
      const want: boolean = p.route.mode === "always" || cold || onSimple;
      r.routed = want && fixed() + frozenMem + sum(history) <= p.route.maxContext;
      r.escalated = r.routed && draw(m.i, 1) < p.route.escalateRate;
    }
    onSimple = r.routed && !r.escalated;

    let t = m.t;
    const tr = p.route?.tokenRatio ?? 1;
    if (r.escalated) {
      // The cheap attempt: one call, then the message reruns on the main model (its output is discarded).
      const u = simpleCache.call(simplePrompt(), t);
      add(r.simple, u, Math.round(20 * tr));
      r.calls++;
      t += CALL_MS;
    }
    const cheap = r.routed && !r.escalated;
    const last = p.endTurnOnSend && tools.at(-1)?.kind === "reply" ? tools.length - 1 : tools.length;
    for (let j = 0; j <= last; j++) {
      const call = tools[j];
      const output = call ? call.argTokens : p.endTurnTokens;
      const prompt = [...prefix(), ...history];
      const ctx = sum(prompt) + output;
      if (cheap) {
        const u = simpleCache.call(simplePrompt(), t);
        add(r.simple, u, Math.round(output * tr));
        if (j === 0) r.firstCallRead = u.read;
      } else {
        const u = chatCache.call(prompt, t);
        add(r.chat, u, output); add(r.main, u, output);
        lastMainAt = t;
        if (j === 0) r.firstCallRead = u.read;
        if (awaitingPost) { awaitingPost.postCompactRead = u.read; awaitingPost = null; }
      }
      r.calls++;
      r.ctx = Math.max(r.ctx, ctx);
      t += CALL_MS;
      if (call) {
        history.push({ id: `a${m.i}.${j}`, tokens: call.argTokens }, { id: `r${m.i}.${j}`, tokens: call.resultTokens });
        t += call.durationMs;
      }
      if (p.compactCheck === "step" && (ctx + (call?.resultTokens ?? 0) >= limit || turnsSince >= p.compactEveryTurns)) {
        compact(r, t, tailStart());
      }
    }

    // ---- memory: extraction + episodes, or dreaming ----
    const agentText = m.tools.filter((c) => c.kind === "reply").reduce((a, c) => a + c.argTokens - 25, 0);
    const exchange = m.userTokens + agentText;
    if (p.dreaming) {
      // Evidence recording skips the memorable-exchange check [assumed]: every visible turn.
      const ev = Math.min(exchange, p.dreaming.evidenceMaxTokens);
      helperCall(r, "helper", dCache, [{ id: "dsys", tokens: p.dreaming.synthesisSystem }, { id: `dmem@${Math.floor(mem.profile + mem.log)}`, tokens: liveFacts() }, { id: `ev${m.i}`, tokens: ev }], p.dreaming.outputTokens, t);
      helperCall(r, "helper", new PromptCache(mode, ttlMs), [{ id: "vsys", tokens: p.dreaming.verifySystem }, { id: `vch${m.i}`, tokens: p.dreaming.outputTokens + liveFacts() }], 50, t);
      if (m.memorable) addFacts();
    } else if (m.memorable) {
      pendingX.push(exchange);
      if (pendingX.length >= batch) flushExtraction(r, t);
      const side = p.episodes.sideMaxTokens;
      pendingEpisode.push(Math.min(m.userTokens, side) + Math.min(agentText, side));
      if (p.episodes.atCompaction ? pendingEpisode.length >= EPISODE_PENDING_MAX : pendingEpisode.length >= p.episodes.every) flushEpisode(r, t);
    }

    if (p.compactCheck === "idle" && (sum(history) + fixed() + frozenMem >= limit || turnsSince >= p.compactEveryTurns)) {
      compact(r, t + IDLE_COMPACT_MS, history.length);
    }
    lastEnd = t;
    messages.push(r);
  }
  const tail = messages.at(-1);
  if (tail) {
    flushExtraction(tail, lastEnd + MEM_IDLE_FLUSH_MS);
    if (p.episodes.atCompaction) flushEpisode(tail, lastEnd + MEM_IDLE_FLUSH_MS);
  }
  const price = p.route?.priceRatio ?? 1;
  for (const r of messages) {
    r.weighted = weighted(r.main, ttlMs) + price * weighted(r.simple, ttlMs);
    r.outEq = r.main.output + price * r.simple.output;
  }
  return { policy: p.name, ttlMs, messages, compactions, extracted };

  function addFacts() {
    mem.profile += p.memory.factsPerMemorable * p.memory.profileShare;
    mem.log += p.memory.factsPerMemorable * (1 - p.memory.profileShare);
  }
}
