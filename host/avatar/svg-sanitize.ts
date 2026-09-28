import { LIMITS5 } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";

const ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line", "defs", "lineargradient", "radialgradient", "stop"]);
const ATTRS = new Set(["xmlns", "viewbox", "width", "height", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "transform", "id", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform"]);
const bad = (why: string) => new GatewayError("BAD_SVG", `This SVG is not allowed: ${why}.`);

/** BOT-18 Generate returns model-written SVG; only flat shapes survive (no scripts, links, styles with url(), or foreign content). */
export function sanitizeSvg(svg: string): string {
  if (Buffer.byteLength(svg.trim()) > LIMITS5.avatarSvgMaxBytes) throw bad("larger than 20 KB");
  // closed comments are dropped (models annotate their SVG); an unclosed one still fails the "<!" check below
  const s = svg.trim().replace(/<!--[\s\S]*?-->/g, "");
  if (/<!|<\?(?!xml)|&[a-z]+;/i.test(s.replace(/^<\?xml[^>]*\?>/, ""))) throw bad("declarations or entities are not allowed");
  const out: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let sawViewBox = false;
  while ((m = re.exec(s.replace(/^<\?xml[^>]*\?>/, "")))) {
    if (m[5] !== undefined) { if (m[5].trim()) throw bad("text content is not allowed"); continue; }
    const [, close, rawName, rawAttrs, selfClose] = m;
    const name = rawName!.toLowerCase();
    if (!ELEMENTS.has(name)) throw bad(`<${rawName}> is not allowed`);
    if (close) { out.push(`</${rawName}>`); continue; }
    const attrs: string[] = [];
    for (const a of rawAttrs!.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = a[1]!.toLowerCase();
      const val = a[3] ?? a[4] ?? "";
      if (key.startsWith("on") || key.includes("href")) continue;
      if (key === "style") continue;
      if (!ATTRS.has(key) || /url\(|javascript:|expression\(/i.test(val)) continue;
      if (key === "viewbox") sawViewBox = true;
      attrs.push(`${a[1]}="${val.replace(/[<>"]/g, "")}"`);
    }
    out.push(`<${rawName}${attrs.length ? " " + attrs.join(" ") : ""}${selfClose ? "/" : ""}>`);
  }
  if (!sawViewBox) throw bad("it needs a viewBox");
  return out.join("");
}
