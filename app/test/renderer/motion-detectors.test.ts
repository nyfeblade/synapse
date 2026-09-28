import { describe, expect, it } from "vitest";
import {
  blankRegion, doubled, flicker, hiddenTooLong, remountBlink, replyHandoff, replyRegress, residual, restarts, scrollBack, scrollFight, scrollJump, sendGap, sendGhost, sendJump, sendNoBloop, sendRemount, snap, textScaled,
} from "../../motion/detectors";
import type { Frame, MotionEvent, Recording, Sample } from "../../motion/types";

// The motion check's detectors (app/motion, `npm run motion:check -w @synapse/app`), each proven on a
// hand-made recording: it fires on its glitch and stays quiet on the clean version of the same motion.

const s = (o: Partial<Sample> & { id: number }): Sample => ({ key: `row:${o.id}`, x: 0, y: 0, w: 100, h: 20, op: 1, tf: "", anim: 0, inTf: "", vtn: "", cls: "", val: -1, ...o });
const fr = (i: number, els: Sample[], o: Partial<Frame> = {}): Frame => ({ t: i * 16.7, vt: false, scroll: -1, scrollMax: -1, ch: 400, els, ...o });
const rec = (frames: Frame[], events: MotionEvent[] = []): Recording => ({ frames, events });
const seq = (n: number, f: (i: number) => Frame) => Array.from({ length: n }, (_, i) => f(i));

describe("motion detectors", () => {
  it("flicker: a shown element blinking out for a few frames", () => {
    expect(flicker(rec(seq(10, (i) => fr(i, [s({ id: 1, op: i === 4 || i === 5 ? 0 : 1 })]))))).toHaveLength(1);
    expect(flicker(rec(seq(10, (i) => fr(i, [s({ id: 1, op: Math.min(1, i / 5) })]))))).toHaveLength(0); // an entrance
  });

  it("remount-blink: the same content on a new node that starts invisible", () => {
    const r = rec([fr(0, [s({ id: 1, key: "msg:entry-a/hi" })]), fr(1, [s({ id: 2, key: "msg:entry-a/hi", op: 0 })])]);
    expect(remountBlink(r)).toHaveLength(1);
    expect(remountBlink(rec([fr(0, [s({ id: 1, key: "msg:entry-a/hi" })]), fr(1, [s({ id: 1, key: "msg:entry-a/hi" })])]))).toHaveLength(0);
  });

  it("snap: an animated element jumping when its animation stops, but not a whole list reflowing", () => {
    expect(snap(rec([fr(0, [s({ id: 1, y: 100, anim: 1 })]), fr(1, [s({ id: 1, y: 40 })])]))).toHaveLength(1);
    const list = (y: number, anim: number) => [1, 2, 3, 4].map((id) => s({ id, y: y + id * 30, anim }));
    expect(snap(rec([fr(0, list(300, 1)), fr(1, list(130, 0))]))).toHaveLength(0);
  });

  it("double: the same entry's bubble on screen twice", () => {
    expect(doubled(rec([fr(0, [s({ id: 1, key: "bubble:entry-u1/hi" }), s({ id: 2, key: "bubble:entry-u1/hi" })])]))).toHaveLength(1);
    expect(doubled(rec([fr(0, [s({ id: 1, key: "bubble:entry-u1/hi" }), s({ id: 2, key: "bubble:entry-u2/hi" })])]))).toHaveLength(0);
  });

  it("residual: a transform, a view-transition-name or a glide class left after the motion", () => {
    expect(residual(rec([fr(0, [s({ id: 1, inTf: "translate(3px, 0px)" })])]))).toHaveLength(1);
    expect(residual(rec([fr(0, [s({ id: 1, vtn: "bot-avatar" })])]))).toHaveLength(1);
    expect(residual(rec([fr(0, [s({ id: 1, cls: "row glide-sel" })])]))).toHaveLength(1);
    expect(residual(rec([fr(0, [s({ id: 1 })])]))).toHaveLength(0);
  });

  it("hidden-too-long: a staggered child held invisible past the capped stagger", () => {
    expect(hiddenTooLong(rec(seq(20, (i) => fr(i, [s({ id: 1, op: 0, anim: 1 })]))))).toHaveLength(1);
    expect(hiddenTooLong(rec(seq(20, (i) => fr(i, [s({ id: 1, op: i < 8 ? 0 : 1, anim: 1 })]))))).toHaveLength(0); // 4 x 40ms, then in
  });

  it("restart: an entrance replayed on a node that never left", () => {
    const e = (t: number): MotionEvent => ({ t, kind: "css-start", id: 1, key: "panel:x", name: "panel-in" });
    expect(restarts(rec([], [e(0), e(300)]))).toHaveLength(1);
    expect(restarts(rec([], [e(0)]))).toHaveLength(0);
  });

  it("scroll-fight: the programmatic scroll pulling down after the user scrolled up", () => {
    const wheel: MotionEvent = { t: 0, kind: "input", name: "wheel" };
    expect(scrollFight(rec(seq(20, (i) => fr(i, [], { scroll: 500 + i * 10, scrollMax: 1000 })), [wheel]))).toHaveLength(1);
    expect(scrollFight(rec(seq(20, (i) => fr(i, [], { scroll: 500 - i * 10, scrollMax: 1000 })), [wheel]))).toHaveLength(0);
    const send: MotionEvent = { t: 50, kind: "input", name: "keydown" };
    expect(scrollFight(rec(seq(20, (i) => fr(i, [], { scroll: i < 4 ? 500 : 500 + i * 10, scrollMax: 1000 })), [wheel, send])), "a send after the scroll glides to its bubble").toHaveLength(0);
  });

  it("scroll-back: a rise and fall with no user input (phantom overflow), not a resize or a collapse", () => {
    const jiggle = [0, 49, 43, 35, 20, 4, 0].map((y, i) => fr(i, [], { scroll: y, scrollMax: y }));
    expect(scrollBack(rec(jiggle))).toHaveLength(1);
    expect(scrollBack(rec(jiggle, [{ t: 20, kind: "input", name: "pointerdown" }]))).toHaveLength(0);
    expect(scrollBack(rec([0, 49, 20].map((y, i) => fr(i, [], { scroll: y, scrollMax: y, ch: i === 2 ? 500 : 400 }))))).toHaveLength(0);
  });

  it("scroll-jump: the transcript teleporting instead of gliding", () => {
    expect(scrollJump(rec([455, 455, 455, 708, 708, 708].map((y, i) => fr(i, [], { scroll: y }))))).toHaveLength(1);
    expect(scrollJump(rec([455, 460, 480, 520, 580, 650, 700, 708].map((y, i) => fr(i, [], { scroll: y }))))).toHaveLength(0);
  });

  it("send-gap: the sent text off screen before its bubble exists (the #87 blink); quiet on the optimistic send", () => {
    const composer = (val: number, op = 1) => s({ id: 9, key: "composer-input:Message", val, op });
    const bubble = s({ id: 5, key: "bubble:entry-pending-n1/hi", cls: "bubble user", op: 0.35 });
    const gap = [fr(0, [composer(2)]), fr(1, [composer(0)]), fr(2, [composer(0)]), fr(3, [composer(0)]), fr(4, [composer(0)]), fr(5, [composer(0), bubble])];
    expect(sendGap(rec(gap))).toHaveLength(1);
    const clean = [fr(0, [composer(2)]), fr(1, [composer(0), bubble]), fr(2, [composer(0), bubble])];
    expect(sendGap(rec(clean))).toHaveLength(0);
  });

  // The send bloop's detectors (decisions.md, "send bloop"). Each fires on its regression, quiet when clean.
  const row = (id: number, entry: string, o: Partial<Sample> = {}) => s({ id, key: `msg:entry-${entry}/hi`, cls: "msg user is-new", ...o });
  const bub = (id: number, entry: string, o: Partial<Sample> = {}) => s({ id, key: `bubble:entry-${entry}/hi`, cls: "bubble user", ...o });

  it("send-no-bloop: a sent message that appeared without the bloop entrance", () => {
    const frames = [fr(0, []), fr(1, [row(4, "pending-n1")]), fr(2, [row(4, "u1")])];
    expect(sendNoBloop(rec(frames))).toHaveLength(1);
    expect(sendNoBloop(rec(frames, [{ t: 16, kind: "css-start", id: 4, name: "msg-in-right" }])), "any other entrance is not the bloop").toHaveLength(1);
    // "msg-in-user" (the smooth pass, Task 9): the send entrance's CSS keyframe name, renamed from "bloop".
    expect(sendNoBloop(rec(frames, [{ t: 16, kind: "css-start", id: 4, name: "msg-in-user" }]))).toHaveLength(0);
    const optimisticWithoutEntrance = [fr(0, []), fr(1, [row(4, "pending-n1", { cls: "msg user" })])];
    expect(sendNoBloop(rec(optimisticWithoutEntrance)), "the entrance class dropped from a sent row").toHaveLength(1);
    const history = [fr(0, []), fr(1, [row(4, "u0", { cls: "msg user" })])];
    expect(sendNoBloop(rec(history)), "history mounted by a Bot switch has no entrance").toHaveLength(0);
  });

  it("send-ghost: the optimistic bubble and the real one on screen together", () => {
    const ghost = [fr(0, []), fr(1, [bub(5, "pending-n1")]), fr(2, [bub(5, "pending-n1"), bub(6, "u1")])];
    expect(sendGhost(rec(ghost))).toHaveLength(1);
    const swap = [fr(0, []), fr(1, [bub(5, "pending-n1")]), fr(2, [bub(5, "u1")])];
    expect(sendGhost(rec(swap))).toHaveLength(0);
    const history = [fr(0, [bub(1, "u0")]), fr(1, [bub(1, "u0"), bub(5, "pending-n1")])];
    expect(sendGhost(rec(history)), "an older message with the same words is not a ghost").toHaveLength(0);
  });

  it("send-remount: the reconcile swapped in a new node instead of updating the optimistic one", () => {
    const remount = [fr(0, []), fr(1, [bub(5, "pending-n1")]), fr(2, [bub(6, "u1", { op: 0.35 })])];
    expect(sendRemount(rec(remount))).toHaveLength(1);
    const same = [fr(0, []), fr(1, [bub(5, "pending-n1")]), fr(2, [bub(5, "u1")])];
    expect(sendRemount(rec(same))).toHaveLength(0);
    const failed = [fr(0, []), fr(1, [bub(5, "pending-n1")]), fr(2, [])];
    expect(sendRemount(rec(failed)), "a failed send's bubble leaving is not a remount").toHaveLength(0);
  });

  it("send-jump: a sent bubble's foot moving far in one frame (scroll and whole-list reflow excluded)", () => {
    const at = (y: number, scroll: number, i: number) => fr(i, [bub(5, "u1", { y, h: 40 })], { scroll });
    expect(sendJump(rec([fr(0, []), at(300, 100, 1), at(260, 100, 2)]))).toHaveLength(1);
    expect(sendJump(rec([fr(0, []), at(300, 100, 1), at(294, 106, 2), at(260, 140, 3)])), "the scroll glide moves it, not a jump").toHaveLength(0);
    expect(sendJump(rec([fr(0, []), at(306, 100, 1), at(303, 100, 2), at(300, 100, 3)])), "the bloop's own 6px rise").toHaveLength(0);
    const list = (y: number, i: number) => fr(i, [bub(5, "u1", { y, h: 40 }), s({ id: 1, y: y - 100 }), s({ id: 2, y: y - 200 }), s({ id: 3, y: y - 300 })], { scroll: 0 });
    expect(sendJump(rec([fr(0, []), list(400, 1), list(360, 2)])), "the whole list reflowing together").toHaveLength(0);
  });

  it("blank (pixels): a region that holds content before and after goes empty mid-transition", () => {
    const ink = (v: number[]) => v.map((x, i) => ({ t: i * 16.7, ink: { header: x } }));
    expect(blankRegion(ink([0.15, 0.12, ...Array<number>(40).fill(0), 0.11]) /* ~650ms blank: the Bot morph */, "header")).toHaveLength(1);
    expect(blankRegion(ink([0.15, 0.1, 0.06, 0.08, 0.1, 0.11]), "header")).toHaveLength(0);
  });

  describe("the streamed reply", () => {
    const ty = (txt: number, o: Partial<Sample> = {}) => s({ id: 50, key: "bubble:Typing", cls: "bubble bot typing", txt, x: 20, y: 300, h: 40, ...o });
    const msg = (txt: number, o: Partial<Sample> = {}) => s({ id: 60, key: "bubble:entry-t9s1/Here", cls: "bubble bot", txt, x: 20, y: 300, h: 40, ...o });

    it("reply-regress: the finished text shrinking back to the typing dots", () => {
      expect(replyRegress(rec([fr(0, [ty(120)]), fr(1, [ty(0)])]))).toHaveLength(1);
      expect(replyRegress(rec([fr(0, [ty(0)]), fr(1, [ty(12)]), fr(2, [ty(40)])])), "dots growing into text").toHaveLength(0);
    });

    it("text-scaled: the reply's glyphs stretched by a morph, but not the entrance's small uniform settle", () => {
      expect(textScaled(rec([fr(0, [ty(66, { tf: "matrix(0.79, 0, 0, 1, 0, 0)" })])]))).toHaveLength(1);
      expect(textScaled(rec([fr(0, [ty(66, { tf: "matrix(0.98, 0, 0, 0.98, 0, 2)" })])]))).toHaveLength(0);
      expect(textScaled(rec([fr(0, [ty(0, { tf: "matrix(0.5, 0, 0, 1, 0, 0)" })])])), "the dots alone carry no text").toHaveLength(0);
    });

    it("reply handoff: the message replaces the stream in place, never beside it, never after a gap", () => {
      expect(replyHandoff(rec([fr(0, []), fr(1, [ty(80)]), fr(2, [msg(80)])]))).toHaveLength(0);
      expect(replyHandoff(rec([fr(0, []), fr(1, [ty(80)]), fr(2, [msg(80, { y: 330 })])]))[0]?.kind).toBe("reply-jump");
      expect(replyHandoff(rec([fr(0, []), fr(1, [ty(80)]), fr(2, [msg(80, { op: 0 })])]))[0]?.kind).toBe("reply-blank");
      expect(replyHandoff(rec([fr(0, []), fr(1, [ty(80), msg(80, { y: 350 })])]))[0]?.kind).toBe("reply-double");
      expect(replyHandoff(rec([fr(0, [msg(80, { y: 100 })]), fr(1, [ty(80), msg(80, { y: 100 })])])), "history with the same length is not a copy").toHaveLength(0);
    });
  });
});
