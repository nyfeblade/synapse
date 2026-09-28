import type { Presence } from "@synapse/shared";
import { FACE_VIEWBOX, formOf } from "../renderer/avatar/face-forms";
import { createFaceSim, EYE_INK, restFaceFrame, setFacePresence, setFaceVoice, stepFace, type FaceFrame } from "../renderer/avatar/face-sim";

/**
 * Bug 198: the Bot's own avatar on the phone — the same face the Mac draws (face-sim), solid black
 * eyes on its colour. Rows get the rest frame; the call screen's avatar is live and its mouth moves
 * with the Bot's voice.
 */

const NS = "http://www.w3.org/2000/svg";
const isWhite = (c: string) => /^#(fff|ffffff)$/i.test(c.trim());

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

interface Parts { rig: SVGGElement; body: SVGGElement; bodyD: SVGPathElement; face: SVGGElement; eyesG: SVGGElement; eyes: SVGRectElement[]; arcs: SVGPathElement[]; mLine: SVGPathElement; mFill: SVGPathElement }

function build(color: string, size: number, f: FaceFrame): { svg: SVGSVGElement; parts: Parts } {
  const svg = el("svg", { width: size, height: size, viewBox: FACE_VIEWBOX, "aria-hidden": "true", class: "avatar" });
  svg.style.overflow = "visible";
  const rig = el("g", { transform: f.rig });
  const body = el("g", { transform: f.body });
  const bodyD = el("path", { d: f.bodyD, fill: isWhite(color) ? "var(--bot-white)" : color, class: isWhite(color) ? "avatar-body white" : "avatar-body" });
  const face = el("g", { transform: f.faceT });
  const eyesG = el("g", { transform: f.eyesT });
  const eyes = f.eyes.map((e) => el("rect", { fill: EYE_INK, x: e.x, y: e.y, width: e.w, height: e.h, rx: e.rx, visibility: e.arc ? "hidden" : "visible" }));
  const arcs = f.eyes.map((e) => el("path", { fill: "none", stroke: EYE_INK, "stroke-width": 3.4, "stroke-linecap": "round", d: e.arc, visibility: e.arc ? "visible" : "hidden" }));
  const mLine = el("path", { fill: "none", stroke: EYE_INK, "stroke-width": 2.6, "stroke-linecap": "round", d: f.mouth.line });
  const mFill = el("path", { fill: EYE_INK, d: f.mouth.fill });
  eyesG.append(...eyes, ...arcs);
  face.append(eyesG, mLine, mFill);
  body.append(bodyD, face);
  rig.append(body);
  svg.append(rig);
  return { svg, parts: { rig, body, bodyD, face, eyesG, eyes, arcs, mLine, mFill } };
}

function apply(p: Parts, f: FaceFrame): void {
  p.rig.setAttribute("transform", f.rig);
  p.rig.setAttribute("opacity", f.opacity.toFixed(3));
  p.body.setAttribute("transform", f.body);
  p.bodyD.setAttribute("d", f.bodyD);
  p.face.setAttribute("visibility", f.face ? "visible" : "hidden");
  p.face.setAttribute("transform", f.faceT);
  p.eyesG.setAttribute("transform", f.eyesT);
  f.eyes.forEach((e, i) => {
    const r = p.eyes[i]!, a = p.arcs[i]!;
    if (e.arc) { r.setAttribute("visibility", "hidden"); a.setAttribute("d", e.arc); a.setAttribute("visibility", "visible"); return; }
    a.setAttribute("visibility", "hidden");
    r.setAttribute("visibility", "visible");
    r.setAttribute("x", String(e.x)); r.setAttribute("y", String(e.y));
    r.setAttribute("width", String(e.w)); r.setAttribute("height", String(e.h)); r.setAttribute("rx", String(e.rx));
  });
  p.mLine.setAttribute("d", f.mouth.line);
  p.mFill.setAttribute("d", f.mouth.fill);
}

/** A still avatar (the Bots list). */
export function stillAvatar(shape: string, color: string, size: number): SVGSVGElement {
  return build(color, size, restFaceFrame(formOf(shape))).svg;
}

/** A live avatar (the call screen): breathes, blinks, and talks with `level` while the Bot speaks. */
export function liveAvatar(shape: string, color: string, size: number, seed = 1) {
  const form = formOf(shape);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sim = createFaceSim({ form, presence: "idle", seed, sizePx: size, reducedMotion: reduced, startMs: performance.now(), interactions: false });
  const { svg, parts } = build(color, size, stepFace(sim, performance.now()));
  let raf = 0;
  const loop = (t: number) => { apply(parts, stepFace(sim, t)); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  return {
    svg,
    speaking(level: number | null) { setFaceVoice(sim, level); },
    presence(p: Presence) { setFacePresence(sim, p); },
    destroy() { cancelAnimationFrame(raf); },
  };
}
