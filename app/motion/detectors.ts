import type { Frame, Glitch, Recording, Sample } from "./types";

/**
 * Glitch detectors over a frame recording (recorder.ts). Pure functions: the motion check runs them on
 * real recordings, and motion-detectors.test.ts runs them on hand-made ones, so each detector is
 * proven to fire on its glitch and to stay quiet on clean motion.
 */

const VISIBLE = 0.6;
const GONE = 0.2;
const FRAME = 1000 / 60;
/** The longest a staggered child may legitimately wait hidden: STAGGER_CAP (4) x 40ms, plus a frame of slack. */
export const MAX_STAGGER_HIDDEN_MS = 4 * 40 + 1 + 3 * FRAME;

function byId(frames: Frame[]): Map<number, { f: number; s: Sample }[]> {
  const out = new Map<number, { f: number; s: Sample }[]>();
  frames.forEach((fr, f) => { for (const s of fr.els) { let a = out.get(s.id); if (!a) out.set(s.id, (a = [])); a.push({ f, s }); } });
  return out;
}

/** A node that was on screen goes (nearly) invisible for a few frames and comes back: a blink. */
export function flicker(r: Recording): Glitch[] {
  const out: Glitch[] = [];
  for (const [, seq] of byId(r.frames)) {
    for (let i = 0; i < seq.length; i++) {
      if (seq[i]!.s.op < VISIBLE) continue;
      let j = i + 1;
      while (j < seq.length && seq[j]!.f === seq[j - 1]!.f + 1 && seq[j]!.s.op < GONE) j++;
      const gap = j - i - 1;
      if (gap >= 1 && gap <= 12 && j < seq.length && seq[j]!.f === seq[j - 1]!.f + 1 && seq[j]!.s.op >= VISIBLE * 0.5) {
        out.push({ kind: "flicker", t: r.frames[seq[i + 1]!.f]!.t, detail: `${seq[i]!.s.key} blinked out for ${gap} frame(s)` });
        i = j - 1;
      }
    }
  }
  return dedupe(out);
}

/**
 * A node REMOUNTED (same content, new DOM node) and replayed its entrance: the old one was fully shown,
 * the new one starts invisible. What a React key change or a remount does to a mount animation.
 */
export function remountBlink(r: Recording): Glitch[] {
  const out: Glitch[] = [];
  for (let f = 1; f < r.frames.length; f++) {
    const prev = new Map(r.frames[f - 1]!.els.map((s) => [s.key, s] as const));
    const ids = new Set(r.frames[f - 1]!.els.map((s) => s.id));
    for (const s of r.frames[f]!.els) {
      const p = prev.get(s.key);
      if (!p || ids.has(s.id) || p.op < VISIBLE || s.op >= GONE || !s.key.includes(":") || s.key.endsWith(":")) continue;
      if (r.frames[f]!.els.some((o) => o.id === p.id)) continue; // the old node is still there: an addition, not a remount
      out.push({ kind: "remount-blink", t: r.frames[f]!.t, detail: `${s.key} remounted and replayed its entrance` });
    }
  }
  return dedupe(out);
}

/** An animated node SNAPS: the frame its animation stops (cancel without continuity) it jumps a long way. */
export function snap(r: Recording, px = 24): Glitch[] {
  const out: Glitch[] = [];
  for (const [, seq] of byId(r.frames)) {
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      if (b.f !== a.f + 1 || a.s.anim === 0 || r.frames[b.f]!.vt || r.frames[a.f]!.vt) continue;
      const scrolled = Math.abs(r.frames[b.f]!.scroll - r.frames[a.f]!.scroll);
      const d = Math.max(Math.abs(b.s.x - a.s.x), Math.abs(b.s.y - a.s.y) - scrolled);
      // Moved WITH its neighbours by the same amount: a reflow of the whole list (content arriving in a
      // short, bottom-anchored transcript), not this element's own motion stopping short.
      const dy = b.s.y - a.s.y;
      const prev = new Map(r.frames[a.f]!.els.map((s) => [s.id, s.y] as const));
      const along = r.frames[b.f]!.els.filter((s) => s.id !== b.s.id && prev.has(s.id) && Math.abs(s.y - prev.get(s.id)! - dy) <= 2).length;
      if (along >= 3) continue;
      if (d > px && b.s.anim === 0) out.push({ kind: "snap", t: r.frames[b.f]!.t, detail: `${b.s.key} jumped ${Math.round(d)}px when its animation stopped` });
    }
  }
  return dedupe(out);
}

/** The same content shown twice at once (a morph ghost beside the real element, a duplicate bubble). */
export function doubled(r: Recording, selector = "bubble"): Glitch[] {
  const out: Glitch[] = [];
  for (const fr of r.frames) {
    const seen = new Map<string, number>();
    for (const s of fr.els) {
      if (!s.key.startsWith(`${selector}:`) || s.op < GONE || s.key.endsWith(":")) continue;
      seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
    }
    for (const [k, n] of seen) if (n > 1) out.push({ kind: "double", t: fr.t, detail: `${k} rendered ${n} times` });
  }
  return dedupe(out);
}

/** After everything settled: a transform, view-transition-name, glide class or finite animation left behind. */
export function residual(r: Recording): Glitch[] {
  const last = r.frames.at(-1);
  if (!last) return [];
  const out: Glitch[] = [];
  for (const s of last.els) {
    const what = [
      s.inTf && `inline transform ${s.inTf}`,
      s.vtn && !s.key.startsWith("main:") && `view-transition-name ${s.vtn}`,
      /\bglide-sel\b/.test(s.cls) && `class ${s.cls}`,
      s.anim > 0 && `${s.anim} animation(s) still running`,
      s.op > 0 && s.op < 0.99 && !/composer-input|disabled/.test(s.key + s.cls) && `stuck at opacity ${s.op}`,
      s.tf && s.tf !== "matrix(1, 0, 0, 1, 0, 0)" && !/avatar|presence|switch|menu|listbox|new-pill|dots|typing/.test(s.key + s.cls) && `transform ${s.tf}`,
    ].filter(Boolean);
    if (what.length) out.push({ kind: "residual", detail: `${s.key}: ${what.join("; ")}` });
  }
  return dedupe(out);
}

/** View Transitions that aborted for a reason other than being redirected by the next one. */
export function vtAborts(r: Recording): Glitch[] {
  return r.events.filter((e) => e.kind === "vt-abort" && !/skipped/i.test(e.name ?? ""))
    .map((e) => ({ kind: "vt-abort", t: e.t, detail: e.name ?? "" }))
    .concat(r.events.filter((e) => e.kind === "error" && /view-transition|ViewTransition/i.test(e.name ?? "")).map((e) => ({ kind: "vt-abort", t: e.t, detail: e.name ?? "" })));
}

/** Layout shift while motion runs (transform-only motion never shifts layout). */
export function layoutShift(r: Recording, max = 0.02): Glitch[] {
  const total = r.events.filter((e) => e.kind === "layout-shift").reduce((a, e) => a + (e.value ?? 0), 0);
  return total > max ? [{ kind: "cls", detail: `cumulative layout shift ${total.toFixed(3)}` }] : [];
}

/** A node that mounted and then waited invisible longer than any stagger allows (backwards fill + delay). */
export function hiddenTooLong(r: Recording, maxMs = MAX_STAGGER_HIDDEN_MS): Glitch[] {
  const out: Glitch[] = [];
  for (const [, seq] of byId(r.frames)) {
    let start: number | null = null;
    for (const { f, s } of seq) {
      if (s.op < 0.05 && s.anim > 0) { start ??= r.frames[f]!.t; if (r.frames[f]!.t - start > maxMs) { out.push({ kind: "hidden-too-long", t: start, detail: `${s.key} held invisible over ${Math.round(maxMs)}ms` }); break; } }
      else if (s.op >= 0.05) start = null;
    }
  }
  return dedupe(out);
}

/**
 * The transcript scrolling UP on its own. Auto-scroll only ever follows down; a scroll that falls back
 * with no user scroll input just before it is the scroller's height shrinking under a scrollTop that
 * had followed phantom overflow (a transform reaching past the content) — the whole transcript jiggles.
 */
export function scrollBack(r: Recording, px = 2): Glitch[] {
  // A wheel is the user scrolling; a click can collapse content (a disclosure), which scrolls back legitimately.
  const wheels = r.events.filter((e) => e.kind === "input" && (e.name === "wheel" || e.name === "pointerdown")).map((e) => e.t);
  for (let i = 1; i < r.frames.length; i++) {
    const a = r.frames[i - 1]!;
    const b = r.frames[i]!;
    if (a.scroll < 0 || b.scroll < 0 || a.scroll - b.scroll <= px) continue;
    if (wheels.some((t) => t <= b.t && b.t - t < 800)) continue;
    // A window resize or a collapse legitimately clamps the scroll down. The jiggle is a RISE and FALL:
    // it followed overflow up within the last 800ms and is now handing it back, at an unchanged viewport.
    const recent = r.frames.slice(0, i).filter((f) => b.t - f.t < 800 && f.scroll >= 0);
    if (recent.some((f) => f.ch !== b.ch)) continue;
    if (!recent.some((f, k) => k > 0 && f.scroll > recent[k - 1]!.scroll + px)) continue;
    // What is ON SCREEN did not move: the rows glide from where they were (a FLIP absorbing the
    // clamp of a shrinking conversation), so the fall is invisible.
    const before = new Map(a.els.filter((s) => s.cls.startsWith("msg")).map((s) => [s.id, s.y] as const));
    const rows = b.els.filter((s) => before.has(s.id));
    if (rows.length && rows.every((s) => Math.abs(s.y - before.get(s.id)!) <= px)) continue;
    return [{ kind: "scroll-back", t: b.t, detail: `transcript scrolled up ${a.scroll - b.scroll}px with no user scroll (overflow shrank)` }];
  }
  return [];
}

/**
 * The transcript TELEPORTING: at rest, then one frame later more than `px` away, then at rest again —
 * no glide in between. (A glide spreads the same distance over ~40 frames.) User scrolls and resizes
 * are excluded; a Bot switch is a different transcript.
 */
export function scrollJump(r: Recording, px = 100): Glitch[] {
  const inputs = r.events.filter((e) => e.kind === "input" && (e.name === "wheel" || e.name === "pointerdown")).map((e) => e.t);
  for (let i = 2; i < r.frames.length - 1; i++) {
    const [z, a, b, c] = [r.frames[i - 2]!, r.frames[i - 1]!, r.frames[i]!, r.frames[i + 1]!];
    if ([z, a, b, c].some((f) => f.scroll < 0) || a.ch !== b.ch) continue;
    if (Math.abs(b.scroll - a.scroll) <= px || Math.abs(a.scroll - z.scroll) > 2 || Math.abs(c.scroll - b.scroll) > 2) continue;
    if (inputs.some((t) => t <= b.t && b.t - t < 800)) continue;
    return [{ kind: "scroll-jump", t: b.t, detail: `transcript jumped ${b.scroll - a.scroll}px in one frame instead of gliding` }];
  }
  return [];
}

/** The programmatic scroll pulling against the user: after a user scroll input, the transcript keeps moving the other way. */
export function scrollFight(r: Recording): Glitch[] {
  const out: Glitch[] = [];
  const commands = r.events.filter((x) => x.kind === "input" && (x.name === "keydown" || x.name === "pointerdown")).map((x) => x.t);
  for (const e of r.events.filter((x) => x.kind === "input" && x.name === "wheel")) {
    // The user's NEXT command ends the window: sending a message (Enter) glides down to its bubble by
    // design (decisions.md, "send bloop"), which is following the user, not fighting them.
    const until = Math.min(e.t + 500, ...commands.filter((t) => t > e.t));
    const after = r.frames.filter((f) => f.t > e.t + 2 * FRAME && f.t < until && f.scroll >= 0);
    for (let i = 1; i < after.length; i++) {
      const d = after[i]!.scroll - after[i - 1]!.scroll;
      const grew = after[i]!.scrollMax !== after[i - 1]!.scrollMax;
      if (d > 3 && !grew) { out.push({ kind: "scroll-fight", t: after[i]!.t, detail: `transcript scrolled down ${d}px after the user scrolled up` }); break; }
    }
  }
  return dedupe(out);
}

/** A CSS entrance that restarted on a node that never left (a class re-applied, an animation re-triggered). */
export function restarts(r: Recording): Glitch[] {
  const seen = new Map<string, number>();
  const out: Glitch[] = [];
  for (const e of r.events) {
    if (e.kind !== "css-start" || !e.name || /pulse|breathe|shimmer|typing|lean|type-wipe/.test(e.name) || e.key?.startsWith("html:")) continue; // html: the View Transition pseudo-elements, one set per transition
    const k = `${e.id}|${e.name}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 2) out.push({ kind: "restart", t: e.t, detail: `${e.key} replayed ${e.name}` });
  }
  return out;
}

/**
 * The send's hand-off: the sent text must be on screen in EVERY frame — in the composer until its
 * bubble exists, then in the bubble. The send is optimistic (the bloop), so the composer clearing and
 * the bubble appearing are one commit; a gap of more than `maxFrames` between the composer's text
 * going and the new user bubble appearing is the message blinking out (bug #87).
 */
export function sendGap(r: Recording, maxFrames = 2): Glitch[] {
  const out: Glitch[] = [];
  const shown = (f: Frame) => f.els.some((s) => s.key.startsWith("composer-input") && s.val > 0 && s.op > 0.5);
  const isUser = (s: Sample) => s.key.startsWith("bubble:entry-") && /\buser\b/.test(s.cls) && s.op > 0.2;
  const first = new Map<number, number>(); // bubble id -> first frame it is on screen
  r.frames.forEach((f, i) => { for (const s of f.els) if (isUser(s) && !first.has(s.id)) first.set(s.id, i); });
  const present = new Set(r.frames[0]?.els.map((s) => s.id) ?? []);
  for (let i = 1; i < r.frames.length; i++) {
    if (!shown(r.frames[i - 1]!) || shown(r.frames[i]!)) continue;
    // The bubble that took over: the first new one on screen from a few frames before the text went
    // (the flight starts, then the text lifts off) onwards.
    const took = [...first].filter(([id, f]) => !present.has(id) && f >= i - 8 && f < i + 90).map(([, f]) => f).sort((a, b) => a - b)[0];
    if (took !== undefined && took - i > maxFrames) out.push({ kind: "send-gap", t: r.frames[i]!.t, detail: `sent text off screen for ${took - i} frames before its bubble appeared` });
  }
  return out;
}

const isUserMsg = (s: Sample) => s.key.startsWith("msg:entry-") && /\bmsg\b/.test(s.cls) && /\buser\b/.test(s.cls);
const isUserBubble = (s: Sample) => s.key.startsWith("bubble:entry-") && /\buser\b/.test(s.cls);
/** What a bubble says, without the entry id (which changes when the host's entry replaces the optimistic one). */
const textOf = (s: Sample) => s.key.slice(s.key.indexOf("/") + 1);

/**
 * Every user message that arrives during a recording was sent from the composer (the scenarios send no
 * other way), so every one must BLOOP: the `msg-in-user` CSS entrance on its `.msg` row (renamed from
 * `bloop` by the smooth pass, Task 9 — "messages glide, no squash-bounce" — which kept the send's own
 * entrance but dropped the sampled pop-spring; this detector's animation name was not updated with it).
 * One that just pops in means the entrance was lost (a class dropped, the row seeded as history, the
 * animation removed).
 */
export function sendNoBloop(r: Recording): Glitch[] {
  const before = new Set(r.frames[0]?.els.map((s) => s.id) ?? []);
  const blooped = new Set(r.events.filter((e) => e.kind === "css-start" && e.name === "msg-in-user").map((e) => e.id));
  const out: Glitch[] = [];
  const seen = new Set<number>();
  for (const f of r.frames) for (const s of f.els) {
    if (seen.has(s.id) || before.has(s.id) || !isUserMsg(s)) continue;
    seen.add(s.id);
    // Sent from the composer: first seen as an optimistic row, or arriving live (`is-new`). History a Bot
    // switch mounts is neither, and rightly has no entrance.
    if (!s.key.startsWith("msg:entry-pending-") && !/\bis-new\b/.test(s.cls)) continue;
    if (!blooped.has(s.id)) out.push({ kind: "send-no-bloop", t: f.t, detail: `${s.key.slice(0, 60)} appeared without the bloop` });
  }
  return out;
}

/**
 * A GHOST on reconcile: the optimistic bubble and the host's entry for the same message on screen at
 * once (the nonce match failed, so the pending row was never retired). Only bubbles that arrived during
 * the recording count, so an older message with the same words is not a ghost.
 */
export function sendGhost(r: Recording): Glitch[] {
  const before = new Set(r.frames[0]?.els.map((s) => s.id) ?? []);
  const out: Glitch[] = [];
  for (const fr of r.frames) {
    const byText = new Map<string, Set<number>>();
    for (const s of fr.els) {
      if (!isUserBubble(s) || before.has(s.id) || s.op < GONE) continue;
      let ids = byText.get(textOf(s));
      if (!ids) byText.set(textOf(s), (ids = new Set()));
      ids.add(s.id);
    }
    for (const [t, ids] of byText) if (ids.size > 1) out.push({ kind: "send-ghost", t: fr.t, detail: `"${t}" on screen ${ids.size} times (optimistic + real)` });
  }
  return dedupe(out);
}

/**
 * A REMOUNT on reconcile: the optimistic bubble's node leaves and a new node with the same words takes
 * its place within a few frames. The swap has to be the same element (the row is keyed by clientNonce);
 * a new node replays the entrance and blinks. remountBlink cannot see this: the entry id in the key changes.
 */
export function sendRemount(r: Recording, within = 3): Glitch[] {
  const before = new Set(r.frames[0]?.els.map((s) => s.id) ?? []);
  const out: Glitch[] = [];
  for (let f = 1; f < r.frames.length; f++) {
    const now = new Set(r.frames[f]!.els.map((s) => s.id));
    for (const gone of r.frames[f - 1]!.els) {
      if (!isUserBubble(gone) || before.has(gone.id) || now.has(gone.id)) continue;
      const came = r.frames.slice(f, f + within).some((fr) => fr.els.some((s) => isUserBubble(s) && s.id !== gone.id && textOf(s) === textOf(gone) && !before.has(s.id)
        && !r.frames[f - 1]!.els.some((p) => p.id === s.id)));
      if (came) out.push({ kind: "send-remount", t: r.frames[f]!.t, detail: `"${textOf(gone)}" was replaced by a new node on reconcile (entrance replayed)` });
    }
  }
  return dedupe(out);
}

/**
 * A sent bubble JUMPING: its foot (the bloop's origin, so the grow itself does not move it) shifts more
 * than `px` in one frame in content coordinates (scroll removed). The bloop rises 6px in total; a reconcile
 * that reorders or re-lays-out the row, or a double send that shoves the first bubble, is a jump. A whole
 * list reflowing together (content arriving in a short, bottom-anchored transcript) is not.
 */
export function sendJump(r: Recording, px = 12): Glitch[] {
  const before = new Set(r.frames[0]?.els.map((s) => s.id) ?? []);
  const out: Glitch[] = [];
  for (const [id, seq] of byId(r.frames)) {
    if (before.has(id) || !isUserBubble(seq[0]!.s)) continue;
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      const fa = r.frames[a.f]!;
      const fb = r.frames[b.f]!;
      if (b.f !== a.f + 1 || fa.vt || fb.vt || fa.ch !== fb.ch || fa.scroll < 0 || fb.scroll < 0) continue;
      const dy = (b.s.y + b.s.h + fb.scroll) - (a.s.y + a.s.h + fa.scroll);
      if (Math.abs(dy) <= px) continue;
      const vy = b.s.y + b.s.h - (a.s.y + a.s.h);
      const prev = new Map(fa.els.map((s) => [s.id, s.y] as const));
      const along = fb.els.filter((s) => s.id !== id && prev.has(s.id) && Math.abs(s.y - prev.get(s.id)! - vy) <= 2).length;
      if (along >= 3) continue;
      out.push({ kind: "send-jump", t: fb.t, detail: `"${textOf(b.s)}" jumped ${Math.round(dy)}px in one frame` });
      break;
    }
  }
  return out;
}

/**
 * PIXELS (pixels.ts inkSeries): a region that holds content before and after a transition goes BLANK
 * on screen mid-way — its ink under `frac` of the settled level for longer than `minMs`. What a DOM
 * sample cannot see: a View Transition draws pseudo-elements, and a named element whose snapshot
 * never arrives leaves a hole the DOM knows nothing about.
 */
export function blankRegion(series: { t: number; ink: Record<string, number> }[], key: string, o: { minMs?: number; frac?: number } = {}): Glitch[] {
  const minMs = o.minMs ?? 150;
  const frac = o.frac ?? 0.25;
  if (series.length < 4) return [];
  const level = Math.min(series[0]!.ink[key]!, series.at(-1)!.ink[key]!);
  if (level <= 0.005) return [];
  let start: number | null = null;
  for (const s of series) {
    if (s.ink[key]! < level * frac) {
      start ??= s.t;
      if (s.t - start > minMs) return [{ kind: "blank", t: start, detail: `${key} blank on screen for over ${minMs}ms` }];
    } else start = null;
  }
  return [];
}

const isTyping = (s: Sample) => s.cls.includes("bubble") && s.cls.includes("typing");
const isBotBubble = (s: Sample) => s.cls.includes("bubble") && s.cls.includes("bot") && !s.cls.includes("typing");
const scaleOf = (tf: string): [number, number] => {
  const m = /^matrix\(([^)]+)\)/.exec(tf);
  if (!m) return [1, 1];
  const [a, b, c, d] = m[1]!.split(",").map(Number) as [number, number, number, number];
  return [Math.hypot(a, b), Math.hypot(c, d)];
};

/** A streamed reply falling back: the typing bubble showed text, and the next frame shows the dots again. */
export function replyRegress(r: Recording): Glitch[] {
  for (let f = 1; f < r.frames.length; f++) {
    const a = r.frames[f - 1]!.els.find(isTyping);
    const b = r.frames[f]!.els.find(isTyping);
    if (a && b && (a.txt ?? -1) > 0 && b.txt === 0) return [{ kind: "reply-regress", t: r.frames[f]!.t, detail: `the streamed reply (${a.txt} chars) shrank back to the typing dots before it landed` }];
  }
  return [];
}

/**
 * Bot text drawn SCALED: a morph that stretches the reply's glyphs (the dots' box growing into the
 * text's). Any non-uniform scale is a stretch; a uniform one past `tol` is a squash (the Bot
 * entrance's own settle, msg-in-left's 0.97, is under it).
 */
export function textScaled(r: Recording, tol = 0.04): Glitch[] {
  for (const fr of r.frames) {
    for (const s of fr.els) {
      if (!(isTyping(s) || isBotBubble(s)) || (s.txt ?? -1) <= 0 || !s.tf || s.op < GONE) continue;
      const [sx, sy] = scaleOf(s.tf);
      if (Math.abs(sx - sy) > 0.02 || Math.abs(sx - 1) > tol || Math.abs(sy - 1) > tol) return [{ kind: "text-scaled", t: fr.t, detail: `${s.key} drew its text at scale ${sx.toFixed(2)}×${sy.toFixed(2)}` }];
    }
  }
  return [];
}

/**
 * The streamed reply handing off to the persisted message. The frame the typing bubble goes, the
 * message must be on screen with the same text, where the stream was: no blank frame, no jump, and
 * never both at once.
 */
export function replyHandoff(r: Recording, px = 4): Glitch[] {
  const out: Glitch[] = [];
  // Messages already on screen when the recording began are history, never the stream's copy.
  const old = new Set((r.frames[0]?.els ?? []).map((s) => s.id));
  for (let f = 1; f < r.frames.length; f++) {
    const A = r.frames[f - 1]!;
    const B = r.frames[f]!;
    const both = B.els.find(isTyping);
    if (both && (both.txt ?? 0) > 0 && both.op >= VISIBLE && B.els.some((s) => isBotBubble(s) && !old.has(s.id) && s.op >= VISIBLE && s.txt === both.txt)) {
      out.push({ kind: "reply-double", t: B.t, detail: `the streamed reply and its message were both on screen (${both.txt} chars)` });
    }
    const a = A.els.find(isTyping);
    if (!a || (a.txt ?? 0) <= 0 || B.els.some(isTyping)) continue;
    const m = B.els.filter((s) => isBotBubble(s) && !old.has(s.id) && Math.abs((s.txt ?? 0) - a.txt!) <= Math.max(3, a.txt! * 0.05)).at(-1);
    if (!m || m.op < VISIBLE) { out.push({ kind: "reply-blank", t: B.t, detail: `the streamed reply went and its message was ${m ? `at opacity ${m.op}` : "not on screen"}` }); continue; }
    const dy = m.y - a.y + (B.scroll - A.scroll);
    if (Math.abs(dy) > px || Math.abs(m.x - a.x) > px) out.push({ kind: "reply-jump", t: B.t, detail: `the reply jumped ${m.x - a.x},${dy}px when its message replaced the stream` });
  }
  return dedupe(out);
}

export function detectAll(r: Recording): Glitch[] {
  return [...flicker(r), ...remountBlink(r), ...snap(r), ...doubled(r), ...residual(r), ...vtAborts(r), ...layoutShift(r), ...hiddenTooLong(r), ...scrollFight(r), ...restarts(r), ...sendGap(r), ...scrollBack(r), ...sendNoBloop(r), ...sendGhost(r), ...sendRemount(r), ...sendJump(r), ...scrollJump(r), ...replyRegress(r), ...textScaled(r), ...replyHandoff(r)];
}

function dedupe(g: Glitch[]): Glitch[] {
  const seen = new Set<string>();
  return g.filter((x) => { const k = `${x.kind}|${x.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
