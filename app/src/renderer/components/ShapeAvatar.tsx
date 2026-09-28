import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AvatarClip, AvatarShape, Presence } from "@synapse/shared";
import { addTicker, avatarInteractions, avatarNow, prefersReducedMotion } from "../avatar/avatar-loop";
import { attrWriter, SUBPIXEL_PX } from "../avatar/avatar-writer";
import { FACE_VIEW_SIZE, FACE_VIEWBOX, formOf } from "../avatar/face-forms";
import { createFaceSim, DOTS_MIN_PX, EYE_INK, faceBusy, faceDrag, facePlayClip, facePoke, facePointer, faceRelease, faceTwirl, restFaceFrame, setFaceAct, setFaceClips, setFaceForm, setFaceLead, setFaceListening, setFaceLook, setFacePresence, setFaceVoice, SHADOW_MIN_PX, SHADOW_Y, stepFace, type FaceFrame, type FaceSim } from "../avatar/face-sim";
import type { LivingAct } from "../avatar/living-pose";
import { dragOffset, isDrag, type Look } from "../avatar/living-gaze";
import { joinLiving, livingRefresh, type LivingMember } from "../avatar/living-bus";

/** Touch (bug 226): how long a drag's click-swallow stays armed, and the longest a press can last. */
export const SWALLOW_MS = 300;
export const PRESS_MAX_MS = 5000;

const isWhite = (c: string) => /^#(fff|ffffff)$/i.test(c.trim());
/**
 * Task 9 fix round 1 (docs/sdd, 2026-09-23; controller ruling): a pure #FFFFFF Bot colour paints as
 * the `--bot-white` TOKEN (tokens.css: light #FFFFFF, both dark blocks #E6E6E6) rather than a colour
 * resolved at render time from a JS matchMedia/data-theme read — the first cut of this left an
 * already-mounted white avatar unrepainted on an Appearance toggle or the OS flipping scheme. Every
 * other colour is painted as-is. Covers every fill this component paints, and — because
 * GroupAvatarStack and MiniAvatars both render their members through ShapeAvatar — group stacks and
 * mini avatars for free.
 */
const resolveFill = (color: string): string => (isWhite(color) ? "var(--bot-white)" : color);

function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) || 1;
}

/**
 * BOT-17: the Synapse avatar ("Eyes + mouth" from the avatar studies). A
 * flat superellipse body in the Bot's colour with two upright capsule eyes and a small mouth, all
 * painted SOLID BLACK on every colour — never cut out. No dot above the head (the user turned the
 * spark fully off). The first paint is the rest frame; the one shared avatar loop then writes only
 * the attributes that changed (no React render per frame).
 */
export function ShapeAvatar({
  shape, color, size, className, presence = "idle", seedKey, still = false, label, clips, cue, speakingLevel = null, listening = false,
  act = "idle", lead = true, look = null, living, touch,
}: {
  shape: AvatarShape;
  color: string;
  size: number;
  className?: string;
  presence?: Presence;
  /** Stable key (a Bot id) so each avatar blinks and drifts on its own schedule, deterministically. */
  seedKey?: string;
  /** Pickers draw the rest frame only. */
  still?: boolean;
  /** Bug #55: the native hover tooltip (an SVG <title>), e.g. the Bot's current action. */
  label?: string | null;
  /** The Bot's own animations (docs/differentiators.md): played on their triggers. */
  clips?: readonly AvatarClip[];
  /** Play `name` once when `seq` rises past the value this avatar mounted with. */
  cue?: { name: string; seq: number } | null;
  /** On a call: the Bot is speaking at this level (0..1), and the mouth moves with it. null = not speaking. */
  speakingLevel?: number | null;
  /** On a call: the Bot is listening to the user, and leans in. */
  listening?: boolean;
  /** Living Bots (bug 226): the work pose (living-pose.ts). */
  act?: LivingAct;
  /** One lead at a time: false plays the pose small. */
  lead?: boolean;
  /** An outside gaze (-1..1), e.g. the call screen's glance at the speaker's seat. */
  look?: Look | null;
  /** The Bot's id: joins the living bus (the pointer nearby, the composer, the approval button, the
   *  user reading, hand-off orbs, the call's nod). */
  living?: string;
  /** Poke and drag (purely visual; a drag never becomes a click). Default: on for a living avatar. */
  touch?: boolean;
}) {
  const form = formOf(shape);
  const white = isWhite(color);
  const fill = resolveFill(color);
  const firstPresence = useRef(presence);
  const rest = useMemo(() => restFaceFrame(form, still ? presence : firstPresence.current), [form, still, presence]);
  const svg = useRef<SVGSVGElement>(null);
  const sim = useRef<FaceSim | null>(null);

  // Keep the running sim in step with props. Each change wakes this avatar to full rate (bug #100),
  // so a presence change renders even while the window is blurred and the ambient motion rests.
  const wake = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { if (sim.current) { setFacePresence(sim.current, presence); wake.current?.(); } }, [presence]);
  useLayoutEffect(() => { if (sim.current) { setFaceForm(sim.current, form); wake.current?.(); } }, [form]);
  useLayoutEffect(() => { if (sim.current) { sim.current.sizePx = size; wake.current?.(); } }, [size]);
  useLayoutEffect(() => { if (sim.current) { setFaceVoice(sim.current, speakingLevel); wake.current?.(); } }, [speakingLevel]);
  useLayoutEffect(() => { if (sim.current) { setFaceListening(sim.current, listening); wake.current?.(); } }, [listening]);
  // Living Bots: the pose, the lead, the outside look and the bus membership follow their props.
  const member = useRef<LivingMember | null>(null);
  useLayoutEffect(() => { if (sim.current) { setFaceAct(sim.current, act, avatarNow()); wake.current?.(); if (member.current) livingRefresh(); } }, [act]);
  useLayoutEffect(() => { if (sim.current) { setFaceLead(sim.current, lead); wake.current?.(); } }, [lead]);
  const lookKey = look ? `${look.nx.toFixed(2)},${look.ny.toFixed(2)}` : "";
  useLayoutEffect(() => {
    if (member.current) { member.current.base = look; livingRefresh(); }
    else if (sim.current) { setFaceLook(sim.current, look); wake.current?.(); }
  }, [lookKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (member.current && living) { member.current.botId = living; member.current.color = fill; livingRefresh(); } }, [living, fill]);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useLayoutEffect(() => { if (sim.current) setFaceClips(sim.current, clips); }, [clips]);
  // A cue seen at mount is history (a reload, a new window): only a rise after mount plays.
  const cueSeen = useRef(cue?.seq ?? 0);
  useLayoutEffect(() => {
    if (!cue || cue.seq <= cueSeen.current) return;
    cueSeen.current = cue.seq;
    const c = clips?.find((x) => x.name === cue.name);
    if (sim.current && c) { facePlayClip(sim.current, c, avatarNow()); wake.current?.(); }
  }, [cue?.seq]);

  useEffect(() => {
    if (still || !svg.current) return;
    const root = svg.current;
    const part = <T extends Element>(name: string) => root.querySelector<T & Element>(`[data-part=${name}]`)!;
    const s = createFaceSim({ form, presence, seed: seedOf(seedKey ?? `${shape}:${color}`), sizePx: size, reducedMotion: prefersReducedMotion(), startMs: avatarNow(), interactions: avatarInteractions() });
    setFaceVoice(s, speakingLevel);
    setFaceListening(s, listening);
    setFaceAct(s, act, avatarNow());
    setFaceLead(s, lead);
    if (!living) setFaceLook(s, look);
    sim.current = s;
    setFaceClips(s, clips);
    const rig = part<SVGGElement>("rig"), bodyG = part<SVGGElement>("body"), bodyD = part<SVGPathElement>("body-d");
    const faceG = part<SVGGElement>("face"), eyesG = part<SVGGElement>("eyes");
    const eyes = [part<SVGRectElement>("eye0"), part<SVGRectElement>("eye1")];
    const arcs = [part<SVGPathElement>("arc0"), part<SVGPathElement>("arc1")];
    const mouthG = part<SVGGElement>("mouth"), mLine = part<SVGPathElement>("mouth-line"), mFill = part<SVGPathElement>("mouth-fill");
    const shadow = root.querySelector<SVGEllipseElement>("[data-part=shadow]");
    const dots = root.querySelector<SVGPathElement>("[data-part=dots]");
    let near = -1;
    // Bug #100: only what changed is written (sub-pixel geometry skipped), see avatar-writer.ts.
    const w = attrWriter();
    const apply = (f: FaceFrame) => {
      w.begin(SUBPIXEL_PX * (FACE_VIEW_SIZE / Math.max(1, s.sizePx)));
      w.set(rig, "transform", f.rig, "geo");
      w.set(rig, "opacity", f.opacity.toFixed(3), "op");
      w.set(bodyG, "transform", f.body, "geo");
      w.set(bodyD, "transform", f.sil, "geo");
      w.set(bodyD, "d", f.bodyD);
      if (shadow) w.set(shadow, "transform", f.shadow, "geo");
      if (dots) { w.set(dots, "d", f.dots); w.set(dots, "opacity", f.dotsOp.toFixed(2), "op"); }
      w.set(faceG, "visibility", f.face ? "visible" : "hidden");
      w.set(faceG, "transform", f.faceT, "geo");
      w.set(eyesG, "transform", f.eyesT, "geo");
      // Depth order: the near eye draws over the far one (moved only when it changes).
      if (f.near !== near) { near = f.near; eyesG.appendChild(eyes[near]!); eyesG.appendChild(arcs[near]!); }
      f.eyes.forEach((e, i) => {
        const r = eyes[i]!, a = arcs[i]!;
        if (e.arc) { w.set(r, "visibility", "hidden"); w.set(a, "d", e.arc); w.set(a, "visibility", e.on ? "visible" : "hidden"); return; }
        w.set(a, "visibility", "hidden");
        w.set(r, "visibility", e.on ? "visible" : "hidden");
        w.set(r, "x", String(e.x), "geo"); w.set(r, "y", String(e.y), "geo");
        w.set(r, "width", String(e.w), "geo"); w.set(r, "height", String(e.h), "geo"); w.set(r, "rx", String(e.rx), "geo");
      });
      w.set(mouthG, "transform", f.mouth.t, "geo");
      w.set(mouthG, "visibility", f.mouth.on ? "visible" : "hidden");
      w.set(mLine, "d", f.mouth.line);
      w.set(mFill, "d", f.mouth.fill);
      w.set(root, "data-mouth", f.mouth.kind);
      w.set(root, "data-mood", f.debug.mood);
      w.set(root, "data-clip", f.debug.clip ?? "");
      w.set(root, "data-act", f.debug.act);
    };
    // The ticker reports BUSY (a transition is playing) so the loop keeps it at the display rate;
    // calm, it ticks at the ambient rate (avatar-loop.ts).
    const off = addTicker((now) => { apply(stepFace(s, now)); return faceBusy(s, now); }, root);
    wake.current = off.wake;
    // [designed] interactions. Native listeners that only OBSERVE: nothing here stops propagation or
    // prevents a default, so an avatar inside a clickable row never takes the row's click.
    const at = (e: Event) => {
      const b = root.getBoundingClientRect(), p = e as PointerEvent;
      const n = (v: number, o: number, wd: number) => (wd > 0 && Number.isFinite(v) ? ((v - o) / wd) * 2 - 1 : 0);
      return [n(p.clientX, b.left, b.width), n(p.clientY, b.top, b.height)] as const;
    };
    const over = (e: Event) => { const [x, y] = at(e); facePointer(s, true, x, y, avatarNow()); off.wake(); };
    const leave = () => { facePointer(s, false, 0, 0, avatarNow()); off.wake(); };
    const click = () => { faceTwirl(s, avatarNow()); off.wake(); };
    root.addEventListener("pointerenter", over);
    root.addEventListener("pointermove", over);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("click", click);
    // Living Bots: the bus (gaze, reading, hand-offs, nods) for an avatar that names its Bot.
    const leaveBus = living ? (() => {
      const m: LivingMember = { botId: living, el: root, sim: s, wake: () => off.wake(), color: fill, base: look };
      member.current = m;
      const bye = joinLiving(m);
      return () => { bye(); member.current = null; };
    })() : () => {};
    // Touch: a press pokes (squash, squint); moving DRAG_SLOP_PX turns it into a drag that follows the
    // pointer on a rubber band and springs home on release. A drag swallows the ONE click that follows
    // on this avatar's own row or button (never anywhere else, and only for SWALLOW_MS), so it can never
    // open a row or a panel; a plain press still clicks through as before. Listeners on the window only
    // while pressed, ended by pointerup, pointercancel, lostpointercapture or a PRESS_MAX_MS safety
    // timer, so a press can never stay stuck; nothing here prevents a press's default.
    const touchOn = touch ?? Boolean(living);
    let press: { x: number; y: number; id: number; drag: boolean } | null = null;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let swallowTimer: ReturnType<typeof setTimeout> | null = null;
    const owner = (): Element => root.closest("a, button, [role=button], [role=listitem], .row, .tile") ?? root;
    const unswallow = () => {
      if (swallowTimer) { clearTimeout(swallowTimer); swallowTimer = null; }
      window.removeEventListener("click", swallow, true);
    };
    const swallow = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || !owner().contains(t)) return; // an unrelated click is never touched
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      unswallow();
    };
    const noNativeDrag = (e: Event) => { if (press) e.preventDefault(); };
    const endPress = () => {
      press = null;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      window.removeEventListener("pointermove", moveP, true);
      window.removeEventListener("pointerup", upP, true);
      window.removeEventListener("pointercancel", cancelP, true);
      window.removeEventListener("lostpointercapture", lostP, true);
      window.removeEventListener("dragstart", noNativeDrag, true);
    };
    const moveP = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!press.drag && isDrag(dx, dy)) press.drag = true;
      if (!press.drag) return;
      const z = Math.max(1, sizeRef.current), o = dragOffset(dx, dy, z), u = FACE_VIEW_SIZE / z;
      faceDrag(s, o.x * u, o.y * u); off.wake();
    };
    const upP = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      if (press.drag) {
        faceRelease(s, avatarNow()); off.wake();
        unswallow();
        window.addEventListener("click", swallow, true);
        swallowTimer = setTimeout(unswallow, SWALLOW_MS);
      }
      endPress();
    };
    const cancelP = () => { if (press?.drag) { faceRelease(s, avatarNow()); off.wake(); } endPress(); };
    const lostP = (e: PointerEvent) => { if (press && e.pointerId === press.id) cancelP(); };
    const downP = (e: PointerEvent) => {
      if (!touchOn || e.button !== 0 || !avatarInteractions() || press) return;
      press = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false };
      facePoke(s, avatarNow()); off.wake();
      window.addEventListener("pointermove", moveP, true);
      window.addEventListener("pointerup", upP, true);
      window.addEventListener("pointercancel", cancelP, true);
      window.addEventListener("lostpointercapture", lostP, true);
      window.addEventListener("dragstart", noNativeDrag, true);
      pressTimer = setTimeout(cancelP, PRESS_MAX_MS);
    };
    root.addEventListener("pointerdown", downP);
    return () => {
      off(); sim.current = null; wake.current = null;
      leaveBus(); endPress(); unswallow();
      root.removeEventListener("pointerenter", over); root.removeEventListener("pointermove", over);
      root.removeEventListener("pointerleave", leave); root.removeEventListener("click", click);
      root.removeEventListener("pointerdown", downP);
    };
    // The sim is created once per mount; later prop changes flow through the layout effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);

  const bodyCls = white ? "avatar-body avatar-body-white" : "avatar-body";
  return (
    <svg ref={svg} width={size} height={size} viewBox={FACE_VIEWBOX} aria-hidden="true"
      className={["face-avatar", className].filter(Boolean).join(" ")} data-form={form} data-mouth={rest.mouth.kind} data-mood={rest.debug.mood}
      style={{ flexShrink: 0, overflow: "visible" }}>
      {label ? <title>{label}</title> : null}
      {/* Soft 3D grounding: a flat contact shadow (#000 at 10%, no gradient or blur), only at >= 48 px. */}
      {size >= SHADOW_MIN_PX ? <ellipse data-part="shadow" className="avatar-shadow" cx={50} cy={SHADOW_Y} rx={23} ry={2.4} fill="#000" opacity={0.1} transform={rest.shadow} /> : null}
      <g data-part="rig" transform={rest.rig}>
        <g data-part="body" transform={rest.body}>
          <path data-part="body-d" className={bodyCls} d={rest.bodyD} fill={fill} transform={rest.sil} />
          <g data-part="face" visibility="visible" transform={rest.faceT}>
            <g data-part="eyes" transform={rest.eyesT}>
              {rest.eyes.map((e, i) => (
                <rect key={i} data-part={`eye${i}`} className="avatar-eye" fill={EYE_INK} x={e.x} y={e.y} width={e.w} height={e.h} rx={e.rx} visibility={e.arc ? "hidden" : "visible"} />
              ))}
              {rest.eyes.map((e, i) => (
                <path key={i} data-part={`arc${i}`} className="avatar-eye" fill="none" stroke={EYE_INK} strokeWidth={3.4} strokeLinecap="round" d={e.arc} visibility={e.arc ? "visible" : "hidden"} />
              ))}
            </g>
            <g data-part="mouth" transform={rest.mouth.t}>
              <path data-part="mouth-line" className="avatar-mouth" fill="none" stroke={EYE_INK} strokeWidth={2.6} strokeLinecap="round" d={rest.mouth.line} />
              <path data-part="mouth-fill" className="avatar-mouth" fill={EYE_INK} d={rest.mouth.fill} />
            </g>
          </g>
        </g>
        {/* Living Bots: the remembering dots, in the muted ink (>= 30 px only). */}
        {size >= DOTS_MIN_PX && !still ? <path data-part="dots" className="avatar-dots" d="" fill="var(--ink-muted)" opacity={0} /> : null}
      </g>
    </svg>
  );
}
