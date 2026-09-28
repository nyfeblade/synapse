/**
 * Soft-3D avatar proof (dev only, never shipped): drives the REAL face sim (face-sim.ts) through
 * every state on a fake clock and draws each frame with the same SVG structure ShapeAvatar writes,
 * then photographs it in headless Chromium.
 *
 *   node app/look/avatar-3d.mjs [outDir]
 *
 * Writes: contact-sheet.png (every state at 96 px and 22 px, light and dark, a white and a coloured
 * Bot), twirl-strip.png and hop-strip.png (frame strips), twirl.gif and hop.gif (30 fps loops).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(appDir, "..", "test-reports", "avatar-3d"));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-3d-"));

try {
  const simFile = path.join(tmp, "face-sim.mjs");
  await build({ entryPoints: [path.join(appDir, "src/renderer/avatar/face-sim.ts")], bundle: true, format: "esm", platform: "node", outfile: simFile, logLevel: "error" });
  const F = await import(pathToFileURL(simFile).href);

  const THEMES = {
    light: { bg: "#FFFFFF", ink: "#6F6F6F", white: "#FFFFFF", hair: "#D8D8D8" },
    dark: { bg: "#0C0C0C", ink: "#8A8A8A", white: "#E6E6E6", hair: "#333333" },
  };
  const FRAME = 1000 / 60;

  /** One frame as ShapeAvatar draws it. */
  function svg(f, { color, size, theme }) {
    const T = THEMES[theme], white = /^#(fff|ffffff)$/i.test(color);
    const fill = white ? T.white : color;
    const eye = (i) => {
      const e = f.eyes[i];
      if (!e.on) return "";
      if (e.arc) return `<path d="${e.arc}" fill="none" stroke="${F.EYE_INK}" stroke-width="3.4" stroke-linecap="round"/>`;
      return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="${e.rx}" fill="${F.EYE_INK}"/>`;
    };
    const far = f.near === 0 ? 1 : 0;
    const shadow = size >= F.SHADOW_MIN_PX ? `<ellipse cx="50" cy="${F.SHADOW_Y}" rx="23" ry="2.4" fill="#000" opacity="0.1" transform="${f.shadow}"/>` : "";
    return `<svg width="${size}" height="${size}" viewBox="14 20 72 72" style="overflow:visible">${shadow}
<g transform="${f.rig}" opacity="${f.opacity}"><g transform="${f.body}">
<path d="${f.bodyD}" fill="${fill}" transform="${f.sil}"${white ? ` stroke="${T.hair}" stroke-width="1" vector-effect="non-scaling-stroke"` : ""}/>
<g visibility="${f.face ? "visible" : "hidden"}" transform="${f.faceT}"><g transform="${f.eyesT}">${eye(far)}${eye(f.near)}</g>
<g transform="${f.mouth.t}" visibility="${f.mouth.on ? "visible" : "hidden"}">${f.mouth.line ? `<path d="${f.mouth.line}" fill="none" stroke="${F.EYE_INK}" stroke-width="2.6" stroke-linecap="round"/>` : ""}${f.mouth.fill ? `<path d="${f.mouth.fill}" fill="${F.EYE_INK}"/>` : ""}</g>
</g></g></g></svg>`;
  }

  const make = (size, presence = "idle") => F.createFaceSim({ form: "pebble", presence, seed: 7, sizePx: size, reducedMotion: false, startMs: 0 });
  /** Runs a scenario and returns every frame (60 fps). */
  function frames(size, presence, until, act = () => {}) {
    const s = make(size, presence), xs = [];
    for (let t = 0; t <= until; t += FRAME) { act(s, t); xs.push({ t, f: F.stepFace(s, t) }); }
    return xs;
  }
  const at = (xs, t) => xs.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b)).f;
  const once = (t0) => { let done = false; return (t) => { if (!done && t >= t0) { done = true; return true; } return false; }; };
  const silX = (f) => Number(f.sil.match(/scale\(([-\d.]+)/)[1]);

  /** Every state, one frame each: [label, (size) => frame]. */
  const STATES = [
    ["rest", (z) => at(frames(z, "idle", 2000), 2000)],
    ["idle drift", (z) => { const xs = frames(z, "idle", 9000).filter((x) => x.t > 2000); return xs.reduce((b, x) => (x.f.debug.yaw < b.f.debug.yaw ? x : b)).f; }],
    ["thinking", (z) => { const go = once(500); return at(frames(z, "idle", 2600, (s, t) => { if (go(t)) F.setFacePresence(s, "thinking"); }), 2600); }],
    ["working", (z) => { const xs = frames(z, "working", 9000).filter((x) => x.t > 1500); return xs.reduce((b, x) => (x.f.debug.yaw > b.f.debug.yaw ? x : b)).f; }],
    ["speaking", (z) => at(frames(z, "idle", 1600, (s, t) => F.setFaceVoice(s, t < 300 ? null : 0.55 + 0.4 * Math.sin(t / 110))), 1600)],
    ["listening", (z) => { const go = once(300); return at(frames(z, "idle", 2200, (s, t) => { if (go(t)) F.setFaceListening(s, true); }), 2200); }],
    ["hover", (z) => { const go = once(400); return at(frames(z, "idle", 2000, (s, t) => { if (go(t)) F.facePointer(s, true, -0.9, 0.8, t); }), 2000); }],
    ["hop crouch", (z) => hopFrames(z).reduce((b, x) => (x.f.debug.hop === 0 && x.f.debug.squash > b.f.debug.squash && x.t < 1200 ? x : b)).f],
    ["hop apex", (z) => hopFrames(z).reduce((b, x) => (x.f.debug.hop < b.f.debug.hop ? x : b)).f],
    ["landing", (z) => { const xs = hopFrames(z).filter((x) => x.t > 1500); return xs.reduce((b, x) => (x.f.debug.squash > b.f.debug.squash ? x : b)).f; }],
    ["twirl 45°", (z) => twirlFrames(z).find((x) => Math.abs(x.f.debug.yaw - x.f.debug.turn) >= 0 && Math.abs(Math.sin(twirlAngle(x.f))) > 0.7 && Math.cos(twirlAngle(x.f)) > 0).f],
    ["edge-on", (z) => twirlFrames(z).reduce((b, x) => (silX(x.f) < silX(b.f) ? x : b)).f],
    ["behind", (z) => twirlFrames(z).find((x) => !x.f.face).f],
  ];
  const hopCache = new Map(), twirlCache = new Map();
  function hopFrames(z) {
    if (!hopCache.has(z)) { const go = once(1000); hopCache.set(z, frames(z, "working", 2600, (s, t) => { if (go(t)) F.setFacePresence(s, "idle"); })); }
    return hopCache.get(z);
  }
  function twirlFrames(z) {
    if (!twirlCache.has(z)) { const go = once(1000); twirlCache.set(z, frames(z, "idle", 3200, (s, t) => { if (go(t)) F.faceTwirl(s, t); }).filter((x) => x.t >= 1000)); }
    return twirlCache.get(z);
  }
  const twirlAngle = (f) => f.debug.yaw;

  // ---------- the contact sheet ----------
  const COLORS = ["#ffffff", "#3472d9", "#f19d38"];
  const cell = (f, o) => `<div class="c" style="width:${Math.max(o.size, 56) + 28}px;height:${o.size + 26}px">${svg(f, o)}</div>`;
  let sheet = "";
  for (const theme of ["light", "dark"]) {
    const T = THEMES[theme];
    sheet += `<section style="background:${T.bg};color:${T.ink}"><h2>${theme}</h2><div class="row head">${STATES.map(([l]) => `<div class="c l" style="width:${96 + 28}px">${l}</div>`).join("")}</div>`;
    for (const size of [96, 22]) {
      const fs_ = STATES.map(([, get]) => get(size));
      for (const color of COLORS) {
        sheet += `<div class="row"><div class="tag">${size}px</div>${fs_.map((f) => `<div class="c" style="width:${96 + 28}px;height:${size + 30}px">${svg(f, { color, size, theme })}</div>`).join("")}</div>`;
      }
    }
    sheet += `</section>`;
  }
  const page = (body) => `<!doctype html><html><head><style>
body{margin:0;font:12px -apple-system,system-ui,sans-serif}section{padding:18px 18px 10px}h2{margin:0 0 8px;font-size:13px;font-weight:600;text-transform:capitalize}
.row{display:flex;align-items:center;padding-left:44px;position:relative}.tag{position:absolute;left:0;font-size:11px}
.c{display:flex;align-items:center;justify-content:center;flex:none}.l{height:18px;font-size:11px}
.strip{display:flex;gap:0;padding:14px}.strip .c{width:80px;height:118px;flex-direction:column}.strip .c span{font-size:10px;margin-top:6px}
</style></head><body>${body}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1700, height: 900 } });
    const pg = await ctx.newPage();
    await pg.setContent(page(sheet));
    await pg.screenshot({ path: path.join(out, "contact-sheet.png"), fullPage: true });

    // ---------- strips and loops: the twirl and the happy hop at 96 px ----------
    const clips = {
      twirl: frames(96, "idle", 2700, (s, t) => { if (t >= 300 && !s.twirling && t < 320) F.faceTwirl(s, t); }).filter((x) => x.t >= 250),
      hop: frames(96, "working", 2300, (s, t) => { if (t >= 800 && t < 817) F.setFacePresence(s, "idle"); }).filter((x) => x.t >= 700),
    };
    for (const [name, xs] of Object.entries(clips)) {
      for (const theme of ["light"]) {
        const T = THEMES[theme];
        const every = xs.filter((_, i) => i % 3 === 0).slice(0, 22);
        await pg.setViewportSize({ width: 80 * every.length + 28, height: 150 });
        await pg.setContent(page(`<div class="strip" style="background:${T.bg};color:${T.ink}">${every.map((x) => `<div class="c">${svg(x.f, { color: "#3472d9", size: 96, theme })}<span>${Math.round(x.t - every[0].t)} ms</span></div>`).join("")}</div>`));
        await pg.screenshot({ path: path.join(out, `${name}-strip.png`), fullPage: true });
      }
      // The loop: every frame at 30 fps, rendered one by one, then encoded.
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      await pg.setViewportSize({ width: 160, height: 160 });
      const loop = xs.filter((_, i) => i % 2 === 0);
      for (let i = 0; i < loop.length; i++) {
        await pg.setContent(page(`<div style="width:160px;height:160px;display:flex;align-items:center;justify-content:center;background:#fff">${svg(loop[i].f, { color: "#3472d9", size: 96, theme: "light" })}</div>`));
        await pg.screenshot({ path: path.join(dir, `f${String(i).padStart(3, "0")}.png`), clip: { x: 0, y: 0, width: 160, height: 160 } });
      }
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", path.join(dir, "f%03d.png"), "-vf", "split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse", "-loop", "0", path.join(out, `${name}.gif`)]);
    }
  } finally { await browser.close(); }
  console.log(`wrote ${out}`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
