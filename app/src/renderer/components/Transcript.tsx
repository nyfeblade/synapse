import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { STR, STR5, STRG, type TranscriptEntry } from "@synapse/shared";
import { BotMarkdown, StreamMarkdown } from "./BotMarkdown";
import { newFlag, useIsNew } from "../is-new";
import { flipFrom, useFlip } from "../flip";
import { MSG_USER_ENTER_MS, prefersReducedMotion, scrollBehavior } from "../motion";
import { isPendingId, pendingEntries, unreconciled, usePendingSends, type PendingSend } from "../pending-sends";
import { glideScroll, isGliding, stopGlide } from "../scroll-glide";
import { useUi } from "../store";
import { useCall } from "../voice/call-store";
import { buildTranscriptItems, formatClock, type TranscriptItem } from "../transcript-items";
import { shareItems } from "../transcript-share";
import { typingIndicator } from "../typing-indicator";
import { clockTime, docHeads, typingNeedsHead } from "../doc-heads";
import { BotAvatar } from "../avatar/BotAvatar";
import type { BotSummary } from "@synapse/shared";
import { ChevronDownIcon } from "./Icons";
import { EmptyView } from "./EmptyView";
import { ActivityGroup } from "./ActivityGroup";
import { ApprovalCard } from "./ApprovalCard";
import { BoxHelpCard } from "./BoxHelpCard";
import { FormCard } from "./FormCard";
import { SecretCard } from "./SecretCard";
import { CardView as LegacyCardView } from "./Cards";
import { CardView } from "./cards/registry";
import { ConnectListenerCard } from "./ConnectListenerCard";
import { EventRow } from "./EventRow";
import { ExchangeBlock } from "./ExchangeBlock";
import { FileCard } from "./FileCard";
import { MessageActions } from "./MessageActions";
import { RateButtons } from "../feedback/Ratings";
import { Reactions } from "./Reactions";
import { ReplyHeader } from "./ReplyHeader";
import { ShapeAvatar } from "./ShapeAvatar";
import { ThreadPanel } from "./ThreadPanel";
import { UserAttachment } from "./UserAttachment";
import { WidgetCard } from "./WidgetCard";
import { CallSummaryNote, VoicemailNote } from "../voice/CallNotes";

const EMPTY_ENTRIES: never[] = [];
const NO_PENDING: PendingSend[] = [];

/** Within this many pixels of the bottom counts as "following the conversation". */
const NEAR_BOTTOM_PX = 80;
/** Bug 442: a long chat renders only its last this-many items; scrolling near the top renders this many more. */
export const TRANSCRIPT_WINDOW = 60;
/** How long a jumped-to message keeps its selection outline. */
const HIGHLIGHT_MS = 2400;

const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

export function Transcript({ botId, onScrolledChange }: { botId: string; onScrolledChange?: (scrolled: boolean) => void }) {
  const entries = useUi((s) => s.transcripts[botId] ?? EMPTY_ENTRIES);
  // UI polish pass: the loading/empty mutex. `undefined` is "not loaded yet", `[]` is "loaded, and empty".
  const loaded = useUi((s) => s.transcripts[botId] !== undefined);
  const typing = useUi((s) => s.typing[botId]);
  const bots = useUi((s) => s.bots);
  const interrupted = useCall((s) => s.interrupted);
  const highlight = useUi((s) => s.highlightEntryId);
  const highlightSeq = useUi((s) => s.highlightSeq);
  // OPTIMISTIC SENDS (pending-sends.ts): a message the composer just sent is shown at once, as a
  // synthetic entry at the foot, until the host's entry with the same clientNonce lands and takes its
  // place in the SAME render (the filter below), on the same DOM node (the row is keyed by nonce).
  const pending = usePendingSends((s) => s.byBot[botId] ?? NO_PENDING);
  const waiting = useMemo(() => unreconciled(pending, entries), [pending, entries]);
  // Bug 442: unchanged items keep their object from the last pass, so their memoised rows skip re-rendering.
  const shared = useRef<{ botId: string; map: Map<string, TranscriptItem> }>({ botId, map: new Map() });
  if (shared.current.botId !== botId) shared.current = { botId, map: new Map() };
  const items = useMemo(() => shareItems(shared.current.map, buildTranscriptItems(waiting.length ? [...entries, ...waiting.flatMap(pendingEntries)] : entries, Date.now())), [entries, waiting]);
  const heads = useMemo(() => docHeads(items), [items]);
  const self = bots[botId];
  useEffect(() => {
    if (waiting.length === pending.length) return;
    const done = pending.filter((p) => !waiting.includes(p)).map((p) => p.nonce);
    usePendingSends.getState().drop(botId, done);
  }, [botId, pending, waiting]);
  const indicator = typingIndicator(bots[botId]?.presence, typing, items);
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [unseen, setUnseen] = useState(false);
  // ---- Auto-scroll (decisions.md, "liquid motion"). Stick to the bottom while the user is at it;
  // never yank a reader (partialText is republished once per streamed chunk, so following
  // unconditionally made reading history impossible for as long as a Bot was answering); and tell a
  // reader when something arrives below them.
  //
  // "Was the user at the bottom?" has to be asked of the geometry BEFORE this commit. Asked after it,
  // as this effect used to, a message taller than the threshold arriving while the user sat at the
  // bottom measured as "far from the bottom" and the transcript silently stopped following. Render is
  // the last moment the old DOM is on screen, so that is where it is read.
  //
  // A glide already under way counts as near, even if `scrollTop` has not caught up yet: two sends in
  // quick succession start a glide whose target keeps moving (scroll-glide.ts), so mid-flight the raw
  // gap can sit well past NEAR_BOTTOM_PX. Reading only the raw gap here turned off the FLIP below for
  // exactly that window, so a reply that landed for an earlier message while a later send was still
  // pending shoved the pending bubble down with no compensating glide — an instant jump (motion check
  // "send", send-jump). The glide is already carrying the scroll there; this just keeps the reflow
  // covered for the ride.
  //
  // Bug 442: that question used to be a scroll-geometry read in render, which forced a layout of the whole
  // transcript on every commit (the top self-time in a 100-turn chat's reply). An IntersectionObserver on the
  // bottom sentinel answers it instead, computed by the browser after its own layout: `near` always holds the
  // geometry as of the last frame, which is exactly "before this commit". Without IntersectionObserver (jsdom)
  // the read stays.
  const wasNear = useRef(true);
  const near = useRef<boolean | null>(null);
  wasNear.current = !box.current || (near.current ?? gapOf(box.current) <= NEAR_BOTTOM_PX) || isGliding(box.current);

  // ---- The render window (bug 442). A column-flex scroller lays out every row on every layout, and a reply forces
  // several (the scroll-to-end read, the FLIP measure), so a 100-turn chat's reply cost grew with its length. Only
  // the last TRANSCRIPT_WINDOW items are rendered; a sentinel above them, seen within a screen of the top, renders
  // TRANSCRIPT_WINDOW more, and the scroll position is carried over so the reader stays where they were (native scroll
  // anchoring does nothing at scrollTop 0). A jump to an older message widens the window to include it. Without
  // IntersectionObserver (jsdom) everything renders.
  const top = useRef<HTMLDivElement>(null);
  const windowFor = useRef<string | null>(null);
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);
  /** The last start rendered; -1 for a chat just opened. */
  const lastStart = useRef(-1);
  const grownFrom = useRef<{ h: number; top: number } | null>(null);
  if (windowFor.current !== botId) {
    windowFor.current = botId;
    lastStart.current = -1;
    grownFrom.current = null;
    if (windowSize !== TRANSCRIPT_WINDOW) setWindowSize(TRANSCRIPT_WINDOW);
  }
  const windowed = typeof IntersectionObserver !== "undefined";
  // The start moves in steps of a quarter window, not one item per append: dropping the top row on every new message
  // made every append also a removal above the viewport (a scroll-anchoring pass and a relayout of all rows).
  const step = TRANSCRIPT_WINDOW / 4;
  let start = !windowed ? 0 : Math.max(0, Math.floor((items.length - windowSize) / step) * step);
  // A reader up in the history keeps every row above them: the window only moves on while the foot is followed.
  if (lastStart.current >= 0 && start > lastStart.current && !wasNear.current) start = lastStart.current;
  const highlightAt = highlight ? items.findIndex((i) => i.key === highlight) : -1;
  if (highlightAt >= 0) start = Math.max(0, Math.min(start, highlightAt - 10));
  // Bug 449: moving the window on drops rows above the viewport, and everything in view moved up by their height for
  // a frame (scroll-back 1218px in the motion check). The last row on screen is read before the commit (a layout
  // read, only when the window moves) and the scroll is put back under it after.
  const advancedFrom = useRef<{ el: Element; top: number } | null>(null);
  if (lastStart.current >= 0 && start > lastStart.current && box.current && !advancedFrom.current) {
    const rows = box.current.querySelectorAll(":scope > [id^='entry-']");
    const anchor = rows[rows.length - 1];
    if (anchor) advancedFrom.current = { el: anchor, top: anchor.getBoundingClientRect().top };
  }
  lastStart.current = start;
  const shownItems = start > 0 ? items.slice(start) : items;
  useEffect(() => {
    const el = box.current;
    const t = top.current;
    if (!el || !t || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      grownFrom.current ??= { h: el.scrollHeight, top: el.scrollTop };
      setWindowSize((w) => w + TRANSCRIPT_WINDOW);
    }, { root: el, rootMargin: "100% 0px 0px 0px" });
    io.observe(t);
    return () => io.disconnect();
  }, [botId, start > 0]);
  useLayoutEffect(() => {
    const g = grownFrom.current;
    const el = box.current;
    grownFrom.current = null;
    if (g && el) el.scrollTop = g.top + (el.scrollHeight - g.h);
    const a = advancedFrom.current;
    advancedFrom.current = null;
    if (a && el && a.el.isConnected) {
      const moved = a.el.getBoundingClientRect().top - a.top;
      if (Math.abs(moved) >= 1) el.scrollTop += moved;
    }
  }, [start]);
  // The content height the scroll position was last reconciled against. A ResizeObserver growth is
  // judged against it for the same reason: by the time the observer fires, the growth is already in.
  const lastHeight = useRef(0);
  // "glide": ride the glide spring down (scroll-glide.ts; a user's own scroll input takes over, and a
  // re-glide keeps its momentum). "jump": land instantly (first render for a Bot, reduced motion).
  // "follow": a stream republish; a glide already under way tracks the growth itself (its target is
  // read every frame), otherwise land instantly, since a glide re-issued per chunk never converges.
  const toEnd = (mode: "glide" | "jump" | "follow") => {
    const el = box.current;
    if (!el) return;
    if (mode === "glide" && !prefersReducedMotion() && gapOf(el) > 1) glideScroll(el, () => el.scrollHeight - el.clientHeight);
    else if (!(mode === "follow" && isGliding(el))) {
      stopGlide(el);
      end.current?.scrollIntoView({ block: "end", behavior: scrollBehavior(false) });
      // The sentinel's "end" is short of the true bottom by the transcript's bottom padding, and the
      // ResizeObserver then pulled it the rest of the way: a 7px jiggle on every instant follow (the
      // typing dots giving way to a tool-step row showed it as an 18px drop and a 7px bounce, motion
      // check "reply"). Land on the real bottom in the same task, before any paint.
      el.scrollTop = el.scrollHeight;
    }
    lastHeight.current = el.scrollHeight;
  };

  // Motion-spec §3.6. A new message GLIDES into view rather than teleporting, but this same effect
  // re-runs on every partialText republish — many times a second while a Bot streams — and a smooth
  // scroll re-issued before it converges never converges. So the gate is the item COUNT (or the typing
  // bubble appearing), never the content: smooth then; instant on a stream-length change, on the first
  // render for a Bot, and under reduced motion (a `behavior` argument is not reached by the CSS
  // universal block — see renderer/motion.ts). A LAYOUT effect, so opening a chat lands at the bottom
  // before the first paint: no frame of the top, no visible jump.
  const shownBot = useRef<string | null>(null);
  const prevLen = useRef(items.length);
  const hadIndicator = useRef(indicator !== null);
  useLayoutEffect(() => {
    const first = shownBot.current !== botId;
    shownBot.current = botId;
    const grew = items.length !== prevLen.current || (indicator !== null && !hadIndicator.current);
    prevLen.current = items.length;
    hadIndicator.current = indicator !== null;
    if (first) { setUnseen(false); toEnd("jump"); return; }
    // The user's own send always glides down to its bubble, even from up in the history (iMessage).
    const last = items.at(-1);
    const sent = grew && last?.kind === "user" && isPendingId(last.key);
    if (sent) setUnseen(false);
    if (!wasNear.current && !sent) {
      if (box.current) lastHeight.current = box.current.scrollHeight;
      setUnseen(true);
      return;
    }
    toEnd(grew ? "glide" : "follow");
  }, [botId, items.length, typing?.partialText, indicator !== null]);

  // Growth that is not a commit of this component — an image decoding, a card or a tool-step list
  // expanding, a font swapping in — arrives through a ResizeObserver, never a timer.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (isGliding(el)) { lastHeight.current = el.scrollHeight; return; } // the glide's target is live
      const prevGap = lastHeight.current - el.scrollTop - el.clientHeight;
      lastHeight.current = el.scrollHeight;
      if (prevGap <= NEAR_BOTTOM_PX && gapOf(el) > 0) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // The rows, not just the viewport: a scroller's own box does not change size when its content does.
    for (const c of el.children) ro.observe(c);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n instanceof Element) ro.observe(n);
    });
    mo?.observe(el, { childList: true });
    return () => { ro.disconnect(); mo?.disconnect(); stopGlide(el); };
  }, [botId]);

  useEffect(() => {
    const el = box.current;
    const foot = end.current;
    if (!el || !foot || typeof IntersectionObserver === "undefined") return;
    // The sentinel sits above the transcript's bottom padding, so the root is extended by the threshold less that
    // padding: "the sentinel is within the extended viewport" is exactly "the gap to the bottom is <= NEAR_BOTTOM_PX".
    const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      if (!e) return;
      near.current = e.isIntersecting;
      if (e.isIntersecting) setUnseen(false);
    }, { root: el, rootMargin: `0px 0px ${NEAR_BOTTOM_PX - pad}px 0px`, threshold: 0 });
    io.observe(foot);
    return () => { io.disconnect(); near.current = null; };
  }, [botId]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    lastHeight.current = el.scrollHeight;
    const gap = gapOf(el);
    if (gap <= NEAR_BOTTOM_PX) setUnseen(false);
    // The header's rule (ChatView, smooth pass Task 4): reuses this same handler rather than a
    // second scroll listener on the same element.
    onScrolledChange?.(el.scrollTop > 0);
  };
  // Motion-spec §3.1. Entrances are gated on `.is-new` so hydrating a Bot's history animates nothing.
  const { isNew, seed } = useIsNew(botId, items.map((i) => i.key));
  // The streaming handoff. When a reply finishes, the `.bubble.bot.typing` element unmounts and a
  // fresh `.msg.bot` mounts for the persisted entry; if that played an entrance the user would watch
  // the reply pop a second time after already reading it. The typing state carries no entry id, so
  // the rule is positional: while a stream is open — and on the render where it closes — any Bot
  // entry that appears is that stream landing, and is already on screen.
  const wasStreaming = useRef(false);
  const streaming = typing?.typing === true;
  // The stream's `typing:false` and its persisted entry are two events in no promised order. Between
  // them the Bot is often still "working", which would flip the finished text back to dots for a
  // frame. So the last streamed text is HELD until the entry lands (or the turn ends), and the entry
  // that replaces it is seeded like any other landing stream.
  const held = useRef<{ text: string; len: number; botId: string } | null>(null);
  if (held.current && held.current.botId !== botId) held.current = null;
  if (streaming || wasStreaming.current || held.current) for (const it of items) if (it.kind === "bot") seed(it.key);
  wasStreaming.current = streaming;
  if (streaming && typing?.partialText) held.current = { text: typing.partialText, len: items.length, botId };
  else if (!streaming && (indicator !== "dots" || (held.current && items.length !== held.current.len))) held.current = null;
  // The send glide (the smooth pass, Task 9; app.css `@keyframes msg-in-user`). A sent message glides
  // in where it will stay; the Bot's typing dots wait until it has settled, so they never grow in
  // beside a bubble that is still forming. Keyed on the optimistic row arriving (the moment of Enter),
  // not on the host's entry replacing it, which is the same row and plays nothing.
  const [blooping, setBlooping] = useState(false);
  const bloopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bloopSeen = useRef<Set<string> | null>(null);
  bloopSeen.current ??= new Set(pending.map((p) => p.nonce)); // already on screen at mount: not new
  useLayoutEffect(() => {
    const seen = bloopSeen.current!;
    const fresh = waiting.filter((p) => !seen.has(p.nonce));
    for (const p of fresh) seen.add(p.nonce);
    if (!fresh.length) return;
    setBlooping(true);
    if (bloopTimer.current) clearTimeout(bloopTimer.current);
    bloopTimer.current = setTimeout(() => setBlooping(false), prefersReducedMotion() ? 0 : MSG_USER_ENTER_MS);
  }, [waiting]);
  useEffect(() => () => { if (bloopTimer.current) clearTimeout(bloopTimer.current); }, []);
  // The host lands a streamed reply in THREE events (turn-runner.ts, bot-tools.ts deliver): the
  // SendMessage tool_start republishes `typing:true` with NO text, the entry is appended, then
  // `typing:false`. The first used to flip the finished reply back to dots (the bubble squashing down
  // to three dots, text scaled, then the message popping in: the "screen glitch when the Bot
  // responds"); the second showed the stream and its message at once. So held text outranks a
  // text-less republish, and once an entry has landed after it the bubble is simply gone.
  const landed = held.current !== null && items.length !== held.current.len;
  const shown: { mode: "dots" | "text"; text: string | null } | null =
    streaming && typing?.partialText ? { mode: "text", text: typing.partialText }
    : held.current ? (landed ? null : { mode: "text", text: held.current.text })
    : streaming ? { mode: indicator ?? "dots", text: null }
    : indicator ? { mode: indicator, text: null } : null;
  const bubble = blooping && shown?.mode === "dots" ? null : shown;
  // Bug 445: the streamed reply and the message that replaces it are two elements, and the stream can carry a head
  // (the Bot's face and name; typingNeedsHead) that its message, inside the same run, does not. The message then
  // appeared 42px above where the reply was being read. The stream's box is read on the render where it lands (a
  // layout read, once per reply), and the message glides from there to its place instead of appearing there.
  const typingBox = useRef<HTMLDivElement>(null);
  const handoff = useRef<{ from: DOMRect; key: string } | null>(null);
  const landing = items.at(-1);
  // The head goes with it: a reply streamed under a head of its own lands under that same head (it is the same
  // words, attributed the same way), so nothing above or around it changes height at the handoff and the view
  // does not settle by the head's height after it (the scroll-back the motion check caught). Only this session
  // shows those heads; a reload lays the run out by docHeads alone, with nothing moving.
  const streamHeads = useRef<{ botId: string; keys: Set<string> }>({ botId, keys: new Set() });
  if (streamHeads.current.botId !== botId) streamHeads.current = { botId, keys: new Set() };
  const typingHead = bubble !== null && typingNeedsHead(items);
  const streamed = useRef<{ text: boolean; head: boolean; lastKey: string | undefined }>({ text: false, head: false, lastKey: undefined });
  if (streamed.current.text && bubble?.mode !== "text" && landing?.kind === "bot" && landing.key !== streamed.current.lastKey) {
    if (streamed.current.head && !heads.has(landing.key)) streamHeads.current.keys.add(landing.key);
    if (typingBox.current && !handoff.current) handoff.current = { from: typingBox.current.getBoundingClientRect(), key: landing.key };
  }
  streamed.current = { text: bubble?.mode === "text", head: typingHead, lastKey: landing?.key };
  useLayoutEffect(() => {
    const h = handoff.current;
    if (!h) return;
    handoff.current = null;
    const row = document.getElementById(`entry-${h.key}`);
    const text = row?.querySelector(".bubble.bot");
    if (!row || !text) return;
    // The stream's box is the BUBBLE's; the row moves, so its start is the bubble's start less the bubble's offset in it.
    const r = row.getBoundingClientRect();
    const b = text.getBoundingClientRect();
    flipFrom(row, new DOMRect(h.from.left - (b.left - r.left), h.from.top - (b.top - r.top), r.width, r.height));
  });
  // The foot of the conversation can SHRINK: the typing dots give way to a shorter tool-step row, or a
  // finished step with nothing to summarise leaves. Pinned to the bottom, the browser clamps the
  // scroll and every row above drops by the difference in one frame; they glide down instead (FLIP
  // from where they were). Growth and an in-place landing move nothing at commit: a no-op for them —
  // UNLESS a send is still pending: `items` always renders the not-yet-reconciled sends last (this
  // file's `items` memo above), so while one sits at the foot, a real entry landing for an EARLIER
  // message (a reply streaming back while the user fired off a second message before it finished)
  // lands ABOVE it — an insertion in front of on-screen content, not a plain append. `stepRows` and
  // `bubble` alone miss a plain message row doing that (only a NEW tool-step row bumped the key), so
  // it shoved the still-pending row down with nothing to glide it (motion check "send", send-jump: a
  // reply landing while the next send was still pending dropped it 42px in one frame). `entries.length`
  // — gated on `waiting.length` so an ordinary tail append, nothing pending below it, stays a no-op —
  // closes that gap.
  const stepRows = items.reduce((n, i) => n + (i.kind === "activity" ? 1 : 0), 0);
  //
  // Bug 444: while a send is pending, ANY change to the entries can move it (a whole reply turn landing above it in
  // one burst, a step row updating in place), not only a change in their count, so the trigger is the entries
  // array itself then. The measure is 24 rows and only happens during the second or so a send is pending.
  const flipKey = useMemo(() => ({}), [bubble === null, stepRows, waiting.length ? entries : null]); // eslint-disable-line react-hooks/exhaustive-deps
  useFlip(() => (wasNear.current && box.current ? [...box.current.children].slice(-24) : []), flipKey);
  // highlightSeq changes on every jump, so jumping twice to the same message scrolls twice instead of
  // writing an unchanged value; the outline is then dropped again rather than staying for the session.
  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`entry-${highlight}`)?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => useUi.getState().clearHighlight(), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight, highlightSeq]);
  return (
    <div className="transcript-wrap">
    <div ref={box} role="log" aria-label="Conversation transcript" className="transcript" onScroll={onScroll}>
      {/* UI polish pass (critique 3.6): an empty chat is the Bot itself, not a black void — its face at
          64 and its name, nothing else. Never while the transcript is still loading. */}
      {loaded && items.length === 0 && indicator === null && self && (
        <div className="empty-chat"><EmptyView icon={<BotAvatar bot={self} size={64} />} title={self.profile.name} announce={false} /></div>
      )}
      {start > 0 && <div ref={top} className="transcript-more" aria-hidden="true" />}
      {/* flatMap, not map returning [head, row] pairs: a nested array is keyed by its INDEX in the outer one, so when
          the render window moves (bug 442) every headed row shifted index and remounted, replaying its entrance
          (bug 448). Flat, each head and row keeps its own key. */}
      {shownItems.flatMap((it) => {
        const streamedHead = it.kind === "bot" && streamHeads.current.keys.has(it.key);
        const head = (heads.has(it.key) || streamedHead) && self ? <DocHead key={`head-${it.key}`} bot={self} at={heads.get(it.key) ?? (it.kind === "bot" ? it.entry.createdAt : null)} /> : null;
        const el = (
          <Row key={rowKey(it)} it={it} botId={botId} highlighted={highlight === it.key} fresh={isNew(it.key)} cut={interrupted[it.key]}
            author={it.kind === "bot" && it.author ? bots[it.author.id] : undefined}
            linkOk={it.kind === "notice" && it.link ? !!bots[it.link.botId] : undefined}
            eventBot={it.kind === "event" && it.entry.event.type === "bot-created" ? bots[it.entry.event.botId] : undefined}
            entries={it.kind === "event-row" ? entries : undefined} />
        );
        return head ? [head, el] : [el];
      })}
      {typingHead && self && <DocHead key="head-typing" bot={self} at={null} />}
      {bubble && <TypingBubble mode={bubble.mode} text={bubble.text} boxRef={typingBox} />}
      <div ref={end} />
    </div>
    {unseen && (
      <button type="button" className="new-pill" onClick={() => { setUnseen(false); toEnd("glide"); }}>
        {STR.newMessages} <ChevronDownIcon />
      </button>
    )}
    </div>
  );
}

/** A row's React key: a user row is keyed by clientNonce, so its optimistic row and the host's entry are one element. */
const rowKey = (it: TranscriptItem): string => (it.kind === "user" && it.entry.clientNonce ? `n-${it.entry.clientNonce}` : it.key);

interface RowProps {
  it: TranscriptItem; botId: string; highlighted: boolean; fresh: boolean; cut?: string;
  /** A group member's own post: that member's summary. */ author?: BotSummary;
  /** A notice's linked chat still exists. */ linkOk?: boolean;
  /** "Created <Bot>": that Bot. */ eventBot?: BotSummary;
  /** Only for an "event-row" item, which reads its neighbours. */ entries?: TranscriptEntry[];
}

/**
 * One transcript row, memoised (bug 442): props are primitives or objects shared across passes (transcript-share.ts),
 * so a transcript event re-renders only the rows it changed, not the whole history.
 */
const Row = memo(function Row({ it, botId, highlighted, fresh, cut, author: a, linkOk, eventBot, entries }: RowProps) {
        switch (it.kind) {
          case "separator": return <div key={it.key} className="separator">{it.label}</div>;
          // Keyed by clientNonce, not entry id: the optimistic row and the host's entry that replaces it
          // are ONE element, so the swap never remounts it or replays the bloop. Its files are keyed by
          // attachment id for the same reason. A row still pending has no actions (nothing to reply to yet).
          case "user": return (
            <div key={it.entry.clientNonce ? `n-${it.entry.clientNonce}` : it.key} id={`entry-${it.key}`} className={`msg user${highlighted ? " highlight" : ""}${newFlag(fresh)}`}>
              {it.entry.replyToId && <ReplyHeader botId={botId} replyToId={it.entry.replyToId} />}
              {it.entry.email && <div className="msg-email" data-email-in><span className="msg-email-chip">{STRG.emailInChip}</span><span className="msg-email-subject">{it.entry.email.subject}</span></div>}
              {it.attachments.map((a, i) => <UserAttachment key={`${a.attachmentId}#${i}`} botId={botId} entry={a} />)}
              <div className="msg-line">
                {it.text.trim() && <div className="bubble user" title={it.voiceMs ? `••• ${formatClock(it.voiceMs)}` : undefined}>{it.text}</div>}
                {!isPendingId(it.key) && <MessageActions botId={botId} entry={it.entry} text={it.text} />}
              </div>
              {/* Bug 198: sent while the Bot worked — waiting for its next step, then shown to it. */}
              {it.entry.steer && <span className="msg-steer" role="status">{it.entry.steer === "queued" ? STR.steerQueued : STR.steerDelivered}</span>}
              <Reactions botId={botId} entry={it.entry} />
              {it.replyCount > 0 && <ThreadPanel botId={botId} rootId={it.key} count={it.replyCount} />}
            </div>
          );
          case "bot": {
            // B2B-01/GRP-14: a group member's own post (`author` set, not the user's Bot itself) shows
            // that member's avatar and name beside the bubble (Group.dc.html lines 80–86).
            const author = it.author;
            // Phase 5: links in Bot messages may be app deep links (synapse://…, or the old bots://), opened in-app.
            // Voice calls: a reply the user talked over stays cut at the last spoken sentence.
            const bubble = <div className="bubble bot"><BotMarkdown text={cut ?? it.text} />{cut !== undefined && <span className="muted interrupted-mark">{STR5.interrupted}</span>}</div>;
            return (
              <div key={it.key} id={`entry-${it.key}`} className={`msg bot${author ? " member" : ""}${highlighted ? " highlight" : ""}${newFlag(fresh)}`}>
                {it.entry.replyToId && <ReplyHeader botId={botId} replyToId={it.entry.replyToId} />}
                <div className="msg-line">
                  {author ? (
                    <div className="member-post">
                      <ShapeAvatar shape={a?.profile.avatarShape ?? "pebble"} color={a?.profile.avatarColor ?? "#777777"} size={26} living={author.id} touch={false} />
                      <div className="member-col">
                        <span className="member-name">{author.name}</span>
                        {bubble}
                      </div>
                    </div>
                  ) : bubble}
                  <MessageActions botId={botId} entry={it.entry} text={it.text} />
                </div>
                <RateButtons botId={botId} entryId={it.key} kind="reply" />
                <Reactions botId={botId} entry={it.entry} />
                {it.replyCount > 0 && <ThreadPanel botId={botId} rootId={it.key} count={it.replyCount} />}
              </div>
            );
          }
          case "widget": return <WidgetCard key={it.key} botId={botId} entry={it.entry} isNew={fresh} />;
          case "card": return "card" in it
            ? <CardView key={it.key} botId={botId} entryId={it.key} card={it.card} isNew={fresh} />
            : <LegacyCardView key={it.key} botId={botId} entry={it.entry} isNew={fresh} />;
          case "connect-card": return <ConnectListenerCard key={it.key} botId={botId} entry={it.entry} />;
          case "file": return <FileCard key={it.key} botId={botId} entry={it.entry} isNew={fresh} />;
          // Bug 108: "Joined a call in Kenny · 4m" links to the chat that holds the call.
          // Bug 134: a voicemail (play + transcript) and a call's summary with its action items.
          case "notice": return it.voicemail ? <VoicemailNote key={it.key} botId={botId} entryId={it.key} missed={it.text} text={it.voicemail.text} />
            : it.callSummary ? <CallSummaryNote key={it.key} title={it.text} summary={it.callSummary.summary} actions={it.callSummary.actions} />
            : it.link && linkOk
            ? <button key={it.key} type="button" className="event-row notice as-button" onClick={() => void useUi.getState().openBot(it.link!.botId)}>{it.text}</button>
            : <div key={it.key} className="event-row notice">{it.text}</div>;
          case "activity": return it.running ? <ActivityGroup key={it.key} item={it} /> : <Fragment key={it.key}><ActivityGroup item={it} /><div className="activity-rate"><RateButtons botId={botId} entryId={it.key} kind="task" /></div></Fragment>;
          case "approval": return <ApprovalCard key={it.key} botId={botId} approval={it.approval} isNew={fresh} />;
          case "box-help": return <BoxHelpCard key={it.key} botId={botId} request={it.request} />;
          case "secret": return <SecretCard key={it.key} botId={botId} entryId={it.entryId} secret={it.secret} />;
          case "form": return <FormCard key={it.key} botId={botId} entryId={it.entryId} card={it.card} />;
          case "exchange": return <ExchangeBlock key={it.key} item={it} />;
          case "event-row": return <EventRow key={it.key} entry={it.entry} entries={entries ?? []} />;
          case "event": {
            const ev = it.entry.event;
            if (ev.type === "bot-created") {
              const b = eventBot;
              return <div key={it.key} className="event-row"><span>{STR.created}</span>{b && <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={16} />}<span>{b?.profile.name ?? ev.name}</span></div>;
            }
            if (ev.type === "skill-saved") return <div key={it.key} className="event-row"><span>{STR.skillSaved}</span><span>{ev.name}</span></div>;
            if (ev.type === "renamed") return <div key={it.key} className="event-row"><span>{STR.renamedTo}</span><span>{ev.name}</span></div>;
            return null; // Unreachable: every other event type routes to the "event-row" item above.
          }
        }
});

/**
 * The head of a Bot's run (doc-heads.ts): its face, its name, and when the run began. The face is the
 * still rest frame — one head per turn down a long history must not add a live avatar per turn to the
 * shared avatar loop (the idle-CPU budget, bug 100). A picture avatar is drawn as the picture.
 */
function DocHead({ bot, at }: { bot: BotSummary; at: number | null }) {
  return (
    <div className="doc-head">
      <span className="doc-avatar">
        {bot.profile.avatarKind === "image" || bot.group ? <BotAvatar bot={bot} size={22} /> : <ShapeAvatar shape={bot.profile.avatarShape} color={bot.profile.avatarColor} size={22} still />}
      </span>
      <span className="doc-name">{bot.profile.name}</span>
      {at !== null && <time dateTime={new Date(at).toISOString()}>{clockTime(at)}</time>}
    </div>
  );
}

/**
 * The Bot's typing bubble — dots while it composes, then the streamed reply — as ONE element, so the
 * handoff is a morph: when the first chunk lands the bubble's SURFACE (its `::before`, app.css) grows
 * from the three-dot size into the message's while the text fades in, instead of one bubble cutting
 * to another. Only the surface is scaled: scaling the element itself stretched the text's glyphs
 * (0.79×1.00 in the motion check's reply scenario). See typing-indicator.ts for when it shows at all.
 */
function TypingBubble({ mode, text, boxRef }: { mode: "dots" | "text"; text: string | null; boxRef?: { current: HTMLDivElement | null } }) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  useFlip(() => (ref.current ? [ref.current] : []), mode, { scale: true, origin: "0 0", pseudoElement: "::before" });
  return (
    <div ref={ref} className="bubble bot typing" aria-label={STR.typing}>
      {mode === "text" && text ? <StreamMarkdown text={text} /> : <span className="dots"><i /><i /><i /></span>}
    </div>
  );
}
