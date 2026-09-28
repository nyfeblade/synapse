// The Synapse avatar: "Eyes + mouth", the user's pick from the avatar studies (option 3). A pure,
// per-avatar simulation: given the time it returns a frame of plain numbers and path strings, and
// the renderer (components/ShapeAvatar.tsx) writes only what changed. No DOM, no clock, a seeded RNG,
// so a test drives it frame by frame.
//
// Design: "Nodes" (superellipse bodies, jelly squash that keeps
// area, the app's water springs) and the studies' makeAvatar (body, eye row, blink, gaze, the mouth
// states, the hop and the breathing). Every mark on the face is SOLID BLACK ink on every body colour
// (the user's rule): nothing is ever cut out of the body.
//
// Soft 3D (the user, 2026-09-23: "more 3d in all of their motions and actions"): every state is a
// pose of a SOLID head in space — volume from form and motion, never shading (no gradient, glow or
// blur; the body stays one flat colour). The head yaws and pitches (`project3d`): the face is painted
// on a curved front and turns about an axis behind the body's centre, so it travels across the body
// with parallax (further than the silhouette), the eye on the side it turns toward narrows as it goes
// round the limb while the other widens slightly, the mouth foreshortens, the silhouette compresses to
// a thick pebble edge-on, and a feature past its limb is hidden. Gaze and hover drive the head (the
// eyes lead a little), each state holds a pose (thinking up-and-aside, working down with small scans,
// speaking nods with the voice, listening leans in, idle drifts round the rest turn), the happy hop
// crouches, stretches pitched up and lands with weight, and the click twirl is a true 360° yaw.
// Small avatars move less (`faceAmp`).
//
// Motion model:
//  - ambient (the loop ticks it at <= 30 fps, avatar-loop.ts): breathing, the idle drift, blinks;
//  - transitions (full display rate while they play, `faceBusy`): a presence change, the finish
//    celebration, hops and squash, the twirl, a Bot-authored clip, speaking.
// No spark: the user turned the dot above the head fully off (2026-09-22).
// Reduced motion: no breathing, drift, head poses, blinks, hops, twirls or clips (a brief opacity dip
// instead); the head holds the rest pose and the face still changes expression so the state reads.
//
// Living Bots (bug 226): on top of presence, a work pose (`setFaceAct`: think, read, write, browse,
// run, needs-you, stuck, remember, rest; living-pose.ts maps the tool stream to one), an outside gaze
// target (`setFaceLook`: the pointer nearby, the composer, the approval button, a speaker's seat),
// touch (`facePoke`, `faceDrag`/`faceRelease`), the hand-off catch and the call's nod. A pose's small
// loops (the line scan, the type bounce, the hum, the foot tap) run at the ambient rate and only while
// the Bot leads (`setFaceLead`) at full size; `setFaceQuiet` (the user is reading) holds them still.
// Still no shading: the body stays one flat colour; depth is form and motion only.

import { ANIM_REST, sampleClip, type AvatarClip, type AvatarPose, type Presence } from "@synapse/shared";
import { BASE_Y, FACE_VIEW_SIZE, PIVOT, formPath, type FaceForm } from "./face-forms";
import type { LivingAct } from "./living-pose";

/** Every eye and mouth, on every body colour. */
export const EYE_INK = "#111110";
/** The smooth pass: at rest (idle, no pointer, no clip) the head is yawed this much (radians, ~9°)
 *  toward the chat, so the form reads even at 22px in the sidebar — depth from form and motion, never
 *  shading. Hover, a clip, listening or the click twirl override it. */
export const REST_TURN = 0.16;

export type FaceMood = "idle" | "thinking" | "working";
export type MouthKind = "smile" | "hmm" | "speak" | "open" | "o";
const MOOD_OF: Record<Presence, FaceMood> = { idle: "idle", thinking: "thinking", searching: "thinking", loading: "thinking", orbit: "thinking", working: "working", sending: "working" };

// ---------- the face's geometry (viewBox units; the body is 64 wide) ----------
const EYE_Y = 52, EYE_DX = 10.5, EYE_W = 6.4, EYE_H = 13, EYE_SHUT = 1.3;
const MOUTH_Y = 67.5;
/** Bot-authored clips give x/y in % of the avatar's size (the frame, FACE_VIEW_SIZE units). */
const CLIP_UNIT = FACE_VIEW_SIZE / 100;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const f2 = (v: number) => (Math.round(v * 100) / 100 || 0).toString();
const f4 = (v: number) => (Math.round(v * 10000) / 10000 || 0).toString();

// ---------- the solid head (soft 3D) ----------
/** Horizontal curvature of the face (the radius the eyes sit round) and how far behind the body's
 *  centre the turning axis is: the face travels (RF + ZA)·sin(yaw), the silhouette only ZA·sin(yaw). */
const RF = 18, ZA = 4;
/** Vertical curvature about the pivot row, and the pitch axis's depth. */
const RFV = 26, ZAV = 3;
const YC = PIVOT[1];
/** The body's depth as a fraction of its width: edge-on the silhouette is this wide (a thick pebble,
 *  not a card). */
export const SIL_DEPTH = 0.55;
const SIL_DEPTH_V = 0.8;
/** Where each feature sits round the head (sin and cos of its angle from the front). */
const SIN_A_EYE = EYE_DX / RF, COS_A_EYE = Math.sqrt(1 - SIN_A_EYE * SIN_A_EYE);
const SIN_B_EYE = (EYE_Y - YC) / RFV, COS_B_EYE = Math.sqrt(1 - SIN_B_EYE * SIN_B_EYE);
const SIN_B_MOUTH = (MOUTH_Y - YC) / RFV, COS_B_MOUTH = Math.sqrt(1 - SIN_B_MOUTH * SIN_B_MOUTH);

/** The head's projection at a yaw and pitch (radians; +yaw turns the face toward +x, +pitch looks
 *  down). Positions are absolute viewBox units; factors are relative to the square-on face. */
export interface Projection {
  /** The face's travel across the body, and the silhouette's own (smaller) shift: parallax. */
  dx: number; dy: number; bodyDx: number;
  silX: number; silY: number;
  eyeX: [number, number]; eyeWF: [number, number]; eyeOn: [boolean, boolean]; eyeY: number; eyeHF: number;
  mouthY: number; mouthSX: number; mouthSY: number; mouthOn: boolean;
  /** The eye nearer the viewer (drawn over the other). */
  near: 0 | 1;
}
export const newProjection = (): Projection => ({ dx: 0, dy: 0, bodyDx: 0, silX: 1, silY: 1, eyeX: [0, 0], eyeWF: [1, 1], eyeOn: [true, true], eyeY: EYE_Y, eyeHF: 1, mouthY: MOUTH_Y, mouthSX: 1, mouthSY: 1, mouthOn: true, near: 0 });
/** Pure and allocation-free: writes into `P`. Yaw and pitch are treated separably (pitch stays small).
 *  A feature is visible while its own surface still faces the viewer, so in a turn the far eye leaves
 *  first, then the mouth (at 90°), then the near eye. */
export function project3d(yaw: number, pitch: number, P: Projection): Projection {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  P.dx = (RF + ZA) * sy || 0; P.bodyDx = ZA * sy || 0;
  P.dy = (RFV + ZAV) * sp || 0;
  P.silX = Math.sqrt(cy * cy + SIL_DEPTH * SIL_DEPTH * sy * sy);
  P.silY = Math.sqrt(cp * cp + SIL_DEPTH_V * SIL_DEPTH_V * sp * sp);
  // Angle sums from the precomputed feature angles: no trig per feature (the tick budget).
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -SIN_A_EYE : SIN_A_EYE, sa = s * cy + COS_A_EYE * sy, c = COS_A_EYE * cy - s * sy;
    P.eyeX[i] = 50 + RF * sa + ZA * sy;
    P.eyeOn[i] = c > 0.02;
    P.eyeWF[i] = Math.max(0, c) / COS_A_EYE;
  }
  P.near = P.eyeWF[0] >= P.eyeWF[1] ? 0 : 1;
  P.eyeY = YC + RFV * (SIN_B_EYE * cp + COS_B_EYE * sp) + ZAV * sp;
  P.eyeHF = Math.max(0, COS_B_EYE * cp - SIN_B_EYE * sp) / COS_B_EYE;
  P.mouthY = YC + RFV * (SIN_B_MOUTH * cp + COS_B_MOUTH * sp) + ZAV * sp;
  P.mouthSY = Math.max(0, COS_B_MOUTH * cp - SIN_B_MOUTH * sp) / COS_B_MOUTH;
  P.mouthSX = Math.max(0, cy);
  P.mouthOn = cy > 0.02;
  return P;
}

/** Ambient pose amplitude by size: a 22 px sidebar avatar moves a bit under half as much, >= 48 px fully.
 *  The twirl is a full turn at every size. */
export function faceAmp(sizePx: number): number { return clamp(0.45 + (0.55 * (sizePx - 22)) / 26, 0.45, 1); }
/** Head yaw and pitch (radians) per unit of gaze (viewBox units): the head follows where it looks. */
const YAW_PER_GAZE = 0.07, PITCH_PER_GAZE = 0.05;
/** The eyes still lead the head a little inside the face. */
const EYE_SLIDE = 0.45;
/** The contact shadow's row, just under the base line, and the smallest avatar that draws it. */
export const SHADOW_Y = BASE_Y + 1.5;
export const SHADOW_MIN_PX = 48;

// ---------- springs ----------
interface Spring { x: number; v: number; t: number; w: number; z: number }
const spring = (x: number, w: number, z: number): Spring => ({ x, v: 0, t: x, w, z });
/** Semi-implicit Euler in <= 1/120 s substeps: stable for every constant here at any frame rate. */
function stepSpring(s: Spring, dt: number): void {
  // At rest on its target: nothing to integrate (most springs, most ambient frames — the tick budget).
  if (Math.abs(s.x - s.t) < 1e-5 && Math.abs(s.v) < 1e-4) { s.x = s.t; s.v = 0; return; }
  let left = Math.min(dt, 0.1);
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 120);
    s.v += (-s.w * s.w * (s.x - s.t) - 2 * s.z * s.w * s.v) * h;
    s.x += s.v * h;
    left -= h;
  }
}
const settled = (s: Spring, eps = 2e-3) => Math.abs(s.x - s.t) < eps && Math.abs(s.v) < eps * 10;
const snap = (s: Spring) => { s.x = s.t; s.v = 0; };
// The app's glide water spring (motion.ts SPRINGS) for every change of expression.
const GLIDE = [12.5, 0.716] as const;
/** The head's springs: the same feel (ζ ~0.7, a small overshoot), a touch slower than the eyes. */
const HEAD = [8, 0.68] as const;
/** Touch: a dragged avatar follows the pointer closely, and springs back with a jelly wobble. */
const DRAG_FOLLOW = [34, 1] as const, DRAG_BACK = [15, 0.38] as const;
/** Living Bots: a non-lead Bot plays its pose's loops this much smaller (one lead at a time). */
export const SUPPORT_AMP = 0.45;
/** The needs-you foot tap: one small hop every 1.4 s while the Bot waits (the lead only). */
export const TAP_EVERY_MS = 1400;
const TAP_HOP: Hop = { h: 0.9, d: 0.16 };
/** Hover keeps a resting Bot awake this long after the pointer leaves. */
const WAKE_MS = 20_000;
/** The remembering dots: orbit, then settle into a row, then fade (s). Only at >= this size. */
export const DOTS_MIN_PX = 30;
const DOTS_SETTLE = 1.3, DOTS_FADE = 1.9, DOTS_GONE = 2.3;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the designed interactions ----------
/** h: height, d: flight (s), a: the anticipation crouch before take-off (s). */
interface Hop { h: number; d: number; a?: number }
// Heights in viewBox units (72 across): at 36 px a unit is half a pixel.
const HOVER_HOP: Hop = { h: 2.2, d: 0.26 }, STATE_HOP: Hop = { h: 1.5, d: 0.26 }, TWIRL_HOP: Hop = { h: 2.4, d: 0.3 };
const CELEBRATE_HOPS: Hop[] = [{ h: 5.4, d: 0.36, a: 0.1 }, { h: 2.1, d: 0.24 }];
const CELEBRATE_MS = 1400;
const BLINK_MS = 150;

export interface FaceSimOptions {
  form: FaceForm; presence: Presence; seed: number; sizePx: number; reducedMotion: boolean; startMs: number;
  /** Hover, click twirl, presence hop, celebrate. Default on. */
  interactions?: boolean;
}
interface Springs { hap: Spring; wide: Spring; mk: Spring; gx: Spring; gy: Spring; level: Spring; squash: Spring; twirl: Spring; lid0: Spring; lid1: Spring; rest: Spring; yaw: Spring; pitch: Spring; nod: Spring; roll: Spring; lean: Spring; lidAct: Spring; dragX: Spring; dragY: Spring }
export interface FaceSim {
  form: FaceForm; sizePx: number; rm: boolean; rng: () => number; phase: number;
  interactions: boolean;
  mount: number; last: number; entered: boolean;
  presence: Presence; mood: FaceMood; pending: Presence | null; stateStart: number;
  voice: number | null; listening: boolean;
  sp: Springs;
  /** The springs eased every frame, and the ones `faceBusy` waits on (built once: no per-frame array). */
  eased: Spring[]; calm: Spring[];
  /** The head's projection, reused every frame. */
  P: Projection;
  /** The hop under way: flight progress 0..1 (-1 none), its height, and the crouch 0..1. */
  hopP: number; hopH: number; hopAnt: number;
  /** Strings that stay the same frame after frame at rest, kept with the numbers they were built from
   *  (formatting numbers is most of a tick): the mouth line, the body and the rig. */
  memo: { m: number; line: string; bx: number; by: number; body: string; rx: number; ry: number; rt: number; rs: number; rig: string };
  nextBlink: number; blinkAt: number; happyUntil: number;
  hops: Hop[]; hopT0: number; twirling: boolean; twirlHopped: boolean;
  hover: { nx: number; ny: number } | null; lastHover: number; fadeT0: number;
  clips: AvatarClip[]; clip: { c: AvatarClip; t0: number } | null; pose: AvatarPose;
  /** Living Bots: the work pose and when it began; lead: full-size pose loops (else small, no tap). */
  act: LivingAct; actStart: number; lead: boolean; quiet: boolean;
  /** An outside gaze target (-1..1), under the pointer's own hover. */
  look: { nx: number; ny: number } | null;
  /** Touch: the squint of a poke or a catch, the drag under way (viewBox units), and rest woken by hover. */
  squintT0: number; squintMs: number; dragging: boolean; wokeUntil: number; nextTap: number;
}

export interface EyeDraw { x: number; y: number; w: number; h: number; rx: number; /** happy: an arch drawn as a stroke; "" = the capsule */ arc: string; /** false once it has gone round its limb */ on: boolean }
export interface FaceFrame {
  /** On the whole avatar: offset, hop, tilt (clip tilt plus the head's roll) and the lean in. */
  rig: string;
  /** On the body and face: squash and the voice swell, anchored at the base line. */
  body: string;
  /** On the body's outline only: the silhouette under yaw and pitch (compressed, shifted toward the
   *  turn) and breathing — the face is not scaled by it. */
  sil: string;
  bodyD: string;
  /** The flat contact shadow under the body (drawn only at >= 48 px): its offset and width. */
  shadow: string;
  opacity: number;
  /** False while a turn has the whole face round the back of the head. */
  face: boolean;
  /** The face's travel across the body under yaw and pitch (parallax). */
  faceT: string;
  /** The gaze: the eyes' small lead inside the face. */
  eyesT: string;
  eyes: [EyeDraw, EyeDraw];
  /** The eye nearer the viewer; it draws over the far one. */
  near: 0 | 1;
  /** t: the mouth's place and foreshortening; on: false once it is round the back. */
  mouth: { kind: MouthKind; line: string; fill: string; t: string; on: boolean };
  /** turn: the coin spin (in turns) plus the rest turn, as before; yaw/pitch: the head's pose
   *  (radians); tilt: degrees; lean: the scale toward the viewer. */
  /** Living Bots: the remembering dots (one path, "" when none) and their opacity. */
  dots: string; dotsOp: number;
  debug: { mood: FaceMood; act: LivingAct; hop: number; squash: number; turn: number; yaw: number; pitch: number; tilt: number; lean: number; x: number; y: number; gaze: [number, number]; level: number; clip: string | null; lid: number };
}

const rand = (sim: FaceSim, a: number, b: number) => a + sim.rng() * (b - a);

export function createFaceSim(o: FaceSimOptions): FaceSim {
  const rng = mulberry32(o.seed);
  const mood = MOOD_OF[o.presence] ?? "idle";
  const sp: Springs = {
    hap: spring(0, ...GLIDE), wide: spring(0, ...GLIDE), mk: spring(mood === "idle" ? 0 : 1, ...GLIDE),
    gx: spring(0, 9, 0.85), gy: spring(0, 9, 0.85),
    level: spring(0, 30, 1), squash: spring(0, 22, 0.5), twirl: spring(0, 7.2, 0.68),
    lid0: spring(1, 30, 1), lid1: spring(1, 30, 1), rest: spring(mood === "idle" ? REST_TURN : 0, ...GLIDE),
    yaw: spring(0, ...HEAD), pitch: spring(0, ...HEAD), nod: spring(0, 14, 0.7), roll: spring(0, ...HEAD), lean: spring(1, ...GLIDE),
    lidAct: spring(1, ...GLIDE), dragX: spring(0, ...DRAG_FOLLOW), dragY: spring(0, ...DRAG_FOLLOW),
  };
  const sim: FaceSim = {
    form: o.form, sizePx: o.sizePx, rm: o.reducedMotion, rng, phase: rng() * 100,
    interactions: o.interactions ?? true,
    mount: o.startMs, last: o.startMs, entered: false,
    presence: o.presence, mood, pending: null, stateStart: o.startMs,
    voice: null, listening: false,
    sp,
    eased: [sp.hap, sp.wide, sp.mk, sp.gx, sp.gy, sp.level, sp.lid0, sp.lid1, sp.rest, sp.yaw, sp.pitch, sp.nod, sp.roll, sp.lean, sp.lidAct],
    calm: [sp.hap, sp.wide, sp.mk, sp.level, sp.lid0, sp.lid1, sp.rest, sp.roll, sp.lean, sp.lidAct],
    P: newProjection(), hopP: -1, hopH: 0, hopAnt: 0,
    memo: { m: NaN, line: "", bx: NaN, by: NaN, body: "", rx: NaN, ry: NaN, rt: NaN, rs: NaN, rig: "" },
    nextBlink: Infinity, blinkAt: -Infinity, happyUntil: -Infinity,
    hops: [], hopT0: 0, twirling: false, twirlHopped: false,
    hover: null, lastHover: -Infinity, fadeT0: -Infinity,
    clips: [], clip: null, pose: ANIM_REST,
    act: "idle", actStart: o.startMs, lead: true, quiet: false, look: null,
    squintT0: -Infinity, squintMs: 0, dragging: false, wokeUntil: -Infinity, nextTap: Infinity,
  };
  sim.nextBlink = o.startMs + rand(sim, 2500, 4500);
  return sim;
}

export function setFacePresence(sim: FaceSim, p: Presence): void { if (p !== sim.presence || sim.pending) sim.pending = p; }
export function setFaceForm(sim: FaceSim, form: FaceForm): void { sim.form = form; }
/** The Bot is speaking at `level` (0..1), or not speaking (null). */
export function setFaceVoice(sim: FaceSim, level: number | null): void {
  sim.voice = level === null || !Number.isFinite(level) ? null : clamp(level);
}
/** On a call, the Bot is listening to the user: it leans in and faces them. */
export function setFaceListening(sim: FaceSim, on: boolean): void { sim.listening = on; }
export function setFaceClips(sim: FaceSim, clips: readonly AvatarClip[] | undefined): void { sim.clips = clips ? [...clips] : []; }

/** Living Bots: the work pose. A change restarts its clock (the scan's first line, the shake). */
export function setFaceAct(sim: FaceSim, act: LivingAct, now = sim.last): void {
  if (act === sim.act) return;
  sim.act = act; sim.actStart = now;
  sim.nextTap = act === "needs-you" ? now + TAP_EVERY_MS : Infinity;
}
/** One lead at a time: false plays the pose's loops small, with no foot tap. */
export function setFaceLead(sim: FaceSim, lead: boolean): void { sim.lead = lead; }
/** The user is reading a long reply: the pose holds still (no loops, no drift, no breathing). */
export function setFaceQuiet(sim: FaceSim, quiet: boolean): void { sim.quiet = quiet; }
/** An outside gaze target, -1..1 on each axis (null: none). The pointer's own hover wins over it. */
export function setFaceLook(sim: FaceSim, look: { nx: number; ny: number } | null): void {
  sim.look = look && Number.isFinite(look.nx) && Number.isFinite(look.ny) ? { nx: clamp(look.nx, -1, 1), ny: clamp(look.ny, -1, 1) } : null;
}
/** A poke (a press on the avatar): squash and a squint. Reduced motion: the opacity dip. */
export function facePoke(sim: FaceSim, now: number): void {
  if (!sim.interactions) return;
  if (sim.act === "rest") sim.wokeUntil = now + WAKE_MS;
  if (sim.rm) { sim.fadeT0 = now; return; }
  sim.sp.squash.v += 2.6; sim.squintT0 = now; sim.squintMs = 260;
}
/** Dragged `dx, dy` (viewBox units, already rubber-banded). Reduced motion: the avatar stays put. */
export function faceDrag(sim: FaceSim, dx: number, dy: number): void {
  if (!sim.interactions || sim.rm) return;
  const { dragX, dragY } = sim.sp;
  if (!sim.dragging) { sim.dragging = true; [dragX.w, dragX.z] = DRAG_FOLLOW; [dragY.w, dragY.z] = DRAG_FOLLOW; }
  dragX.t = Number.isFinite(dx) ? dx : 0; dragY.t = Number.isFinite(dy) ? dy : 0;
}
/** Let go: it springs home with a wobble and lands with a little squash. */
export function faceRelease(sim: FaceSim, now: number): void {
  if (!sim.dragging) return;
  sim.dragging = false;
  const { dragX, dragY } = sim.sp;
  [dragX.w, dragX.z] = DRAG_BACK; [dragY.w, dragY.z] = DRAG_BACK;
  dragX.t = 0; dragY.t = 0;
  sim.sp.squash.v += 1.6; sim.squintT0 = now; sim.squintMs = 160;
}
/** A hand-off's orb arrives: the receiver catches it (a squash and a blink-quick squint). */
export function faceCatch(sim: FaceSim, now: number): void {
  if (!sim.interactions) return;
  if (sim.rm) { sim.fadeT0 = now; return; }
  sim.sp.squash.v += 2.1; sim.squintT0 = now; sim.squintMs = 200;
}
/** A nod (the call's "Mm"): a quick dip of the head. Reduced motion: nothing moves. */
export function faceNod(sim: FaceSim): void {
  if (!sim.interactions || sim.rm) return;
  sim.sp.nod.v += 2.2;
}

/** Play one clip from `now`. Reduced motion: the opacity dip instead, never the clip. */
export function facePlayClip(sim: FaceSim, clip: AvatarClip, now: number): void {
  if (!sim.interactions) return;
  if (sim.rm) { sim.fadeT0 = now; return; }
  sim.twirling = false; sim.sp.twirl.x = sim.sp.twirl.t = sim.sp.twirl.v = 0; sim.hops = [];
  sim.clip = { c: clip, t0: now };
}
/** Pointer over the avatar; nx, ny in [-1, 1] from its centre. Entering hops (at most every 700 ms). */
export function facePointer(sim: FaceSim, on: boolean, nx = 0, ny = 0, now = sim.last): void {
  if (!sim.interactions) return;
  if (on && !sim.hover && now - sim.lastHover > 700) { sim.lastHover = now; if (!sim.rm) playHops(sim, [HOVER_HOP], now); }
  sim.hover = on ? { nx: clamp(Number.isFinite(nx) ? nx : 0, -1, 1), ny: clamp(Number.isFinite(ny) ? ny : 0, -1, 1) } : null;
}
/** Click: one full yaw on an underdamped spring (slight overshoot), then a hop; or the Bot's click clip. */
export function faceTwirl(sim: FaceSim, now: number): void {
  if (!sim.interactions) return;
  if (sim.rm) { sim.fadeT0 = now; return; }
  const own = sim.clips.find((c) => c.on === "click");
  if (own) { facePlayClip(sim, own, now); return; }
  if (sim.twirling) return;
  const s = sim.sp.twirl;
  s.x = 0; s.v = 0; s.t = sim.rng() < 0.5 ? -1 : 1;
  sim.twirling = true; sim.twirlHopped = false;
}

function playHops(sim: FaceSim, hops: Hop[], now: number): void { sim.hops = hops.slice(); sim.hopT0 = now; }
/** y = -4h·p(1-p) along the queue, after the hop's crouch; each landing kicks the squash spring (jelly,
 *  weight). Leaves the flight progress and the crouch on the sim (no allocation). */
function hopValue(sim: FaceSim, now: number): number {
  sim.hopP = -1; sim.hopAnt = 0;
  while (sim.hops.length) {
    const hp = sim.hops[0]!, a = hp.a ?? 0, el = (now - sim.hopT0) / 1000;
    if (el >= a + hp.d) { sim.hops.shift(); sim.hopT0 += (a + hp.d) * 1000; sim.sp.squash.v += Math.min(1.4 * hp.h, 3.4); continue; }
    sim.hopH = hp.h;
    if (el < a) { sim.hopAnt = Math.sin(((el / a) * Math.PI) / 2); return 0; }
    const p = (el - a) / hp.d;
    sim.hopP = p;
    return -4 * hp.h * p * (1 - p);
  }
  return 0;
}

function enterState(sim: FaceSim, now: number): void {
  const to = sim.pending!;
  sim.pending = null;
  const from = sim.presence;
  sim.presence = to;
  const mood = MOOD_OF[to] ?? "idle";
  const wasMood = sim.mood;
  sim.mood = mood;
  sim.stateStart = now;
  if (from === to) return;
  if (wasMood === "working" && mood === "idle") {
    const own = sim.clips.find((c) => c.on === "task_done");
    if (own && sim.interactions) { facePlayClip(sim, own, now); return; }
    sim.happyUntil = now + CELEBRATE_MS;
    if (!sim.interactions) return;
    if (sim.rm) { sim.fadeT0 = now; return; }
    playHops(sim, CELEBRATE_HOPS, now);
    return;
  }
  if (!sim.interactions) return;
  if (sim.rm) { sim.fadeT0 = now; return; }
  if (!sim.hops.length) playHops(sim, [STATE_HOP], now);
}

const LOOK: Partial<Record<AvatarPose["eyes"], [number, number]>> = { look_left: [-4, 0], look_right: [4, 0], look_up: [0, -3.5], look_down: [0, 3.5] };

/** Advance to `now` and return the frame. */
export function stepFace(sim: FaceSim, now: number): FaceFrame {
  const dt = Math.max(0, (now - sim.last) / 1000);
  sim.last = now;
  if (!sim.entered) { sim.entered = true; sim.stateStart = now; }
  if (sim.pending) enterState(sim, now);
  const sp = sim.sp, rm = sim.rm;
  const t = (now - sim.mount) / 1000 + sim.phase;

  // The Bot's clip, if one is playing.
  if (sim.clip) {
    const el = now - sim.clip.t0;
    if (el >= sim.clip.c.duration_ms) { sim.clip = null; sim.pose = ANIM_REST; }
    else sim.pose = sampleClip(sim.clip.c, el);
  } else sim.pose = ANIM_REST;
  const pose = sim.pose;
  const clipEyes = sim.clip ? pose.eyes : "open";
  const speaking = sim.voice !== null;
  const listening = sim.listening && !speaking;

  // Living Bots: the work pose. Hover wakes a resting Bot (and keeps it up a while after); the pose's
  // loops run only with motion allowed and the user not reading, and small unless this Bot leads.
  if (sim.hover && sim.act === "rest") sim.wokeUntil = now + WAKE_MS;
  const act: LivingAct = sim.act === "rest" && now < sim.wokeUntil ? "idle" : sim.act;
  const loops = !rm && !sim.quiet;
  const k = sim.lead ? 1 : SUPPORT_AMP;
  const ae = Math.max(0, (now - sim.actStart) / 1000);
  const busyAct = act === "think" || act === "read" || act === "write" || act === "browse" || act === "run" || act === "work" || act === "stuck";

  // Expression targets.
  const happy = now < sim.happyUntil || clipEyes === "happy";
  sp.hap.t = happy ? 1 : 0;
  sp.wide.t = clipEyes === "wide" ? 1 : act === "needs-you" ? 0.3 : 0;
  sp.mk.t = busyAct ? 1 : act === "idle" && sim.mood !== "idle" ? 1 : 0;
  sp.lid0.t = clipEyes === "closed" ? 0 : 1;
  sp.lid1.t = clipEyes === "closed" || clipEyes === "wink" ? 0 : 1;
  sp.lidAct.t = act === "rest" ? 0 : act === "run" ? 0.8 : act === "stuck" ? 0.76 : act === "think" ? 0.92 : 1;
  sp.level.t = sim.voice ?? 0;
  // The rest turn (smooth pass): idle, no pointer, no clip, not mid-twirl, not facing a listener.
  sp.rest.t = sim.mood === "idle" && !busyAct && act !== "needs-you" && !sim.hover && !sim.clip && !sim.twirling && !listening ? REST_TURN : 0;

  // Gaze: where it looks. The head follows it (below); the eyes lead a little inside the face.
  let gx = 0, gy = 0;
  if (sim.mood === "thinking") {
    if (sim.presence === "searching" && !rm) { gx = 2.8 * Math.sin(t * 1.3); gy = -2; }
    else { gx = -2.8; gy = -3.4; }
  } else if (sim.mood === "working") { gx = rm ? 0 : 1.3 * Math.sin(t * 0.8) + 0.4 * Math.sin(t * 2.1); gy = 2.4; }
  else if (!rm && !sim.quiet) { gx = 1.1 * Math.sin(t * 0.45); gy = 0.6 * Math.sin(t * 0.31 + 1); }
  // Each work pose looks at its work (living-pose.ts); a still pose under reduced motion or reading.
  switch (act) {
    case "think": gx = -2.8; gy = -3.4; break;
    case "read": {
      // Line by line: left to right, a quick return, one row lower each pass (four rows, then up).
      const line = 1.6, p = (ae % line) / line;
      gx = !loops ? 0 : (p < 0.85 ? lerp(-3, 3, p / 0.85) : lerp(3, -3, (p - 0.85) / 0.15)) * (0.55 + 0.45 * k);
      gy = 1.4 + (loops ? (Math.floor(ae / line) % 4) * 0.5 : 0.6);
      break;
    }
    case "write": gx = loops ? 0.8 * Math.sin(t * 1.3) * k : 0; gy = 3; break;
    case "browse": gx = 3.2; gy = 0.6; break;
    case "run": gx = 0; gy = 1.8; break;
    case "needs-you": gx = 0; gy = 0; break;
    case "stuck": gx = 0; gy = 3.2; break;
    case "remember": gx = loops && ae < DOTS_SETTLE ? 2.2 * Math.sin(ae * 4.8) : 0; gy = -3.4; break;
    case "rest": gx = 0; gy = 1.6; break;
    default: break; // idle and the generic work pose keep the mood's own gaze (above)
  }
  if (listening) { gx = 0; gy = 0.4; } // on a call, everyone turns to the user while they talk
  // An outside target (the pointer nearby, the composer, the approval button, a speaker's seat). A Bot
  // absorbed in reading, writing, browsing, a command or sleep keeps its eyes on that.
  const outside = sim.look && !listening && act !== "read" && act !== "write" && act !== "browse" && act !== "run" && act !== "rest" ? sim.look : null;
  if (outside) { gx = outside.nx * 3.2; gy = outside.ny * 2.6; }
  if (sim.hover) { gx = sim.hover.nx * 3.2; gy = sim.hover.ny * 2.6; }
  const look = LOOK[clipEyes];
  if (look) { gx = look[0]; gy = look[1]; }
  sp.gx.t = gx; sp.gy.t = gy;

  // The head's pose in each state (radians; tilt in degrees). Reduced motion: held at rest.
  const amp = faceAmp(sim.sizePx);
  let yawT = 0, pitchT = 0, nodT = 0, rollT = 0, leanT = 1;
  if (!rm) {
    yawT = gx * YAW_PER_GAZE * amp; pitchT = gy * PITCH_PER_GAZE * amp;
    if (sim.mood === "thinking" && !sim.hover && !look && sim.presence !== "searching") rollT = -3 * amp;
    if (speaking) {
      // Nods ride the mouth's level (a quick spring, so it lags the voice a touch), and the head
      // shifts a little on two slow, incommensurate rhythms: alive, never a metronome.
      nodT = 0.12 * (sp.level.x - 0.35) * amp;
      yawT += amp * (0.05 * Math.sin(t * 0.9) + 0.025 * Math.sin(t * 2.3 + 1)) * (0.4 + sp.level.x);
    }
    if (listening) { rollT = 4.5 * amp; leanT = 1 + 0.035 * amp; yawT *= 0.5; pitchT -= 0.03 * amp; }
    // Living Bots: each pose's head, held by the head springs. Loops too quick for a spring (the hum,
    // the type bounce, the stuck shake) are added straight onto the frame below.
    if (!sim.hover && !outside && !listening) switch (act) {
      case "think": rollT = -3 * amp; if (loops) yawT += 0.09 * Math.sin(t * 0.8) * amp * k; break;
      case "read": pitchT += 0.07 * amp; break;
      case "write": pitchT += 0.12 * amp; break;
      case "browse": yawT = 0.5 * amp + 0.3 * yawT; if (loops) pitchT += (0.07 * amp * k * Math.max(0, Math.sin(t * 0.9) - 0.8)) / 0.2; break;
      case "run": pitchT += 0.04 * amp; break;
      case "stuck": pitchT += 0.24 * amp; rollT = 2 * amp; break;
      case "remember": pitchT -= 0.06 * amp; break;
      case "rest": pitchT += 0.12 * amp; rollT = 3 * amp; break;
      default: break;
    }
    if (act === "needs-you") leanT = 1 + 0.03 * amp;
  }
  sp.yaw.t = yawT; sp.pitch.t = pitchT; sp.nod.t = nodT; sp.roll.t = rollT; sp.lean.t = leanT;

  if (rm) { for (const s of sim.eased) snap(s); }
  else for (const s of sim.eased) stepSpring(s, dt);

  // Hops, squash and the twirl.
  let hop = 0, q = 0, opacity = 1, hopYaw = 0, hopPitch = 0;
  const u = (now - sim.fadeT0) / 360;
  if (u >= 0 && u < 1) opacity = 1 - 0.28 * Math.sin(u * Math.PI);
  let dYaw = 0, dTilt = 0;
  if (!rm) {
    stepSpring(sp.squash, dt);
    stepSpring(sp.dragX, dt); stepSpring(sp.dragY, dt);
    // Living Bots: the needs-you foot tap (the lead only, never while the user reads).
    if (act === "needs-you" && loops && sim.lead && sim.interactions && now >= sim.nextTap) {
      if (!sim.hops.length && !sim.twirling && !sim.clip) playHops(sim, [TAP_HOP], now);
      sim.nextTap = Math.max(sim.nextTap + TAP_EVERY_MS, now + TAP_EVERY_MS / 2);
    }
    if (sim.twirling) {
      const s = sp.twirl;
      stepSpring(s, dt);
      if (!sim.twirlHopped && Math.abs(s.x) > 0.98 && Math.abs(s.v) < 0.4) { sim.twirlHopped = true; playHops(sim, [TWIRL_HOP], now); }
      if (Math.abs(s.t - s.x) < 0.001 && Math.abs(s.v) < 0.003) { sim.twirling = false; s.x = s.t = s.v = 0; }
    }
    hop = hopValue(sim, now);
    // The hop's weight: crouch before take-off, stretch in the air (the head pitched up, a small yaw),
    // and the landing kick on the squash spring (hopValue) settles it.
    let hq = 0;
    const hk = Math.min(1, sim.hopH / 4);
    if (sim.hopAnt > 0) hq = 0.1 * hk * sim.hopAnt;
    else if (sim.hopP >= 0) {
      const arc = Math.sin(Math.PI * sim.hopP), lift = Math.min(1, sim.hopH / 5.4) * arc * amp;
      hq = -0.09 * hk * Math.sqrt(arc) * (1 - 0.5 * arc);
      hopPitch = -0.2 * lift;
      hopYaw = 0.12 * lift * (sim.phase % 2 < 1 ? 1 : -1);
    }
    // The quick loops: the type bounce, the command's hum, the stuck shake and sag.
    if (loops) {
      if (act === "write") hq += 0.035 * k * Math.max(0, Math.sin(t * 19)) ** 4;
      if (act === "run") { hq += 0.022 * k * Math.abs(Math.sin(t * 6.3)); dYaw = 0.03 * amp * k * Math.sin(t * 5.2); }
      if (act === "stuck" && ae < 0.9) dTilt = 6 * amp * Math.sin(ae * 18) * (1 - ae / 0.9);
    }
    if (act === "stuck") hq += 0.03;
    q = clamp(sp.squash.x + hq, -0.13, 0.13);
  }
  // The click twirl and a clip's authored turn are whole yaws (1 = once round); the rest turn, the
  // head's pose and the hop add to them. `turn` keeps its old meaning (the spin plus the rest turn).
  const spinTurn = sp.twirl.x + pose.turn;
  const turn = spinTurn + sp.rest.x;
  const yaw = spinTurn * 2 * Math.PI + sp.rest.x + sp.yaw.x + hopYaw + dYaw;
  const pitch = sp.pitch.x + sp.nod.x + hopPitch;
  const P = project3d(yaw, pitch, sim.P);

  // Blinks (ambient): single, short, at random intervals; not while happy or a clip holds the eyes.
  let blink = 1;
  if (!rm) {
    const heldEyes = (sim.clip !== null && clipEyes !== "open" && !look) || act === "rest";
    if (now >= sim.nextBlink) {
      if (!heldEyes && sp.hap.x < 0.2) sim.blinkAt = now;
      sim.nextBlink = now + rand(sim, 3000, 7000);
    }
    const b = (now - sim.blinkAt) / BLINK_MS;
    if (b >= 0 && b < 1 && !heldEyes) blink = 1 - Math.sin(b * Math.PI);
  }

  // The level the mouth and body follow while speaking (reduced motion: a still, half-open mouth).
  const lv = speaking ? (rm ? 0.35 : clamp(sp.level.x)) : 0;

  // Eyes, in the face's own frame (faceT carries the face's travel): each placed and foreshortened by
  // the projection; the lids close within that foreshortening.
  const hap = clamp(sp.hap.x), wide = clamp(sp.wide.x);
  // The pose's eyelids (shut at rest, narrowed for a command or when stuck) and a poke's squint.
  const su = sim.squintMs > 0 ? (now - sim.squintT0) / sim.squintMs : 2;
  const squint = su >= 0 && su < 1 ? (su < 0.35 ? 0.22 : lerp(0.22, 1, (su - 0.35) / 0.65)) : 1;
  const lidAct = clamp(sp.lidAct.x) * squint;
  const eye = (i: 0 | 1): EyeDraw => {
    const cx = P.eyeX[i] - P.dx, cy = P.eyeY - P.dy, wf = P.eyeWF[i], on = P.eyeOn[i];
    const lid = clamp(i === 0 ? sp.lid0.x : sp.lid1.x) * blink * lidAct;
    const w = EYE_W * (1 + 0.1 * wide) * wf;
    if (hap >= 0.5) {
      const k = (hap - 0.5) * 2, hw = 5 * wf; // the arch deepens as the capsule finishes flattening
      return { x: cx, y: cy, w: 0, h: 0, rx: 0, on, arc: `M${f2(cx - hw)} ${f2(cy + 2)}Q${f2(cx)} ${f2(cy + 2 - 8.5 * k * P.eyeHF)} ${f2(cx + hw)} ${f2(cy + 2)}` };
    }
    const full = EYE_H * (1 + 0.25 * wide) * (1 - 2 * hap);
    const h = Math.max(EYE_SHUT, EYE_SHUT + (full - EYE_SHUT) * lid) * P.eyeHF;
    return { x: f2n(cx - w / 2), y: f2n(cy - h / 2), w: f2n(w), h: f2n(h), rx: f2n(Math.min(w, h) / 2), arc: "", on };
  };
  const eyes: [EyeDraw, EyeDraw] = [eye(0), eye(1)];

  // Mouth (drawn about (50, MOUTH_Y); `mt` places and foreshortens it on the turned face).
  const my = MOUTH_Y;
  let kind: MouthKind;
  let line = "", fill = "";
  if (speaking) {
    kind = "speak";
    const ow = 3.2 + 1.2 * lv, oh = 0.9 + 4.2 * lv;
    fill = `M${f2(50 - ow)} ${my}A${f2(ow)} ${f2(oh)} 0 1 0 ${f2(50 + ow)} ${my}A${f2(ow)} ${f2(oh)} 0 1 0 ${f2(50 - ow)} ${my}Z`;
  } else if (hap >= 0.5) {
    kind = "open";
    fill = `M44.5 ${my - 1}Q50 ${my - 0.5} 55.5 ${my - 1}Q55 ${my + 7} 50 ${my + 7}Q45 ${my + 7} 44.5 ${my - 1}Z`;
  } else if (wide >= 0.5) {
    kind = "o";
    fill = `M47.6 ${my + 1}A2.4 2.6 0 1 0 52.4 ${my + 1}A2.4 2.6 0 1 0 47.6 ${my + 1}Z`;
  } else {
    const m = clamp(sp.mk.x);
    kind = m >= 0.5 ? "hmm" : "smile";
    // One curve that morphs: the resting smile (a shallow U) into the "hmm" (a short, slightly tilted line).
    const mm = sim.memo;
    if (mm.m !== m) { mm.m = m; mm.line = `M${f2(lerp(45.5, 47, m))} ${f2(lerp(my - 0.6, my + 0.8, m))}Q50 ${f2(lerp(my + 3.4, my + 0.1, m))} ${f2(lerp(54.5, 53, m))} ${f2(my - 0.6)}`; }
    line = mm.line;
  }
  const mt = `translate(50 ${f2(P.mouthY - P.dy)}) scale(${f4(Math.max(0.02, P.mouthSX))} ${f4(Math.max(0.02, P.mouthSY))}) translate(-50 ${-MOUTH_Y})`;

  // Body: the squash (area kept: sx·sy = 1) and the voice swell move body and face together; the
  // silhouette (outline only) compresses and shifts with the turn, and breathes (not while speaking).
  const breathe = speaking || rm || sim.quiet ? 1 : act === "rest" ? 1 + 0.03 * Math.sin((t * 2 * Math.PI) / 5) : 1 + 0.013 * Math.sin((t * 2 * Math.PI) / 4);
  const qc = clamp(q + pose.squash, -0.45, 0.45);
  const by = (1 - qc) * (1 + 0.05 * lv), bx = 1 / (1 - qc);
  const x = pose.x * CLIP_UNIT + sp.dragX.x, y = pose.y * CLIP_UNIT + hop + sp.dragY.x;
  const tilt = pose.tilt + sp.roll.x + dTilt + clamp(0.7 * sp.dragX.x, -10, 10), lean = sp.lean.x;
  const scale = pose.scale * lean;
  const [px, py] = PIVOT;
  const mm = sim.memo;
  if (mm.rx !== x || mm.ry !== y || mm.rt !== tilt || mm.rs !== scale) {
    mm.rx = x; mm.ry = y; mm.rt = tilt; mm.rs = scale;
    mm.rig = `translate(${f2(x)} ${f2(y)}) rotate(${f2(tilt)} ${px} ${py}) translate(${px} ${py}) scale(${f4(scale)} ${f4(scale)}) translate(${-px} ${-py})`;
  }
  if (mm.bx !== bx || mm.by !== by) { mm.bx = bx; mm.by = by; mm.body = `translate(50 ${BASE_Y}) scale(${f4(bx)} ${f4(by)}) translate(-50 ${-BASE_Y})`; }
  const rig = mm.rig, body = mm.body;
  const sil = `translate(${f2(50 + P.bodyDx)} ${BASE_Y}) scale(${f4(P.silX)} ${f4(P.silY * breathe)}) translate(-50 ${-BASE_Y})`;
  // The contact shadow stays on the ground: it slides opposite the lean (the base swings the other
  // way), narrows with the silhouette and shrinks while the body is in the air.
  const sx = P.silX * bx * scale * (1 - 0.3 * Math.min(1, -hop / 6));
  const shadow = sim.sizePx < SHADOW_MIN_PX ? "" : `translate(${f2(x + P.bodyDx - (BASE_Y - py) * Math.sin((tilt * Math.PI) / 180))} 0) translate(50 ${SHADOW_Y}) scale(${f4(sx)} 1) translate(-50 ${-SHADOW_Y})`;

  // Remembering: three dots circle over the head, settle into a row and fade (>= 30 px; never under
  // reduced motion; already a still row while the user reads).
  let dots = "", dotsOp = 0;
  if (act === "remember" && !rm && sim.sizePx >= DOTS_MIN_PX && ae < DOTS_GONE) {
    const st = sim.quiet ? 1 : clamp(ae / DOTS_SETTLE), e = st * st * (3 - 2 * st), r = 1.7;
    for (let i = 0; i < 3; i++) {
      const ang = ae * 3.2 + (i * 2 * Math.PI) / 3;
      const dx = lerp(50 + Math.cos(ang) * 13, 45 + i * 5, e), dy = lerp(23 + Math.sin(ang) * 3, 21.5, e);
      dots += `M${f2(dx - r)} ${f2(dy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
    dotsOp = ae < DOTS_FADE ? 1 : 1 - (ae - DOTS_FADE) / (DOTS_GONE - DOTS_FADE);
  }

  return {
    rig, body, sil, bodyD: formPath(sim.form), shadow, opacity, face: P.eyeOn[0] || P.eyeOn[1] || P.mouthOn,
    dots, dotsOp: Math.round(dotsOp * 1000) / 1000,
    faceT: `translate(${f2(P.dx)} ${f2(P.dy)})`,
    eyesT: `translate(${f2(sp.gx.x * (rm ? 1 : EYE_SLIDE))} ${f2(sp.gy.x * (rm ? 1 : EYE_SLIDE) - 1.2 * lv)})`,
    eyes, near: P.near, mouth: { kind, line, fill, t: mt, on: P.mouthOn },
    debug: { mood: sim.mood, act, hop, squash: q, turn, yaw, pitch, tilt, lean, x, y, gaze: [sp.gx.x, sp.gy.x], level: lv, clip: sim.clip?.c.name ?? null, lid: lidAct },
  };
}
function f2n(v: number): number { return Math.round(v * 100) / 100 || 0; }

/**
 * Bug #100: does the avatar need the full display rate? True mid-transition — entry or a presence
 * change, the celebration, a hop, squash, twirl or fade, a clip, the pointer over it, speaking, and
 * any expression or head pose still springing. False when only the ambient motion moves (breathing,
 * the idle drift, blinks), which the loop ticks at <= 30 fps. Pure.
 */
export function faceBusy(sim: FaceSim, now: number): boolean {
  if (!sim.entered || sim.pending) return true;
  if (now - sim.stateStart < 450 || now < sim.happyUntil || now - sim.fadeT0 < 360) return true;
  if (sim.clip || sim.hover || sim.hops.length > 0 || sim.twirling || sim.voice !== null) return true;
  const sp = sim.sp;
  // Living Bots: a drag or its spring home, a poke's squint, a nod, a new pose settling (the stuck
  // shake), the remembering dots. A pose's own loops are ambient (<= 30 fps), not busy.
  if (sim.dragging || !settled(sp.dragX) || !settled(sp.dragY)) return true;
  if (now - sim.squintT0 < sim.squintMs || Math.abs(sp.nod.x - sp.nod.t) > 0.01 || Math.abs(sp.nod.v) > 0.05) return true;
  if (now - sim.actStart < 1000 || (sim.act === "remember" && now - sim.actStart < DOTS_GONE * 1000)) return true;
  if (Math.abs(sp.squash.x) > 1e-3 || Math.abs(sp.squash.v) > 1e-2) return true;
  for (const s of sim.calm) if (!settled(s)) return true;
  if (Math.abs(sp.gx.x - sp.gx.t) > 1 || Math.abs(sp.gy.x - sp.gy.t) > 1) return true; // a glance, not the drift
  if (Math.abs(sp.yaw.x - sp.yaw.t) > 0.05 || Math.abs(sp.pitch.x - sp.pitch.t) > 0.05) return true; // a head turn, not the drift
  return false;
}

/** The first paint (and a picker's still frame): the face at rest in `presence`, before the loop ticks. */
export function restFaceFrame(form: FaceForm, presence: Presence = "idle"): FaceFrame {
  const sim = createFaceSim({ form, presence, seed: 1, sizePx: 36, reducedMotion: true, startMs: 0 });
  return stepFace(sim, 0);
}
