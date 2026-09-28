/**
 * Makes the README banner, docs/media/banner-dark.svg and banner-light.svg: the launch snap as an
 * animated SVG that ends on the app icon's Bot, then the wordmark and a tagline.
 *
 * The motion is the app's own launch physics (app/src/renderer/launch/launch-snap.ts: the magnet,
 * the bounce, the squash, the eyes, the hop and the sparks), stepped at the same fixed 240 Hz and
 * written out as CSS keyframes, slowed a little so it reads at README size. The shapes are taken from
 * app/build/icon.svg, so the resting Bot is the icon. It plays once; Reduce Motion shows the rest frame.
 *
 *   node scripts/banner.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icon = fs.readFileSync(path.join(root, "app/build/icon.svg"), "utf8");
const grab = (re, what) => { const m = re.exec(icon); if (!m) throw new Error(`icon.svg: no ${what}`); return m[1]; };
const PLATE = grab(/<path d="(M924 512[^"]+)" fill="#000000"/, "plate");
const BODY = grab(/<g transform="translate\(520 544\) rotate\(0\)"><path d="([^"]+)"/, "body");
const CLIP_L = grab(/<clipPath id="L"><path d="([^"]+)"/, "left clip");
const CLIP_R = grab(/<clipPath id="R"><path d="([^"]+)"/, "right clip");
const DOTS = [...icon.matchAll(/<circle [^>]+\/>/g)].map((m) => m[0]);

/* ---------- the launch physics (launch-snap.ts, ported as is) ---------- */
const CUT = (36 * Math.PI) / 180, B = 30;
const G0 = 44, MAGNET = 7.5e5, DRAG = 2, RESTITUTION = 0.28, H = 1 / 240, LAUNCH_MS = 1100;
const SPARKS = ["#ED712E", "#3472D9", "#F19D38", "#43975D", "#49A393", "#CE3D86"];
const NRM = [Math.cos(CUT), Math.sin(CUT)], DIR = [-Math.sin(CUT), Math.cos(CUT)];
class Spring {
  constructor(x, to, k, c) { this.x = x; this.to = to; this.k = k; this.c = c; this.v = 0; }
  step(h) { this.v += (-this.k * (this.x - this.to) - this.c * this.v) * h; this.x += this.v * h; }
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOut = (x) => 1 - (1 - x) ** 3;
function seeded(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

function simulate() {
  let t = 0, g = G0, v = -10, contacts = 0, seated = false, tClick = 0, woke = false, nextHop = 200, ci = 0;
  const sqX = new Spring(1, 1, 1100, 26), eye = new Spring(0, 0, 650, 20), hop = new Spring(0, 0, 520, 19);
  const rnd = seeded(29), hops = [], bursts = [], frames = [];
  function contact(speed) {
    contacts++;
    if (contacts !== 1) return;
    tClick = t; sqX.v = -5.5 * Math.min(1, speed / 350);
    for (let i = 0; i < 10; i++) {
      const end = i % 2 ? 1 : -1, out = Math.atan2(DIR[1] * end, DIR[0] * end);
      bursts.push({ t0: t, life: 150 + rnd() * 70, ang: out + (rnd() - 0.5) * 1.3, d1: 9 + rnd() * 14, r: 1.3 + rnd(), col: SPARKS[(i * 3) % SPARKS.length], end });
    }
  }
  while (t < LAUNCH_MS) {
    t += H * 1000;
    if (!seated) {
      v += (-MAGNET / (g + 8) ** 2 - DRAG * v) * H; g += v * H;
      if (g <= 0) { const sp = -v; g = 0; contact(sp); if (contacts >= 2) { seated = true; v = 0; } else v = sp * RESTITUTION; }
      if (g < 30) while (nextHop <= t) {
        const a = (rnd() - 0.5) * 1.1 * B;
        hops.push({ t0: nextHop, life: 40 + g * 2.2, r: 1.3 + rnd() * 0.9, col: SPARKS[ci++ % SPARKS.length], bend: (rnd() - 0.5) * 6, a, b: a + (rnd() - 0.5) * 8, dir: rnd() < 0.5 });
        nextHop += 16 + g * 1.4 + rnd() * 10;
      } else nextHop = t;
    }
    if (tClick && !woke && t >= tClick + 80) { woke = true; eye.to = 1; hop.v = -95; }
    sqX.step(H); eye.step(H); hop.step(H);
    const k = clamp01(g / G0);
    frames.push({
      t, gap: g, whole: seated && t > tClick + 40, tilt: [-0.16 * k ** 1.3, 0.12 * k ** 1.3], lift: [-5 * k ** 1.5, 4 * k ** 1.5],
      sqX: sqX.x, sqY: 1 + (1 - sqX.x) * 0.8, eye: clamp01(eye.x), hop: hop.x, alpha: easeOut(clamp01(t / 140)),
    });
  }
  return { frames, hops, bursts, tClick };
}

/* ---------- to keyframes ---------- */
const S = 8.125;            // body units → icon units (the icon's body is 260 x 244, the avatar's 32 x 30)
const START = 250, SLOW = 1.5;
const DUR = 2900;           // everything shares one clock
const at = (simMs) => START + simMs * SLOW;
const pct = (ms) => `${Math.max(0, Math.min(100, (ms / DUR) * 100)).toFixed(2).replace(/\.?0+$/, "")}%`;
const n = (x, d = 1) => { const s = x.toFixed(d).replace(/\.?0+$/, ""); return s === "-0" ? "0" : s; };

/** One keyframes rule from [ms, declarations] pairs, dropping repeats of the same declarations. */
function keyframes(name, steps) {
  const out = [];
  let last = null;
  steps.forEach(([ms, css], i) => {
    const next = steps[i + 1]?.[1];
    if (css === last && css === next) return;
    out.push(`${pct(ms)}{${css}}`);
    last = css;
  });
  return `@keyframes ${name}{${out.join("")}}`;
}

const { frames, hops, bursts, tClick } = simulate();
const sample = frames.filter((_, i) => i % 3 === 2);
const tWhole = frames.find((f) => f.whole).t;
const rules = [];
const els = { hopsSvg: [], burstSvg: [] };

// The two halves, until they are one.
for (const [cls, sg, i] of [["hl", -1, 0], ["hr", 1, 1]]) {
  const pose = (f) => `transform:translate(${n(sg * f.gap * NRM[0] * S)}px,${n((sg * f.gap * NRM[1] + f.lift[i]) * S)}px) rotate(${n((f.tilt[i] * 180) / Math.PI, 2)}deg)`;
  const steps = [[0, `opacity:0;${pose(frames[0])}`]];
  for (const f of sample) {
    if (f.whole) break;
    steps.push([at(f.t), `opacity:${n(f.alpha, 2)};${pose(f)}`]);
  }
  steps.push([at(tWhole) + 1, steps.at(-1)[1]], [at(tWhole) + 2, "opacity:0;transform:none"], [DUR, "opacity:0;transform:none"]);
  rules.push(keyframes(cls, steps));
}
// The whole Bot: shows at the join, squashes, opens its eyes and hops.
rules.push(keyframes("whole", [[0, "opacity:0"], [at(tWhole) - 1, "opacity:0"], [at(tWhole), "opacity:1"], [DUR, "opacity:1"]]));
const after = sample.filter((f) => f.t >= tWhole - 5);
rules.push(keyframes("hop", [[0, "transform:none"], ...after.map((f) => [at(f.t), `transform:translateY(${n(f.hop * S)}px)`]), [DUR, "transform:none"]]));
rules.push(keyframes("sq", [[0, "transform:none"], ...after.map((f) => [at(f.t), `transform:scale(${n(f.sqX, 3)},${n(f.sqY, 3)})`]), [DUR, "transform:none"]]));
const eyeH = (e) => Math.max(1.3, 1.3 + (13 - 1.3) * e) / 13;
rules.push(keyframes("eye", [[0, "transform:scaleY(0.1)"], ...sample.map((f) => [at(f.t), `transform:scaleY(${n(eyeH(f.eye), 3)})`]), [DUR, "transform:none"]]));
rules.push(keyframes("smile", [[0, "opacity:0"], ...sample.map((f) => [at(f.t), `opacity:${n(f.eye, 2)}`]), [DUR, "opacity:1"]]));

// Sparks hopping across the closing gap (each its own dot; behind the halves, as in the app).
hops.forEach((h, idx) => {
  const steps = [[0, "opacity:0"]];
  let shown = false;
  for (const f of frames.filter((_, i) => i % 2 === 1)) {
    const p = (f.t - h.t0) / h.life;
    if (p < 0) continue;
    if (p > 1 || f.whole || f.gap <= 0.5) break;
    const gg = f.gap;
    const from = [DIR[0] * h.a - NRM[0] * gg, DIR[1] * h.a - NRM[1] * gg], to = [DIR[0] * h.b + NRM[0] * gg, DIR[1] * h.b + NRM[1] * gg];
    const [a, b] = h.dir ? [from, to] : [to, from];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, bend = h.bend * Math.sin(Math.PI * p);
    const x = (a[0] + dx * p - (dy / L) * bend) * S, y = (a[1] + dy * p + (dx / L) * bend) * S;
    if (!shown) steps.push([at(f.t) - 1, `opacity:0;transform:translate(${n(x)}px,${n(y)}px)`]);
    shown = true;
    steps.push([at(f.t), `opacity:1;transform:translate(${n(x)}px,${n(y)}px)`]);
  }
  if (!shown) return;
  steps.push([steps.at(-1)[0] + 1, "opacity:0"], [DUR, "opacity:0"]);
  rules.push(keyframes(`h${idx}`, steps));
  els.hopsSvg.push(`<circle class="sp" style="animation-name:h${idx}" r="${n(h.r * S)}" fill="${h.col.toLowerCase()}"/>`);
});
// Sparks thrown out of both ends of the join at the click.
bursts.forEach((b, idx) => {
  const ex = DIR[0] * b.end * B * 1.05, ey = DIR[1] * b.end * B * 1.05, steps = [[0, "opacity:0"], [at(b.t0) - 1, "opacity:0"]];
  for (let p = 0; p <= 1.0001; p += 0.125) {
    const d = 1 + (b.d1 - 1) * easeOut(p), x = (ex + Math.cos(b.ang) * d) * S, y = (ey + Math.sin(b.ang) * d) * S;
    steps.push([at(b.t0 + p * b.life), `opacity:${n(1 - p * p, 2)};transform:translate(${n(x)}px,${n(y)}px) scale(${n(1 - 0.6 * p, 2)})`]);
  }
  steps.push([DUR, "opacity:0"]);
  rules.push(keyframes(`b${idx}`, steps));
  els.burstSvg.push(`<circle class="sp" style="animation-name:b${idx}" r="${n(b.r * S)}" fill="${b.col.toLowerCase()}"/>`);
});
// The icon's own dots settle in, then the words.
const tDots = at(tClick + 120), tWord = at(tClick + 160), tTag = tWord + 140;
rules.push(keyframes("dots", [[0, "opacity:0"], [tDots, "opacity:0"], [tDots + 500, "opacity:1"], [DUR, "opacity:1"]]));
rules.push(`@keyframes word{0%,${pct(tWord)}{opacity:0;transform:translateX(-14px)}${pct(tWord + 600)},100%{opacity:1;transform:none}}`);
rules.push(`@keyframes tag{0%,${pct(tTag)}{opacity:0;transform:translateX(-10px)}${pct(tTag + 600)},100%{opacity:1;transform:none}}`);

/* ---------- the page ---------- */
const THEMES = {
  dark: { word: "#f4f4f3", tag: "#a3a3a0", rim: "#2c2c2b" },
  light: { word: "#111110", tag: "#6b6b68", rim: "#000000" },
};
const W = 1280, HGT = 360, SC = 0.3;
const plateX = 228, ix = plateX - 100 * SC, iy = HGT / 2 - 512 * SC, textX = plateX + 824 * SC + 56;
const face = `<g transform="translate(0 -32.4)"><g class="eye"><rect x="-111.3" y="-52.8" width="52" height="105.6" rx="26" fill="#111110"/><rect x="59.3" y="-52.8" width="52" height="105.6" rx="26" fill="#111110"/></g></g><path class="smile" d="M-36.6 88.7Q0 121.2 36.6 88.7" fill="none" stroke="#111110" stroke-width="21.1" stroke-linecap="round"/>`;
const bot = `<use href="#body" fill="#ffffff"/>${face}`;

function banner(theme) {
  const c = THEMES[theme];
  const ease = "cubic-bezier(.2,.7,.2,1)";
  const css = [
    `text{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif}`,
    `.hl,.hr,.whole,.hop,.sq,.eye,.smile,.sp,.dots{animation:${DUR}ms linear 1 both}`,
    `.hl{animation-name:hl}.hr{animation-name:hr}.whole{animation-name:whole}.hop{animation-name:hop}.sq{animation-name:sq}.eye{animation-name:eye}.smile{animation-name:smile}.dots{animation-name:dots}`,
    `.hl,.hr,.sp{opacity:0}`,
    `.word{animation:word ${DUR}ms ${ease} 1 both}.tag{animation:tag ${DUR}ms ${ease} 1 both}`,
    ...rules,
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
  ].join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HGT}" width="${W}" height="${HGT}" role="img" aria-label="Synapse: ${TAGLINE}">
<style>
${css}
</style>
<defs><path id="body" d="${BODY}"/><path id="plate" d="${PLATE}"/><clipPath id="pc"><use href="#plate"/></clipPath><clipPath id="L"><path d="${CLIP_L}"/></clipPath><clipPath id="R"><path d="${CLIP_R}"/></clipPath></defs>
<g transform="translate(${n(ix)} ${n(iy)}) scale(${SC})">
<use href="#plate" fill="#000000" stroke="${c.rim}" stroke-width="4"/>
<g clip-path="url(#pc)"><g transform="translate(520 544)">
${els.hopsSvg.join("")}
<g class="hl"><g clip-path="url(#L)">${bot}</g></g>
<g class="hr"><g clip-path="url(#R)">${bot}</g></g>
<g class="whole"><g class="hop"><g class="sq">${bot}</g></g></g>
${els.burstSvg.join("")}
</g></g>
<g class="dots">${DOTS.join("")}</g>
</g>
<text class="word" x="${n(textX)}" y="186" font-size="104" font-weight="650" letter-spacing="-3" fill="${c.word}">Synapse</text>
<text class="tag" x="${n(textX + 4)}" y="242" font-size="30" font-weight="400" fill="${c.tag}">${TAGLINE}</text>
</svg>
`;
}
const TAGLINE = "Your own team of AI Bots, on your Mac.";

fs.mkdirSync(path.join(root, "docs/media"), { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const f = path.join(root, `docs/media/banner-${theme}.svg`);
  fs.writeFileSync(f, banner(theme));
  console.log(`${path.relative(root, f)}: ${fs.statSync(f).size} bytes`);
}
