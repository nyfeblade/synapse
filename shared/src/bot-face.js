// Bots as plain SVG: the app's avatar (app/src/renderer/avatar/face-forms.ts, face-sim.ts) for the website.
// Plain JavaScript with no imports, so the site build (Node) and the /bot page (the browser) load the same file.
//
// One formula for every body (a superellipse), the same face frame on every form: solid black eyes and
// mouth, a flat body colour, no highlight or rim. Motion (breathing, blinks) is CSS in site.css.

export const FORM_SPECS = {
  pebble: { a: 32, b: 30, n: 2.4, cy: 56 },
  orb: { a: 30, b: 30, n: 2, cy: 56 },
  tile: { a: 30, b: 29, n: 4.2, cy: 57 },
  capsule: { a: 26, b: 31.7, n: 2.6, cy: 54.3 },
  dome: { a: 31, b: 32, n: 2, cy: 58, nLow: 3.6, bLow: 28 },
  gem: { a: 34, b: 32, n: 1.55, cy: 54 },
};
/** Shape ids → the form each draws (face-forms.ts FORM_OF), plus "capsule", an old id the starters used. */
export const FORM_OF = { pebble: "pebble", orb: "orb", tile: "tile", pill: "capsule", capsule: "capsule", dome: "dome", gem: "gem", puff: "pebble", bead: "dome", hex: "gem", diamond: "gem", shield: "tile", crescent: "orb", petal: "dome", stadium: "capsule", notch: "tile", wave: "pebble" };
export const EYE_INK = "#111110";

export function formPath(form, N = 72) {
  const f = FORM_SPECS[form];
  const r = (v) => Math.round(v * 10) / 10;
  let d = "";
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), s = Math.sin(t);
    const low = f.nLow && s > 0, n = low ? f.nLow : f.n, b = low ? f.bLow : f.b;
    d += (i ? "L" : "M") + r(50 + f.a * Math.sign(c) * Math.abs(c) ** (2 / n)) + " " + r(f.cy + b * Math.sign(s) * Math.abs(s) ** (2 / n));
  }
  return d + "Z";
}

/** One Bot: the body from the shared sprite, then the face. `cls` adds classes (motion, size). */
export function botSvg(shape, color, cls = "") {
  const form = FORM_OF[shape] ?? "pebble";
  return `<svg class="bot${cls ? " " + cls : ""}" viewBox="14 20 72 72" aria-hidden="true"><g class="bb"><use href="#f-${form}" fill="${color}"/><g class="face" fill="${EYE_INK}"><rect class="eye" x="36.3" y="45.5" width="6.4" height="13" rx="3.2"/><rect class="eye" x="57.3" y="45.5" width="6.4" height="13" rx="3.2"/><path class="mouth" d="M45.5 66.9Q50 70.9 54.5 66.9" fill="none" stroke="${EYE_INK}" stroke-width="2.6" stroke-linecap="round"/></g></g></svg>`;
}

/** The body forms, once per page, as symbols the avatars <use>. */
export const botDefs = () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.keys(FORM_SPECS).map((f) => `<path id="f-${f}" d="${formPath(f)}"/>`).join("")}</defs></svg>`;

/** botSvg as DOM nodes (the browser pages set nothing through innerHTML). Same markup, attribute for attribute. */
export function botNode(doc, shape, color, cls = "") {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => { const n = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.appendChild(n); return n; };
  const form = FORM_OF[shape] ?? "pebble";
  const fill = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#777777";
  const svg = el("svg", { class: `bot${cls ? " " + cls : ""}`, viewBox: "14 20 72 72", "aria-hidden": "true" });
  const bb = el("g", { class: "bb" }, svg);
  el("use", { href: `#f-${form}`, fill }, bb);
  const face = el("g", { class: "face", fill: EYE_INK }, bb);
  el("rect", { class: "eye", x: "36.3", y: "45.5", width: "6.4", height: "13", rx: "3.2" }, face);
  el("rect", { class: "eye", x: "57.3", y: "45.5", width: "6.4", height: "13", rx: "3.2" }, face);
  el("path", { class: "mouth", d: "M45.5 66.9Q50 70.9 54.5 66.9", fill: "none", stroke: EYE_INK, "stroke-width": "2.6", "stroke-linecap": "round" }, face);
  return svg;
}
