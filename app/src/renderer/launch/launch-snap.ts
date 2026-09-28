/**
 * The launch snap (decisions: "a little synapse animation when you cold start the app … sparks and a
 * magnetic snap"). Two halves of a Bot, split on the app icon's 36° diagonal, drift in with their
 * eyes shut; a magnet takes over (the pull grows with 1/gap², so it starts lazy and ends in a snap);
 * sparks jump the closing gap; the halves hit with one hard click and re-seat on a second, quieter
 * tick; the Bot squashes, opens its eyes and hops, and the overlay fades to the app beneath.
 *
 * Physics only here, stepped at a fixed 240 Hz whatever the display's frame rate, so every launch is
 * the same; `drawLaunch` paints one frame. The Bot is drawn in the avatar's own units (a 32 x 30
 * pebble with its eyes and resting smile, face-sim.ts), so it is the same face as in the app.
 */
export const LAUNCH_MS = 1100;
/** Reduce Motion: no movement, the finished Bot fades out this fast. */
export const REDUCED_MS = 160;
/** The app icon's cut, from vertical (top leans right). */
export const CUT = (36 * Math.PI) / 180;

const A = 32, B = 30, N_BODY = 2.4;
const EYE_DX = 10.5, EYE_Y = -4, EYE_W = 6.4, EYE_H = 13, EYE_SHUT = 1.3;
const G0 = 44, MAGNET = 7.5e5, DRAG = 2, RESTITUTION = 0.28;
const FADE_AT = 800, H = 1 / 240;
const SPARKS = ["#ED712E", "#3472D9", "#F19D38", "#43975D", "#49A393", "#CE3D86"];
const NRM = [Math.cos(CUT), Math.sin(CUT)] as const, DIR = [-Math.sin(CUT), Math.cos(CUT)] as const;

class Spring {
  v = 0;
  constructor(public x: number, public to: number, private k: number, private c: number) {}
  step(h: number) { this.v += (-this.k * (this.x - this.to) - this.c * this.v) * h; this.x += this.v * h; }
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;
function seeded(s: number) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

/** A spark hopping across the gap (positions along the cut, in body units). */
interface Hop { t0: number; life: number; r: number; col: string; bend: number; a: number; b: number; dir: boolean }
/** A spark thrown out of one end of the join at the click. */
interface Burst { t0: number; life: number; ang: number; d1: number; r: number; col: string; end: 1 | -1 }

export interface LaunchFrame {
  t: number;
  /** Half the gap between the halves, in body units (0 = touching). */
  gap: number;
  whole: boolean;
  tilt: [number, number];
  lift: [number, number];
  sqX: number; sqY: number;
  /** 0 shut … 1 open. */
  eye: number;
  hop: number;
  bgAlpha: number;
  botAlpha: number;
  scale: number;
  hops: readonly Hop[];
  bursts: readonly Burst[];
}

export interface LaunchSim { readonly t: number; readonly done: boolean; step(dtMs: number): void; frame(): LaunchFrame }

export function createLaunchSim(o: { onContact?: (level: number) => void } = {}): LaunchSim {
  let t = 0, g = G0, v = -10, contacts = 0, seated = false, tClick = 0, woke = false, nextHop = 200, ci = 0;
  const sqX = new Spring(1, 1, 1100, 26), eye = new Spring(0, 0, 650, 20), hop = new Spring(0, 0, 520, 19);
  const rnd = seeded(29), hops: Hop[] = [], bursts: Burst[] = [];

  function contact(speed: number) {
    contacts++;
    if (contacts === 1) {
      tClick = t; sqX.v = -5.5 * Math.min(1, speed / 350);
      for (let i = 0; i < 10; i++) {
        const end = (i % 2 ? 1 : -1) as 1 | -1;
        const out = Math.atan2(DIR[1] * end, DIR[0] * end);
        bursts.push({ t0: t, life: 150 + rnd() * 70, ang: out + (rnd() - 0.5) * 1.3, d1: 9 + rnd() * 14, r: 1.3 + rnd(), col: SPARKS[(i * 3) % SPARKS.length]!, end });
      }
      o.onContact?.(1);
    } else o.onContact?.(0.3);
  }

  function tick() {
    t += H * 1000;
    if (!seated) {
      v += (-MAGNET / (g + 8) ** 2 - DRAG * v) * H; g += v * H;
      if (g <= 0) { const sp = -v; g = 0; contact(sp); if (contacts >= 2) { seated = true; v = 0; } else v = sp * RESTITUTION; }
      if (g < 30) while (nextHop <= t) {
        const a = (rnd() - 0.5) * 1.1 * B;
        hops.push({ t0: nextHop, life: 40 + g * 2.2, r: 1.3 + rnd() * 0.9, col: SPARKS[ci++ % SPARKS.length]!, bend: (rnd() - 0.5) * 6, a, b: a + (rnd() - 0.5) * 8, dir: rnd() < 0.5 });
        nextHop += 16 + g * 1.4 + rnd() * 10;
      } else nextHop = t;
    }
    if (tClick && !woke && t >= tClick + 80) { woke = true; eye.to = 1; hop.v = -95; }
    sqX.step(H); eye.step(H); hop.step(H);
  }

  let acc = 0;
  return {
    get t() { return t; },
    get done() { return t >= LAUNCH_MS; },
    step(dtMs: number) { acc += Math.min(dtMs, 50); while (acc >= H * 1000 && t < LAUNCH_MS) { acc -= H * 1000; tick(); } },
    frame(): LaunchFrame {
      const k = clamp01(g / G0), fade = easeOut(clamp01((t - FADE_AT) / (LAUNCH_MS - FADE_AT)));
      return {
        t, gap: g, whole: seated && t > tClick + 40,
        tilt: [-0.16 * k ** 1.3, 0.12 * k ** 1.3], lift: [-5 * k ** 1.5, 4 * k ** 1.5],
        sqX: sqX.x, sqY: 1 + (1 - sqX.x) * 0.8, eye: clamp01(eye.x), hop: hop.x,
        bgAlpha: t >= LAUNCH_MS ? 0 : 1 - fade, botAlpha: easeOut(clamp01(t / 140)) * (1 - fade), scale: 1 - 0.06 * fade,
        hops, bursts,
      };
    },
  };
}

/**
 * Where the clicks fall, known before anything moves: the physics is deterministic, so the sound can
 * be scheduled on the audio clock the moment the snap starts instead of when a frame reaches it.
 */
export function snapClicks(): { t: number; level: number }[] {
  const out: { t: number; level: number }[] = [];
  const sim = createLaunchSim({ onContact: (level) => out.push({ t: sim.t, level }) });
  while (!sim.done) sim.step(50);
  return out;
}

/** The finished Bot, still: what Reduce Motion shows while it fades (`alpha` 1 → 0). */
export function restFrame(alpha: number): LaunchFrame {
  return { t: LAUNCH_MS, gap: 0, whole: true, tilt: [0, 0], lift: [0, 0], sqX: 1, sqY: 1, eye: 1, hop: 0, bgAlpha: alpha, botAlpha: alpha, scale: 1, hops: [], bursts: [] };
}

/* ---------- drawing ---------- */

export interface LaunchView { width: number; height: number; background: string; body: string; ink: string; edge: string | null; accent: string }

function bodyPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  for (let i = 0; i < 96; i++) {
    const a = (2 * Math.PI * i) / 96, c = Math.cos(a), s = Math.sin(a);
    const x = A * Math.sign(c) * Math.abs(c) ** (2 / N_BODY), y = B * Math.sign(s) * Math.abs(s) ** (2 / N_BODY);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, a = 1) {
  if (r <= 0.05 || a <= 0) return;
  const was = ctx.globalAlpha;
  ctx.globalAlpha = was * a; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = was;
}

/** Paints one frame, the Bot centred in the view. */
export function drawLaunch(ctx: CanvasRenderingContext2D, f: LaunchFrame, view: LaunchView): void {
  const { width: W, height: Hh } = view;
  ctx.clearRect(0, 0, W, Hh);
  if (f.bgAlpha > 0) { ctx.globalAlpha = f.bgAlpha; ctx.fillStyle = view.background; ctx.fillRect(0, 0, W, Hh); }
  const s = (Math.min(W, Hh) / 360) * f.scale, cx = W / 2, cy = Hh / 2 + f.hop * s;
  ctx.globalAlpha = f.botAlpha;
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);

  // sparks across the closing gap
  const gg = Math.max(0, f.gap);
  if (!f.whole && gg > 1.5 / s) for (const h of f.hops) {
    const p = (f.t - h.t0) / h.life; if (p < 0 || p > 1.25) continue;
    const from = [DIR[0] * h.a - NRM[0] * gg, DIR[1] * h.a - NRM[1] * gg], to = [DIR[0] * h.b + NRM[0] * gg, DIR[1] * h.b + NRM[1] * gg];
    const [a, b] = h.dir ? [from, to] : [to, from];
    const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, L = Math.hypot(dx, dy) || 1;
    for (let k = 2; k >= 0; k--) {
      const q = p - k * 0.11; if (q < 0 || q > 1) continue;
      const bend = h.bend * Math.sin(Math.PI * q);
      dot(ctx, a[0]! + dx * q - (dy / L) * bend, a[1]! + dy * q + (dx / L) * bend, (h.r * (1 - k * 0.28)) / 1, h.col, k === 0 ? 1 : k === 1 ? 0.5 : 0.22);
    }
  }

  ctx.save(); ctx.scale(f.sqX, f.sqY);
  const face = (sg: -1 | 1 | 0) => {
    const h = Math.max(EYE_SHUT, EYE_SHUT + (EYE_H - EYE_SHUT) * f.eye);
    ctx.fillStyle = view.ink;
    for (const side of sg ? [sg] : [-1, 1]) { ctx.beginPath(); ctx.roundRect(side * EYE_DX - EYE_W / 2, EYE_Y - h / 2, EYE_W, h, Math.min(EYE_W, h) / 2); ctx.fill(); }
    if (f.eye > 0.05) {
      const was = ctx.globalAlpha; ctx.globalAlpha = was * f.eye;
      ctx.strokeStyle = view.ink; ctx.lineWidth = 2.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-4.5, 10.9); ctx.quadraticCurveTo(0, 14.9, 4.5, 10.9); ctx.stroke();
      ctx.globalAlpha = was;
    }
  };
  const fill = () => { bodyPath(ctx); ctx.fillStyle = view.body; ctx.fill(); if (view.edge) { ctx.lineWidth = 1 / s; ctx.strokeStyle = view.edge; ctx.stroke(); } };
  if (f.whole) { fill(); face(0); }
  else for (const sg of [-1, 1] as const) {
    ctx.save();
    ctx.translate(sg * gg * NRM[0], sg * gg * NRM[1] + f.lift[sg < 0 ? 0 : 1]);
    ctx.rotate(f.tilt[sg < 0 ? 0 : 1]);
    ctx.save(); ctx.rotate(CUT); ctx.beginPath(); ctx.rect(sg < 0 ? -3 * A : 0, -3 * B, 3 * A, 6 * B); ctx.rotate(-CUT); ctx.clip();
    fill(); face(sg);
    ctx.restore(); ctx.restore();
  }
  ctx.restore();

  // sparks thrown out of both ends of the join
  for (const b of f.bursts) {
    const p = (f.t - b.t0) / b.life; if (p < 0 || p > 1) continue;
    const ex = DIR[0] * b.end * B * 1.05, ey = DIR[1] * b.end * B * 1.05, d = 1 + (b.d1 - 1) * easeOut(p);
    dot(ctx, ex + Math.cos(b.ang) * d, ey + Math.sin(b.ang) * d, b.r * (1 - 0.6 * p), b.col, 1 - p * p);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
