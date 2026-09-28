import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { STR, STR5 } from "@synapse/shared";
import { codeComponents } from "./CodeBlock";
import { openDeepLink, safeUrlTransform } from "../deep-links";
import { newFlag, useIsNew } from "../is-new";
import { useFlip } from "../flip";
import { MSG_USER_ENTER_MS, prefersReducedMotion, scrollBehavior } from "../motion";
import { isPendingId, pendingEntries, unreconciled, usePendingSends, type PendingSend } from "../pending-sends";
import { glideScroll, isGliding, stopGlide } from "../scroll-glide";
import { useUi } from "../store";
import { useCall } from "../voice/call-store";
import { buildTranscriptItems, formatClock } from "../transcript-items";
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
import { Reactions } from "./Reactions";
import { ReplyHeader } from "./ReplyHeader";
import { ShapeAvatar } from "./ShapeAvatar";
import { ThreadPanel } from "./ThreadPanel";
import { UserAttachment } from "./UserAttachment";
import { WidgetCard } from "./WidgetCard";
import { CallSummaryNote, VoicemailNote } from "../voice/CallNotes";

/** GFM without single-tilde strikethrough: Bots write `~` for "approximately" (gate M-3); `~~x~~` still strikes. */
const REMARK_PLUGINS: NonNullable<Parameters<typeof Markdown>[0]["remarkPlugins"]> = [[remarkGfm, { singleTilde: false }]];

/** A Bot's markdown, in both its finished and typing/streaming form (TypingBubble below): links (Phase
 * 5 deep links, plus the code-cards spec's "open in the system browser") and code (CodeBlock.tsx —
 * a card for a fenced block, a chip for inline `code`), the two places the default renderer was not
 * enough on its own. */
const MD_COMPONENTS: NonNullable<Parameters<typeof Markdown>[0]["components"]> = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" onClick={(e) => { if (href && openDeepLink(href)) e.preventDefault(); }}>{children}</a>,
  ...codeComponents,
};

const EMPTY_ENTRIES: never[] = [];
const NO_PENDING: PendingSend[] = [];

/** Within this many pixels of the bottom counts as "following the conversation". */
const NEAR_BOTTOM_PX = 80;
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
  const items = useMemo(() => buildTranscriptItems(waiting.length ? [...entries, ...waiting.flatMap(pendingEntries)] : entries, Date.now()), [entries, waiting]);
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
  const wasNear = useRef(true);
  wasNear.current = !box.current || gapOf(box.current) <= NEAR_BOTTOM_PX || isGliding(box.current);
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
  useFlip(() => (wasNear.current && box.current ? [...box.current.children].slice(-24) : []),
    `${bubble === null}:${stepRows}:${waiting.length ? entries.length : -1}`);
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
      {items.map((it) => {
        const head = heads.has(it.key) && self ? <DocHead key={`head-${it.key}`} bot={self} at={heads.get(it.key) ?? null} /> : null;
        const el = row(it);
        return head ? [head, el] : el;
      })}
      {bubble && typingNeedsHead(items) && self && <DocHead key="head-typing" bot={self} at={null} />}
      {bubble && <TypingBubble mode={bubble.mode} text={bubble.text} />}
      <div ref={end} />
    </div>
    {unseen && (
      <button type="button" className="new-pill" onClick={() => { setUnseen(false); toEnd("glide"); }}>
        {STR.newMessages} <ChevronDownIcon />
      </button>
    )}
    </div>
  );

  function row(it: (typeof items)[number]) {
        switch (it.kind) {
          case "separator": return <div key={it.key} className="separator">{it.label}</div>;
          // Keyed by clientNonce, not entry id: the optimistic row and the host's entry that replaces it
          // are ONE element, so the swap never remounts it or replays the bloop. Its files are keyed by
          // attachment id for the same reason. A row still pending has no actions (nothing to reply to yet).
          case "user": return (
            <div key={it.entry.clientNonce ? `n-${it.entry.clientNonce}` : it.key} id={`entry-${it.key}`} className={`msg user${highlight === it.key ? " highlight" : ""}${newFlag(isNew(it.key))}`}>
              {it.entry.replyToId && <ReplyHeader botId={botId} replyToId={it.entry.replyToId} />}
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
            const a = author && bots[author.id];
            // Phase 5: links in Bot messages may be app deep links (synapse://…, or the old bots://), opened in-app.
            // Voice calls: a reply the user talked over stays cut at the last spoken sentence.
            const cut = interrupted[it.key];
            const bubble = <div className="bubble bot"><Markdown remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrlTransform} components={MD_COMPONENTS}>{cut ?? it.text}</Markdown>{cut !== undefined && <span className="muted interrupted-mark">{STR5.interrupted}</span>}</div>;
            return (
              <div key={it.key} id={`entry-${it.key}`} className={`msg bot${author ? " member" : ""}${highlight === it.key ? " highlight" : ""}${newFlag(isNew(it.key))}`}>
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
                <Reactions botId={botId} entry={it.entry} />
                {it.replyCount > 0 && <ThreadPanel botId={botId} rootId={it.key} count={it.replyCount} />}
              </div>
            );
          }
          case "widget": return <WidgetCard key={it.key} botId={botId} entry={it.entry} isNew={isNew(it.key)} />;
          case "card": return "card" in it
            ? <CardView key={it.key} botId={botId} entryId={it.key} card={it.card} isNew={isNew(it.key)} />
            : <LegacyCardView key={it.key} botId={botId} entry={it.entry} isNew={isNew(it.key)} />;
          case "connect-card": return <ConnectListenerCard key={it.key} botId={botId} entry={it.entry} />;
          case "file": return <FileCard key={it.key} botId={botId} entry={it.entry} isNew={isNew(it.key)} />;
          // Bug 108: "Joined a call in Kenny · 4m" links to the chat that holds the call.
          // Bug 134: a voicemail (play + transcript) and a call's summary with its action items.
          case "notice": return it.voicemail ? <VoicemailNote key={it.key} botId={botId} entryId={it.key} missed={it.text} text={it.voicemail.text} />
            : it.callSummary ? <CallSummaryNote key={it.key} title={it.text} summary={it.callSummary.summary} actions={it.callSummary.actions} />
            : it.link && bots[it.link.botId]
            ? <button key={it.key} type="button" className="event-row notice as-button" onClick={() => void useUi.getState().openBot(it.link!.botId)}>{it.text}</button>
            : <div key={it.key} className="event-row notice">{it.text}</div>;
          case "activity": return <ActivityGroup key={it.key} item={it} />;
          case "approval": return <ApprovalCard key={it.key} botId={botId} approval={it.approval} isNew={isNew(it.key)} />;
          case "box-help": return <BoxHelpCard key={it.key} botId={botId} request={it.request} />;
          case "secret": return <SecretCard key={it.key} botId={botId} entryId={it.entryId} secret={it.secret} />;
          case "form": return <FormCard key={it.key} botId={botId} entryId={it.entryId} card={it.card} />;
          case "exchange": return <ExchangeBlock key={it.key} item={it} />;
          case "event-row": return <EventRow key={it.key} entry={it.entry} entries={entries} />;
          case "event": {
            const ev = it.entry.event;
            if (ev.type === "bot-created") {
              const b = bots[ev.botId];
              return <div key={it.key} className="event-row"><span>{STR.created}</span>{b && <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={16} />}<span>{b?.profile.name ?? ev.name}</span></div>;
            }
            if (ev.type === "skill-saved") return <div key={it.key} className="event-row"><span>{STR.skillSaved}</span><span>{ev.name}</span></div>;
            if (ev.type === "renamed") return <div key={it.key} className="event-row"><span>{STR.renamedTo}</span><span>{ev.name}</span></div>;
            return null; // Unreachable: every other event type routes to the "event-row" item above.
          }
        }
  }
}

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
function TypingBubble({ mode, text }: { mode: "dots" | "text"; text: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(() => (ref.current ? [ref.current] : []), mode, { scale: true, origin: "0 0", pseudoElement: "::before" });
  return (
    <div ref={ref} className="bubble bot typing" aria-label={STR.typing}>
      {mode === "text" && text ? <Markdown remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrlTransform} components={MD_COMPONENTS}>{text}</Markdown> : <span className="dots"><i /><i /><i /></span>}
    </div>
  );
}
