// Living Bots (bug 226): the pure geometry behind gaze, touch and the call screen's glances. No DOM
// reads here (the bus hands in rectangles), so every rule is unit-tested.

export interface Box { left: number; top: number; width: number; height: number }
/** A gaze direction in the avatar's own units: -1..1 on each axis (1 = as far as the eyes go). */
export interface Look { nx: number; ny: number }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Where an avatar in `r` looks to see the point (x, y). Near the avatar the eyes move in proportion;
 * further than one avatar-size away they point along the direction at full reach, so a button far
 * below is looked at "down", not ignored.
 */
export function gazeAt(r: Box, x: number, y: number): Look {
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = x - cx, dy = y - cy;
  const k = Math.max(Math.hypot(dx, dy), Math.max(r.width, 16));
  return { nx: clamp(dx / k, -1, 1) + 0, ny: clamp(dy / k, -1, 1) + 0 };
}

/** How close the pointer has to be before an avatar notices it (px from its box). */
export function noticeRadius(sizePx: number): number { return Math.max(140, sizePx * 4); }

/** The pointer is near enough to follow (and not so far that every avatar on screen stares). */
export function pointerNear(r: Box, x: number, y: number, radius = noticeRadius(r.width)): boolean {
  const ex = Math.max(r.left - x, 0, x - (r.left + r.width));
  const ey = Math.max(r.top - y, 0, y - (r.top + r.height));
  return Math.hypot(ex, ey) <= radius;
}

/** A password or secret field has focus: look politely away from it (the other side, a little up). */
export function lookAway(toward: Look): Look {
  const side = toward.nx > 0.05 ? -1 : toward.nx < -0.05 ? 1 : -1;
  return { nx: 0.9 * side, ny: -0.55 };
}

/** The focused element is a secret: a password input, or one the app marks as a secret field. */
export function isSecretField(el: { tagName?: string; type?: string; autocomplete?: string; dataset?: Record<string, string | undefined> } | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  if (el.dataset?.secret !== undefined) return true;
  return el.tagName.toUpperCase() === "INPUT" && (el.type === "password" || el.autocomplete === "one-time-code");
}

/**
 * On a group call, a listener glances at the speaker's seat: the avatars sit left to right in seat
 * order (shared/src/voice-calls.ts callSeats), so the glance is sideways toward the speaker, a touch
 * stronger for a neighbour further along. null: nothing to glance at (no speaker, or it is me).
 */
export function seatGlance(order: readonly string[], speaker: string | null, me: string): Look | null {
  if (!speaker || speaker === me) return null;
  const a = order.indexOf(me), b = order.indexOf(speaker);
  if (a < 0 || b < 0) return null;
  const d = b - a;
  return { nx: Math.sign(d) * Math.min(1, 0.7 + 0.15 * (Math.abs(d) - 1)), ny: 0.05 };
}

// ---------- touch ----------
/** Movement (px) before a press becomes a drag rather than a click (a poke). */
export const DRAG_SLOP_PX = 6;
export function isDrag(dx: number, dy: number): boolean { return Math.hypot(dx, dy) >= DRAG_SLOP_PX; }
/**
 * The dragged avatar's offset (px) for a pointer offset: it follows, then gives like a rubber band,
 * never more than ~0.35 of its own size, so it can't be dragged over text or a control.
 */
export function dragOffset(dx: number, dy: number, sizePx: number): { x: number; y: number } {
  const lim = Math.max(4, sizePx * 0.35);
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const g = lim * Math.tanh(d / lim) / d;
  return { x: dx * g, y: dy * g };
}

// ---------- hand-offs ----------
/** Of every visible (sender avatar, receiver avatar) pair, the closest: the call screen's two, a
 *  group chat's two, or the sidebar's two, whichever share the screen. null: no pair is visible. */
export function handoffPair<T extends { box: Box }>(from: readonly T[], to: readonly T[]): [T, T] | null {
  let best: [T, T] | null = null, bestD = Infinity;
  for (const a of from) for (const b of to) {
    if (a === b) continue;
    const d = Math.hypot(a.box.left - b.box.left, a.box.top - b.box.top);
    if (d < bestD) { bestD = d; best = [a, b]; }
  }
  return best;
}
/** Which way the orb's arc bows: up for a sideways hop, to the right (into the list, never off the
 *  window's edge) for a mostly vertical one such as sidebar row to row. */
export function orbBow(ax: number, ay: number, bx: number, by: number): { nx: number; ny: number } {
  return Math.abs(by - ay) > Math.abs(bx - ax) ? { nx: 1, ny: 0 } : { nx: 0, ny: -1 };
}
/** The orb's flight: an eased arc from a to b that bows `lift` px (along `bow`, default up) at its
 *  middle. p in 0..1. */
export function orbPoint(ax: number, ay: number, bx: number, by: number, p: number, lift: number, bow = { nx: 0, ny: -1 }): { x: number; y: number } {
  const q = clamp(p, 0, 1), e = q < 0.5 ? 2 * q * q : 1 - (-2 * q + 2) ** 2 / 2, h = Math.sin(q * Math.PI) * lift;
  return { x: ax + (bx - ax) * e + bow.nx * h, y: ay + (by - ay) * e + bow.ny * h };
}
