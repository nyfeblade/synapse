// Bot-authored avatar animations (docs/differentiators.md, "Bot-authored avatar animations").
//
// A clip is DATA, never code: keyframes over a fixed set of transforms and eye states, bounded in
// duration, amplitude and size, validated before it is stored and interpreted by the renderer. It
// is renderer-agnostic — `sampleClip` returns a pose (offsets, tilt, turn, scale, squash, eyes) — so
// the same stored clip plays on today's avatar and on any avatar that can draw a pose.
//
// Pure: no DOM, no clock. The host validates with it (update_state target "avatar"), the renderer
// samples with it.

export const ANIM_TRIGGERS = ["task_done", "click", "manual"] as const;
export type AnimTrigger = (typeof ANIM_TRIGGERS)[number];
export const ANIM_EYES = ["open", "closed", "happy", "wide", "wink", "look_left", "look_right", "look_up", "look_down"] as const;
export type AnimEyes = (typeof ANIM_EYES)[number];
export const ANIM_EASES = ["linear", "ease", "glide", "pop"] as const;
export type AnimEase = (typeof ANIM_EASES)[number];

export interface AvatarClipKey {
  /** Position in the clip, strictly inside (0, 1). Rest is implied at 0 and 1. */
  at: number;
  /** Offsets in percent of the avatar's size (+y is down). */
  x?: number; y?: number;
  /** Degrees, + is clockwise. */
  tilt?: number;
  /** Whole-face turns about the vertical axis (1 = once round). */
  turn?: number;
  scale?: number;
  /** + squashes flat (anchored at the base), − stretches tall. Area is kept. */
  squash?: number;
  /** Held from this key until the next key that sets eyes. */
  eyes?: AnimEyes;
  /** The curve ARRIVING at this key. Default "ease". */
  ease?: AnimEase;
}
export interface AvatarClip { name: string; on: AnimTrigger; duration_ms: number; keys: AvatarClipKey[] }
export interface AvatarPose { x: number; y: number; tilt: number; turn: number; scale: number; squash: number; eyes: AnimEyes }

export const ANIM_LIMITS = {
  durationMs: [300, 4000] as const,
  maxKeys: 12,
  /** Two keys closer than this in time are a strobe, not an animation. */
  minKeyGapMs: 40,
  maxEyeChanges: 6,
  minEyeGapMs: 120,
  x: 25, y: 25, tilt: 35, turn: 2, squash: 0.35,
  scale: [0.6, 1.4] as const,
  maxJsonChars: 1500,
  maxClips: 6,
  nameRe: /^[a-z0-9][a-z0-9-]{0,31}$/,
} as const;

export const ANIM_REST: AvatarPose = Object.freeze({ x: 0, y: 0, tilt: 0, turn: 0, scale: 1, squash: 0, eyes: "open" }) as AvatarPose;

type Channel = "x" | "y" | "tilt" | "turn" | "scale" | "squash";
const CHANNELS: readonly Channel[] = ["x", "y", "tilt", "turn", "scale", "squash"];
const BOUNDS: Record<Channel, readonly [number, number]> = {
  x: [-ANIM_LIMITS.x, ANIM_LIMITS.x], y: [-ANIM_LIMITS.y, ANIM_LIMITS.y], tilt: [-ANIM_LIMITS.tilt, ANIM_LIMITS.tilt],
  turn: [-ANIM_LIMITS.turn, ANIM_LIMITS.turn], scale: ANIM_LIMITS.scale, squash: [-ANIM_LIMITS.squash, ANIM_LIMITS.squash],
};
const CLIP_FIELDS = new Set(["name", "on", "duration_ms", "keys"]);
const KEY_FIELDS = new Set(["at", "eyes", "ease", ...CHANNELS]);

export type ClipResult = { ok: true; clip: AvatarClip } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Validate an untrusted value. Everything wrong is reported (so a Bot can fix it in one go); nothing is clamped. */
export function validateAvatarClip(v: unknown): ClipResult {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["the clip must be a JSON object"] };
  for (const k of Object.keys(v)) if (!CLIP_FIELDS.has(k)) errors.push(`${k}: unknown field`);
  if (typeof v.name !== "string" || !ANIM_LIMITS.nameRe.test(v.name)) errors.push("name: 1-32 of a-z, 0-9 and -, starting with a letter or digit");
  if (!oneOf(ANIM_TRIGGERS, v.on)) errors.push(`on: one of ${ANIM_TRIGGERS.join(", ")}`);
  const [dMin, dMax] = ANIM_LIMITS.durationMs;
  const dur = num(v.duration_ms) && Number.isInteger(v.duration_ms) && v.duration_ms >= dMin && v.duration_ms <= dMax ? v.duration_ms : null;
  if (dur === null) errors.push(`duration_ms: a whole number from ${dMin} to ${dMax}`);
  const keys: AvatarClipKey[] = [];
  if (!Array.isArray(v.keys) || v.keys.length < 1 || v.keys.length > ANIM_LIMITS.maxKeys) errors.push(`keys: 1 to ${ANIM_LIMITS.maxKeys} keyframes`);
  else {
    let prevAt = 0, prevEyeAt = -Infinity, eyes: AnimEyes = "open", eyeChanges = 0;
    v.keys.forEach((k: unknown, i: number) => {
      const p = `keys[${i}]`;
      if (!isObj(k)) { errors.push(`${p}: must be an object`); return; }
      for (const f of Object.keys(k)) if (!KEY_FIELDS.has(f)) errors.push(`${p}.${f}: unknown field`);
      const out: AvatarClipKey = { at: 0 };
      if (!num(k.at) || k.at <= 0 || k.at >= 1) errors.push(`${p}.at: a number strictly between 0 and 1`);
      else {
        if (k.at <= prevAt) errors.push(`${p}.at: must be after the previous key`);
        else if (dur !== null && (k.at - prevAt) * dur < ANIM_LIMITS.minKeyGapMs) errors.push(`${p}.at: keys must be at least ${ANIM_LIMITS.minKeyGapMs} ms apart`);
        out.at = k.at; prevAt = Math.max(prevAt, k.at);
      }
      let does = false;
      for (const c of CHANNELS) {
        if (k[c] === undefined) continue;
        const [lo, hi] = BOUNDS[c];
        if (!num(k[c]) || k[c] < lo || k[c] > hi) errors.push(`${p}.${c}: a number from ${lo} to ${hi}`);
        else { out[c] = k[c]; does = true; }
      }
      if (k.eyes !== undefined) {
        if (!oneOf(ANIM_EYES, k.eyes)) errors.push(`${p}.eyes: one of ${ANIM_EYES.join(", ")}`);
        else {
          out.eyes = k.eyes; does = true;
          if (dur !== null && num(k.at) && (k.at - prevEyeAt) * dur < ANIM_LIMITS.minEyeGapMs) errors.push(`${p}.eyes: eye changes must be at least ${ANIM_LIMITS.minEyeGapMs} ms apart`);
          if (k.eyes !== eyes) eyeChanges++;
          eyes = k.eyes; if (num(k.at)) prevEyeAt = k.at;
        }
      }
      if (k.ease !== undefined) {
        if (!oneOf(ANIM_EASES, k.ease)) errors.push(`${p}.ease: one of ${ANIM_EASES.join(", ")}`);
        else out.ease = k.ease;
      }
      if (!does) errors.push(`${p}: sets nothing (give at least one of ${CHANNELS.join(", ")}, eyes)`);
      keys.push(out);
    });
    if (eyeChanges > ANIM_LIMITS.maxEyeChanges) errors.push(`keys: at most ${ANIM_LIMITS.maxEyeChanges} eye changes per clip`);
  }
  if (errors.length) return { ok: false, errors };
  const clip: AvatarClip = { name: v.name as string, on: v.on as AnimTrigger, duration_ms: dur!, keys };
  if (JSON.stringify(clip).length > ANIM_LIMITS.maxJsonChars) return { ok: false, errors: [`the clip is over ${ANIM_LIMITS.maxJsonChars} characters`] };
  return { ok: true, clip };
}

/** Validate JSON text (what a Bot sends). Bad JSON is an error, never a throw. */
export function parseAvatarClip(text: string): ClipResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["body: the clip as JSON text"] };
  if (text.length > ANIM_LIMITS.maxJsonChars) return { ok: false, errors: [`the clip is over ${ANIM_LIMITS.maxJsonChars} characters`] };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, errors: ["body: not valid JSON"] }; }
  return validateAvatarClip(v);
}

/** Add or replace a clip in a Bot's set: same name replaces; a trigger other than manual holds one clip. */
export function upsertClip(clips: readonly AvatarClip[], clip: AvatarClip): { clips: AvatarClip[]; error?: string } {
  const next = clips.filter((c) => c.name !== clip.name && (clip.on === "manual" || c.on !== clip.on));
  if (next.length >= ANIM_LIMITS.maxClips) return { clips: [...clips], error: `A Bot can keep at most ${ANIM_LIMITS.maxClips} animations; delete one first.` };
  return { clips: [...next, clip] };
}

// ---------- sampling ----------

/** The app's two water springs (app/src/renderer/motion.ts SPRINGS; a test pins them equal). */
export const ANIM_SPRINGS = { glide: { duration: 680, zeta: 0.716, omega: 12.5 }, pop: { duration: 550, zeta: 0.646, omega: 17 } } as const;
function springProgress(s: { duration: number; zeta: number; omega: number }, p: number): number {
  if (p >= 1) return 1;
  const t = (p * s.duration) / 1000, a = s.zeta * s.omega, wd = s.omega * Math.sqrt(1 - s.zeta * s.zeta);
  return 1 - Math.exp(-a * t) * (Math.cos(wd * t) + (a / wd) * Math.sin(wd * t));
}
export function animEase(e: AnimEase | undefined, p: number): number {
  const q = Math.min(1, Math.max(0, p));
  switch (e) {
    case "linear": return q;
    case "glide": return springProgress(ANIM_SPRINGS.glide, q);
    case "pop": return springProgress(ANIM_SPRINGS.pop, q);
    default: return q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2;
  }
}

const clampTo = (c: Channel, v: number) => Math.min(BOUNDS[c][1], Math.max(BOUNDS[c][0], v));

/** The pose `tMs` into the clip. Rest before it starts and at 0; rest at the end, except a turn ends
 *  on its nearest whole turn (which draws exactly like rest). Total: any number in, a valid pose out. */
export function sampleClip(clip: AvatarClip, tMs: number): AvatarPose {
  if (!(tMs > 0)) return { ...ANIM_REST };
  const u = Math.min(1, tMs / clip.duration_ms);
  const pose: AvatarPose = { ...ANIM_REST };
  for (const c of CHANNELS) {
    const pts = clip.keys.filter((k) => k[c] !== undefined);
    if (!pts.length) continue;
    const last = pts[pts.length - 1]!;
    const endV = c === "turn" ? Math.round(last.turn!) : ANIM_REST[c];
    let a = { at: 0, v: ANIM_REST[c] };
    let b: { at: number; v: number; ease: AnimEase | undefined } | null = null;
    for (const k of pts) {
      if (k.at >= u) { b = { at: k.at, v: k[c]!, ease: k.ease }; break; }
      a = { at: k.at, v: k[c]! };
    }
    b ??= { at: 1, v: endV, ease: last.ease };
    const span = b.at - a.at;
    const e = span > 0 ? animEase(b.ease, (u - a.at) / span) : 1;
    pose[c] = clampTo(c, a.v + (b.v - a.v) * e);
  }
  if (u < 1) for (const k of clip.keys) { if (k.at > u) break; if (k.eyes) pose.eyes = k.eyes; }
  return pose;
}

/** What update_state target "avatar" action "help" returns: the whole DSL, fetched only when needed. */
export const AVATAR_ANIM_HELP = [
  "Avatar animations: short clips your avatar plays. Actions: set (body = clip JSON), list, delete (name), reset (delete all), play (name, plays once now).",
  `Clip: name (a-z 0-9 -), on (${ANIM_TRIGGERS.join(" | ")}; task_done replaces the finish hop, click the click twirl, manual only plays on play), duration_ms ${ANIM_LIMITS.durationMs[0]}-${ANIM_LIMITS.durationMs[1]}, keys (1-${ANIM_LIMITS.maxKeys}).`,
  `Key: at (0<at<1, increasing; rest is implied at 0 and 1), then any of x, y (% of size, +-${ANIM_LIMITS.x}; +y down), tilt (deg, +-${ANIM_LIMITS.tilt}), turn (turns, +-${ANIM_LIMITS.turn}), scale (${ANIM_LIMITS.scale[0]}-${ANIM_LIMITS.scale[1]}), squash (+-${ANIM_LIMITS.squash}; + flat, - tall), eyes (${ANIM_EYES.join(" | ")}; held until changed), ease into the key (${ANIM_EASES.join(" | ")}; glide and pop are springs).`,
  `Limits: keys ${ANIM_LIMITS.minKeyGapMs} ms apart, at most ${ANIM_LIMITS.maxEyeChanges} eye changes, ${ANIM_LIMITS.maxClips} clips, ${ANIM_LIMITS.maxJsonChars} chars. One clip per trigger; a new one replaces it. Reduced motion skips clips.`,
  'Example: {"name":"happy-spin","on":"task_done","duration_ms":1200,"keys":[{"at":0.25,"y":-18,"squash":-0.15,"eyes":"happy","ease":"pop"},{"at":0.6,"turn":1,"ease":"glide"},{"at":0.8,"y":0,"squash":0.2}]}',
].join("\n");
