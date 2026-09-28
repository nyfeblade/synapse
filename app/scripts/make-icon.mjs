// Builds the app icon from its one source, build/icon.svg: the PNG the dev Dock uses and the
// .icns the packaged app ships. The SVG itself is written from the design saved on the icon board
// (two Bot halves just snapped together on a diagonal, sparks off both ends of the join), with the
// avatar's own face: two capsule eyes and its resting smile.
// Usage: node app/scripts/make-icon.mjs   (needs Playwright's Chromium and macOS iconutil)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(here, "build");

const DESIGN = {
  body: "#ffffff", cut: 36, eyes: true, plate: "#000000", seam: "none",
  halves: { L: { x: 520, y: 544, r: 0 }, R: { x: 520, y: 544, r: 0 } },
  sparks: [
    { c: "#ed712e", r: 23, x: 673, y: 295 }, { c: "#3472d9", r: 14, x: 641, y: 227 }, { c: "#f19d38", r: 12, x: 724, y: 284 },
    { c: "#ed712e", r: 20, x: 312, y: 802 }, { c: "#49a393", r: 12, x: 367, y: 825 },
  ],
};
const A = 260, B = 244, EYE = "#111110";
const f = (v) => Math.round(v * 10) / 10;
function se(cx, cy, a, b, n, N = 180) {
  let d = "";
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), s = Math.sin(t);
    d += (i ? "L" : "M") + f(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)) + " " + f(cy + b * Math.sign(s) * Math.abs(s) ** (2 / n));
  }
  return d + "Z";
}
function halfPlane(sg, cutDeg) {
  const p = (cutDeg * Math.PI) / 180, n = [Math.cos(p), Math.sin(p)], d = [-Math.sin(p), Math.cos(p)], R = 2000;
  return [[0, -R], [sg * R, -R], [sg * R, R], [0, R]].map(([x, y], i) => (i ? "L" : "M") + f(x * n[0] + y * d[0]) + " " + f(x * n[1] + y * d[1])).join("") + "Z";
}
function eye(sg) {
  const dx = 0.328 * A, ey = -0.133 * B, w = 0.2 * A, h = 0.406 * A;
  return `<rect x="${f(sg * dx - w / 2)}" y="${f(ey - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(w / 2)}" fill="${EYE}"/>`;
}
function mouth() {
  // the avatar's resting smile (face-sim.ts), scaled from its 32 x 30 body to this one
  const x = 4.5 / 32 * A, y = 10.9 / 30 * B, cy = 14.9 / 30 * B, w = 2.6 / 32 * A;
  return `<path d="M${f(-x)} ${f(y)}Q0 ${f(cy)} ${f(x)} ${f(y)}" fill="none" stroke="${EYE}" stroke-width="${f(w)}" stroke-linecap="round"/>`;
}
function iconSvg(d) {
  const body = se(0, 0, A, B, 2.4);
  // Halves that sit exactly together are drawn as one body: two clipped halves leave a faint
  // anti-aliased line along the cut even with no gap between them.
  const L = d.halves.L, R = d.halves.R;
  const whole = L.x === R.x && L.y === R.y && L.r === R.r;
  const halves = whole
    ? `<g transform="translate(${L.x} ${L.y}) rotate(${L.r})"><path d="${body}" fill="${d.body}"/>${d.eyes ? eye(-1) + eye(1) + mouth() : ""}</g>`
    : [["L", -1], ["R", 1]].map(([k, sg]) => {
    const h = d.halves[k];
    return `<g transform="translate(${h.x} ${h.y}) rotate(${h.r})"><g clip-path="url(#${k})"><path d="${body}" fill="${d.body}"/>${d.eyes ? eye(sg) + mouth() : ""}</g></g>`;
  }).join("");
  // the hairline along the join, drawn in the left half's frame and kept inside the body
  let seam = "";
  if (d.seam === "hair") {
    const h = d.halves.L, p = (d.cut * Math.PI) / 180, v = [-Math.sin(p), Math.cos(p)];
    seam = `<g transform="translate(${h.x} ${h.y}) rotate(${h.r})"><g clip-path="url(#B)"><line x1="${f(-600 * v[0])}" y1="${f(-600 * v[1])}" x2="${f(600 * v[0])}" y2="${f(600 * v[1])}" stroke="#111110" stroke-opacity="0.22" stroke-width="5"/></g></g>`;
  }
  const sparks = d.sparks.map((s) => `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.c}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><clipPath id="L"><path d="${halfPlane(-1, d.cut)}"/></clipPath><clipPath id="R"><path d="${halfPlane(1, d.cut)}"/></clipPath><clipPath id="B"><path d="${body}"/></clipPath></defs>
<path d="${se(512, 512, 412, 412, 5)}" fill="${d.plate}"/>${halves}${seam}${sparks}
</svg>
`;
}

const svg = iconSvg(DESIGN);
fs.writeFileSync(path.join(build, "icon.svg"), svg);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-icon-"));
try {
  const set = path.join(tmp, "icon.iconset");
  fs.mkdirSync(set);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const png = async (px) => {
      await page.setViewportSize({ width: px, height: px });
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${px}" height="${px}"`)}</body></html>`);
      return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
    };
    for (const base of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), await png(base));
      fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), await png(base * 2));
    }
    fs.writeFileSync(path.join(build, "icon.png"), await png(1024));
  } finally { await browser.close(); }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(build, "icon.icns")]);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log("make-icon: wrote build/icon.svg, build/icon.png and build/icon.icns");
