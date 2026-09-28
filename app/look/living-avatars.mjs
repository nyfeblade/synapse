/**
 * Living Bots proof (bug 226; dev only, never shipped): drives the REAL face sim (face-sim.ts) through
 * every living state on a fake clock, draws each frame with the same SVG structure ShapeAvatar writes
 * (flat body colour: no gradient, highlight, rim or glow; solid black eyes), then photographs it in
 * headless Chromium.
 *
 *   node app/look/living-avatars.mjs [outDir]
 *
 * Writes: contact-sheet.png (every state at 96 px and 28 px, three colours, light and dark, plus the
 * reduced-motion row), tour-light.gif / tour-dark.gif (the states one after another, 25 fps) and
 * tour-strip.png (one frame per state).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(appDir, "..", "test-reports", "living-avatars"));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "living-avatars-"));

try {
  const simFile = path.join(tmp, "face-sim.mjs");
  await build({ entryPoints: [path.join(appDir, "src/renderer/avatar/face-sim.ts")], bundle: true, format: "esm", platform: "node", outfile: simFile, logLevel: "error" });
  const F = await import(pathToFileURL(simFile).href);

  const THEMES = {
    light: { bg: "#FFFFFF", ink: "#6F6F6F", white: "#FFFFFF", hair: "#D8D8D8", muted: "#6B6B6B" },
    dark: { bg: "#0C0C0C", ink: "#8A8A8A", white: "#E6E6E6", hair: "#333333", muted: "#8C8C8C" },
  };
  const FRAME = 1000 / 60;

  /** One frame as ShapeAvatar draws it (the body is ONE flat fill). */
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
    const dots = size >= F.DOTS_MIN_PX && f.dots ? `<path d="${f.dots}" fill="${T.muted}" opacity="${f.dotsOp}"/>` : "";
    return `<svg width="${size}" height="${size}" viewBox="14 20 72 72" style="overflow:visible">${shadow}
<g transform="${f.rig}" opacity="${f.opacity}"><g transform="${f.body}">
<path d="${f.bodyD}" fill="${fill}" transform="${f.sil}"${white ? ` stroke="${T.hair}" stroke-width="1" vector-effect="non-scaling-stroke"` : ""}/>
<g visibility="${f.face ? "visible" : "hidden"}" transform="${f.faceT}"><g transform="${f.eyesT}">${eye(far)}${eye(f.near)}</g>
<g transform="${f.mouth.t}" visibility="${f.mouth.on ? "visible" : "hidden"}">${f.mouth.line ? `<path d="${f.mouth.line}" fill="none" stroke="${F.EYE_INK}" stroke-width="2.6" stroke-linecap="round"/>` : ""}${f.mouth.fill ? `<path d="${f.mouth.fill}" fill="${F.EYE_INK}"/>` : ""}</g>
</g></g>${dots}</g></svg>`;
  }

  const make = (size, rm = false) => F.createFaceSim({ form: "pebble", presence: "idle", seed: 7, sizePx: size, reducedMotion: rm, startMs: 0 });
  /** Runs a scenario at 60 fps and returns every frame. */
  function frames(size, until, act = () => {}, rm = false) {
    const s = make(size, rm), xs = [];
    for (let t = 0; t <= until; t += FRAME) { act(s, t); xs.push({ t, f: F.stepFace(s, t) }); }
    return xs;
  }
  const once = (t0, fn) => { let done = false; return (s, t) => { if (!done && t >= t0) { done = true; fn(s, t); } }; };
  const pick = (xs, score) => xs.reduce((b, x) => (score(x) > score(b) ? x : b)).f;
  const at = (xs, t) => xs.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b)).f;
  const pose = (act) => once(600, (s, t) => F.setFaceAct(s, act, t));

  /** Every living state: [label, (size, rm) => frame]. */
  const STATES = [
    ["idle", (z, rm) => at(frames(z, 2000, () => {}, rm), 2000)],
    ["think", (z, rm) => at(frames(z, 2600, pose("think"), rm), 2600)],
    ["read", (z, rm) => at(frames(z, 3800, pose("read"), rm), 3500)],
    ["write", (z, rm) => { const xs = frames(z, 3000, pose("write"), rm).filter((x) => x.t > 2000); return pick(xs, (x) => x.f.debug.squash); }],
    ["browse", (z, rm) => at(frames(z, 2600, pose("browse"), rm), 2600)],
    ["run", (z, rm) => at(frames(z, 2600, pose("run"), rm), 2600)],
    ["needs you", (z, rm) => { const xs = frames(z, 4000, pose("needs-you"), rm).filter((x) => x.t > 1500); return pick(xs, (x) => -x.f.debug.hop); }],
    ["done", (z, rm) => { const xs = frames(z, 3000, (s, t) => { if (t < 20) F.setFacePresence(s, "working"); if (t >= 1200 && t < 1217) F.setFacePresence(s, "idle"); }, rm).filter((x) => x.t > 1200); return pick(xs, (x) => -x.f.debug.hop + (rm ? x.f.debug.level : 0)); }],
    ["stuck", (z, rm) => { const xs = frames(z, 2600, pose("stuck"), rm).filter((x) => x.t > 600 && x.t < 1500); return pick(xs, (x) => Math.abs(x.f.debug.tilt)); }],
    ["remember", (z, rm) => at(frames(z, 1600, pose("remember"), rm), 1150)],
    ["resting", (z, rm) => at(frames(z, 3600, pose("rest"), rm), 3600)],
    ["speaking", (z, rm) => at(frames(z, 1600, (s, t) => F.setFaceVoice(s, t < 300 ? null : 0.55 + 0.4 * Math.sin(t / 110)), rm), 1600)],
    ["listening", (z, rm) => at(frames(z, 2200, once(300, (s) => F.setFaceListening(s, true)), rm), 2200)],
    ["poke", (z, rm) => at(frames(z, 1400, once(1200, (s, t) => F.facePoke(s, t)), rm), 1270)],
    ["drag", (z, rm) => at(frames(z, 1600, once(1000, (s) => F.faceDrag(s, 7, -3)), rm), 1600)],
    ["catch", (z, rm) => { const xs = frames(z, 1500, once(1200, (s, t) => F.faceCatch(s, t)), rm).filter((x) => x.t >= 1200); return pick(xs, (x) => x.f.debug.squash); }],
  ];

  // ---------- the contact sheet ----------
  const COLORS = ["#ffffff", "#3472d9", "#ed712e"];
  const W = 96 + 26;
  let sheet = "";
  for (const theme of ["light", "dark"]) {
    const T = THEMES[theme];
    sheet += `<section style="background:${T.bg};color:${T.ink}"><h2>${theme}</h2><div class="row head">${STATES.map(([l]) => `<div class="c l" style="width:${W}px">${l}</div>`).join("")}</div>`;
    for (const size of [96, 28]) {
      const fs_ = STATES.map(([, get]) => get(size, false));
      for (const color of COLORS) sheet += `<div class="row"><div class="tag">${size}px</div>${fs_.map((f) => `<div class="c" style="width:${W}px;height:${size + 30}px">${svg(f, { color, size, theme })}</div>`).join("")}</div>`;
    }
    const rmFs = STATES.map(([, get]) => get(96, true));
    sheet += `<div class="row"><div class="tag">reduced<br>motion</div>${rmFs.map((f) => `<div class="c" style="width:${W}px;height:126px">${svg(f, { color: "#3472d9", size: 96, theme })}</div>`).join("")}</div>`;
    sheet += `</section>`;
  }
  const page = (body) => `<!doctype html><html><head><style>
body{margin:0;font:12px -apple-system,system-ui,sans-serif}section{padding:18px 18px 10px}h2{margin:0 0 8px;font-size:13px;font-weight:600;text-transform:capitalize}
.row{display:flex;align-items:center;padding-left:52px;position:relative}.tag{position:absolute;left:0;font-size:11px;line-height:1.2}
.c{display:flex;align-items:center;justify-content:center;flex:none}.l{height:18px;font-size:11px}
.strip{display:flex;padding:14px}.strip .c{width:${W}px;height:150px;flex-direction:column}.strip .c span{font-size:11px;margin-top:8px}
.stage{display:flex;align-items:center;justify-content:center;gap:28px;width:480px;height:190px;position:relative}.stage b{position:absolute;bottom:10px;font-weight:500;font-size:12px}
</style></head><body>${body}</body></html>`;

  // ---------- the tour: every state in turn, three colours side by side ----------
  const TOUR = [
    ["idle", 1400, () => {}], ["think", 1800, (s, t) => F.setFaceAct(s, "think", t)], ["read", 3300, (s, t) => F.setFaceAct(s, "read", t)],
    ["write", 1800, (s, t) => F.setFaceAct(s, "write", t)], ["browse", 1800, (s, t) => F.setFaceAct(s, "browse", t)],
    ["run", 1800, (s, t) => F.setFaceAct(s, "run", t)], ["needs you", 3200, (s, t) => F.setFaceAct(s, "needs-you", t)],
    ["done", 1800, (s, t) => { F.setFaceAct(s, "work", t); F.setFacePresence(s, "working"); }],
    ["stuck", 1800, (s, t) => { F.setFacePresence(s, "idle"); F.setFaceAct(s, "stuck", t); }],
    ["remember", 2400, (s, t) => F.setFaceAct(s, "remember", t)], ["resting", 2600, (s, t) => F.setFaceAct(s, "rest", t)],
    ["poke", 1100, (s, t) => { F.setFaceAct(s, "idle", t); F.facePoke(s, t); }],
    ["drag", 1900, (s, t) => { F.faceDrag(s, 8, -3); s.__release = t + 700; }],
  ];
  function tour(size) {
    const sims = COLORS.map(() => make(size));
    const xs = [];
    let t0 = 0;
    for (const [label, dur, enter] of TOUR) {
      let entered = false;
      for (let t = t0; t < t0 + dur; t += FRAME) {
        const fsNow = sims.map((s) => {
          if (!entered) enter(s, t);
          if (label === "done" && t >= t0 + 400 && s.presence === "working") F.setFacePresence(s, "idle");
          if (s.__release && t >= s.__release) { F.faceRelease(s, t); s.__release = 0; }
          return F.stepFace(s, t);
        });
        entered = true;
        xs.push({ t, label, fs: fsNow });
      }
      t0 += dur;
    }
    return xs;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 2100, height: 900 } });
    const pg = await ctx.newPage();
    await pg.setContent(page(sheet));
    await pg.screenshot({ path: path.join(out, "contact-sheet.png"), fullPage: true });

    const xs = tour(96);
    // One frame per state (its middle), light.
    const mids = TOUR.map(([label]) => { const seg = xs.filter((x) => x.label === label); return seg[Math.floor(seg.length * 0.6)]; });
    await pg.setViewportSize({ width: W * mids.length + 28, height: 180 });
    await pg.setContent(page(`<div class="strip" style="background:#fff;color:#6F6F6F">${mids.map((x) => `<div class="c">${svg(x.fs[1], { color: COLORS[1], size: 96, theme: "light" })}<span>${x.label}</span></div>`).join("")}</div>`));
    await pg.screenshot({ path: path.join(out, "tour-strip.png"), fullPage: true });

    // The loops: 25 fps, one frame at a time, then encoded.
    const every = Math.round(60 / 25);
    const loop = xs.filter((_, i) => i % every === 0);
    for (const theme of ["light", "dark"]) {
      const T = THEMES[theme];
      const dir = path.join(tmp, theme);
      fs.mkdirSync(dir);
      await pg.setViewportSize({ width: 480, height: 190 });
      await pg.setContent(page(`<div id="s" class="stage" style="background:${T.bg};color:${T.ink}"></div>`));
      for (let i = 0; i < loop.length; i++) {
        const x = loop[i];
        await pg.evaluate((h) => { document.getElementById("s").innerHTML = h; }, `${x.fs.map((f, k) => svg(f, { color: COLORS[k], size: 96, theme })).join("")}<b>${x.label}</b>`);
        await pg.screenshot({ path: path.join(dir, `f${String(i).padStart(4, "0")}.png`), clip: { x: 0, y: 0, width: 480, height: 190 } });
      }
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "25", "-i", path.join(dir, "f%04d.png"), "-vf", "scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=0:stats_mode=diff[p];[b][p]paletteuse=dither=none", "-loop", "0", path.join(out, `tour-${theme}.gif`)]);
    }
  } finally { await browser.close(); }
  console.log(`wrote ${out}`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
