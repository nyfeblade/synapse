// Bot share links: the one codec the app (its Share and Import sheets), the host (which trusts only itself)
// and the website (/bot, /bots and the catalogue build) all load. Plain JavaScript, no dependencies: it uses
// only what Electron, Node 18+ and every current browser have built in (CompressionStream, crypto.subtle,
// atob/btoa, TextEncoder), so the Vercel build still installs nothing.
//
// Its only imports are its two siblings, also plain JS, copied next to it on the website: the text checks
// (hidden characters, prompt injection) and the Bot drawing's shape table. One copy of each, everywhere.
//
// Link:    https://<site>/bot#b1.<base64url(deflate-raw(JSON))>    or    synapse://import#b1.<same>
// Payload: { v:1, name, title, instructions, shape, color, model?, tools:[{catalogId,name}], skills:[{id,name,description,files}] }
// Never in a payload: memories, routines, avatar images, author, source Bot, chats, keys, accounts.
import { stripHidden, looksLikeInjection } from "./feedback-content.js";
import { FORM_OF } from "./bot-face.js";

export const SHARE_VERSION = 1;
/** Where /bot links point. The vercel.app address keeps serving after a custom domain is added. */
export const SHARE_SITE = "https://synapse-site-virid.vercel.app";
export const SHARE_LIMITS = Object.freeze({
  linkMaxChars: 16_384, decodeMaxChars: 24_000, inflateMaxBytes: 256 * 1024,
  name: 80, title: 80, instructions: 20_000, tools: 30, skills: 10, skillFiles: 20, skillFileChars: 64_000,
  skillDescription: 1_024, catalogId: 200, blurb: 140,
});
/** One calm line per failure. Nothing else is ever shown for a bad link. */
export const SHARE_MESSAGES = Object.freeze({
  damaged: "This link is damaged.",
  "too-long": "This link is too long. Ask for the .botpack file.",
  newer: "This Bot needs a newer Synapse.",
  "too-big": "Too big for a link.",
});
/** The app's models (shared/src/models.ts MODEL_IDS; a test holds the two lists equal). */
export const SHARE_MODELS = Object.freeze(["claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]);
/** Old ids a payload may carry, and the current id each became (shared/src/bots.ts LEGACY_AVATAR_SHAPES). */
const LEGACY_SHAPES = { capsule: "pill", circle: "pebble", blob: "orb", "rounded-square": "tile", triangle: "dome", octagon: "gem", cloud: "puff", droplet: "bead" };
export const SHARE_SHAPES = Object.freeze(Object.keys(FORM_OF).filter((s) => !(s in LEGACY_SHAPES)));

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SKILL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#777777";

const fail = (code) => ({ ok: false, code, message: SHARE_MESSAGES[code] });
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const strOf = (x, max, { min = 0, dflt } = {}) => {
  if (x === undefined && dflt !== undefined) return dflt;
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t.length < min || t.length > max ? null : t;
};

/**
 * The canonical payload, or a damaged-link failure. Types and limits are strict; an unknown shape or model is
 * dropped (the default shape, no model) and unknown keys are left out, so the same Bot always encodes the same.
 */
export function validateShare(x) {
  if (!isObj(x) || x.v !== SHARE_VERSION) return fail("damaged");
  const L = SHARE_LIMITS;
  // Hidden characters go and text is normalised (NFKC) FIRST, so a length or emptiness check sees what will be
  // shown and saved: a name of zero-width spaces is empty, and U+FDFA (one character, eighteen after NFKC) counts
  // as eighteen.
  let removed = false;
  const clean = (v) => { if (typeof v !== "string") return v; const t = stripHidden(v).text; if (t !== v) removed = true; return t; };
  const str = (v, max, o) => strOf(clean(v), max, o);
  const name = str(x.name, L.name, { min: 1 });
  const title = str(x.title, L.title, { dflt: "" });
  const rawInstructions = clean(x.instructions);
  const instructions = typeof rawInstructions === "string" && rawInstructions.length <= L.instructions ? rawInstructions : rawInstructions === undefined ? "" : null;
  if (name === null || title === null || instructions === null) return fail("damaged");
  const rawShape = typeof x.shape === "string" ? x.shape : "";
  const shape = SHARE_SHAPES.includes(rawShape) ? rawShape : LEGACY_SHAPES[rawShape] ?? "pebble";
  const color = typeof x.color === "string" && COLOR.test(x.color) ? x.color.toLowerCase() : DEFAULT_COLOR;
  const model = typeof x.model === "string" && SHARE_MODELS.includes(x.model) ? x.model : null;
  const tools = x.tools === undefined ? [] : x.tools;
  const skills = x.skills === undefined ? [] : x.skills;
  if (!Array.isArray(tools) || tools.length > L.tools || !Array.isArray(skills) || skills.length > L.skills) return fail("damaged");
  const outTools = [];
  for (const t of tools) {
    if (!isObj(t)) return fail("damaged");
    const catalogId = str(t.catalogId, L.catalogId, { min: 1 }), tname = str(t.name, L.name, { min: 1 });
    if (catalogId === null || tname === null) return fail("damaged");
    outTools.push({ catalogId, name: tname });
  }
  const outSkills = [], ids = new Set();
  for (const s of skills) {
    if (!isObj(s) || typeof s.id !== "string" || !SKILL_ID.test(s.id) || ids.has(s.id) || !isObj(s.files)) return fail("damaged");
    ids.add(s.id);
    const sname = str(s.name, L.name, { min: 1, dflt: s.id }), description = str(s.description, L.skillDescription, { dflt: "" });
    if (sname === null || description === null) return fail("damaged");
    const names = Object.keys(s.files).sort();
    if (names.length === 0 || names.length > L.skillFiles || !names.includes("SKILL.md")) return fail("damaged");
    const files = {};
    for (const f of names) {
      const body = clean(s.files[f]);
      if (!SKILL_FILE.test(f) || typeof body !== "string" || body.length > L.skillFileChars) return fail("damaged");
      files[f] = body;
    }
    outSkills.push({ id: s.id, name: sname, description, files });
  }
  const payload = { v: SHARE_VERSION, name, title, instructions, shape, color, ...(model ? { model } : {}), tools: outTools, skills: outSkills };
  return { ok: true, payload, hiddenRemoved: removed };
}

/**
 * Every string with hidden characters removed (stripHidden), whether anything was removed, and a flag for each
 * field that reads like an attempt to instruct the AI (shown, never blocked).
 */
export function scanShare(payload) {
  let removed = false;
  const clean = (s) => { const r = stripHidden(s); if (r.text !== s) removed = true; return r.text; };
  const flags = [];
  const flag = (field, ...texts) => { if (texts.some((t) => looksLikeInjection(t))) flags.push({ field, kind: "injection" }); };
  const out = {
    ...payload,
    name: clean(payload.name), title: clean(payload.title), instructions: clean(payload.instructions),
    tools: payload.tools.map((t) => ({ catalogId: clean(t.catalogId), name: clean(t.name) })),
    skills: payload.skills.map((s) => ({ id: s.id, name: clean(s.name), description: clean(s.description), files: Object.fromEntries(Object.entries(s.files).map(([f, b]) => [f, clean(b)])) })),
  };
  flag("name", out.name);
  flag("title", out.title);
  flag("instructions", out.instructions);
  for (const t of out.tools) flag(`tool:${t.name}`, t.name);
  for (const s of out.skills) flag(`skill:${s.id}`, s.name, s.description, ...Object.values(s.files));
  return { payload: out, hiddenRemoved: removed, flags };
}

// Every pattern here is linear in the text: no unbounded repeat that can overlap another (a crafted SKILL.md of
// 64k newlines or 64k "curl " must not stall the host, the renderer or a browser).
const ALLOWED_TOOLS = /^allowed-tools[ \t]{0,20}:([^\n]{0,2000})/im;
const CODE_TOOL = /(?:^|[ \t,[("'])(?:Bash|code|code_execution|CodeExecution)\b/i;
const FENCE = /^[ \t]{0,20}(?:```|~~~)[ \t]{0,20}(?:sh|bash|zsh|shell|console|python3?|py|js|javascript|mjs|ts|typescript|node)\b/im;
/** "| sh", "| sudo bash", …: found first, then the few hundred characters before it on its line are checked. */
const PIPE_SH = /\|[ \t]{0,20}(?:sudo[ \t]{1,20})?(?:ba|z|da)?sh\b/g;
const FETCHER = /\b(?:curl|wget)\b/i;
const pipesToShell = (t) => {
  for (const m of t.matchAll(PIPE_SH)) {
    // Only the 400 characters before the pipe are looked at, and the line break is searched within them alone.
    const win = t.slice(Math.max(0, m.index - 400), m.index);
    if (FETCHER.test(win.slice(win.lastIndexOf("\n") + 1))) return true;
  }
  return false;
};
/** True when a skill can run code: Bash or code in allowed-tools, a fenced shell or script block, or curl … | sh. */
export function runsCode(files) {
  for (const body of Object.values(files || {})) {
    const t = String(body ?? "");
    const at = ALLOWED_TOOLS.exec(t);
    if ((at && CODE_TOOL.test(at[1])) || FENCE.test(t) || pipesToShell(t)) return true;
  }
  return false;
}

/* ---- bytes ---- */
function toB64u(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
async function pipe(bytes, stream, cap) {
  const w = stream.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const r = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { r.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The canonical JSON of a validated payload (validateShare fixes the key order). */
export const canonicalJson = (payload) => JSON.stringify(payload);

/** The fragment ("b1.…") for a payload, however long. Throws on an invalid payload. */
export async function encodeShareRaw(payload) {
  const v = validateShare(payload);
  if (!v.ok) throw Object.assign(new Error(v.message), { code: v.code });
  const bytes = await pipe(new TextEncoder().encode(canonicalJson(v.payload)), new CompressionStream("deflate-raw"), Infinity);
  return `b${SHARE_VERSION}.${toB64u(bytes)}`;
}

/** The fragment for a payload; a Bot too big for a link throws { code: "too-big", length }. */
export async function encodeShare(payload) {
  const f = await encodeShareRaw(payload);
  if (f.length > SHARE_LIMITS.linkMaxChars) throw Object.assign(new Error(SHARE_MESSAGES["too-big"]), { code: "too-big", length: f.length });
  return f;
}

/** A link, an app link or a bare fragment → { ok, payload } or { ok: false, code, message } (never throws). */
export async function decodeShare(input) {
  try {
    const f = fragmentOf(input) ?? String(input ?? "").trim();
    if (f.length > SHARE_LIMITS.decodeMaxChars) return fail("too-long");
    const m = /^b(\d{1,6})\.([\s\S]*)$/.exec(f);
    if (!m) return fail("damaged");
    const n = Number(m[1]);
    if (n > SHARE_VERSION) return fail("newer");
    if (n !== SHARE_VERSION) return fail("damaged");
    const bytes = fromB64u(m[2]);
    if (!bytes) return fail("damaged");
    let raw;
    try { raw = await pipe(bytes, new DecompressionStream("deflate-raw"), SHARE_LIMITS.inflateMaxBytes); } catch { return fail("damaged"); }
    if (!raw) return fail("damaged");
    let json;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return fail("damaged"); }
    const v = validateShare(json);
    return v.ok ? v : fail("damaged");
  } catch {
    return fail("damaged");
  }
}

/** The "b1.…" part of a web link, an app link or a pasted fragment; null when there is none. */
export function fragmentOf(input) {
  const s = String(input ?? "").trim();
  const hash = s.indexOf("#");
  const f = hash >= 0 ? s.slice(hash + 1) : s;
  return /^b\d{1,6}\./.test(f) ? f : null;
}

export function shareLinks(fragment, site = SHARE_SITE) {
  return { web: `${String(site).replace(/\/+$/, "")}/bot#${fragment}`, app: `synapse://import#${fragment}` };
}

/** SHA-256 (hex) of the canonical payload: the same Bot added twice is recognised by it. */
export async function shareHash(payload) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---- a .botpack from a payload (the website's Save .botpack): no memories, no routines, no author ---- */
export function botpackFiles(payload, id, now = 0) {
  const p = payload;
  const template = {
    id, name: p.name, sourceBotId: null, visibility: "local", createdAt: now, updatedAt: now,
    manifest: {
      profile: { name: p.name, title: p.title, description: p.instructions, avatarShape: p.shape, avatarColor: p.color, ...(p.model ? { model: p.model } : {}) },
      skills: p.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
      memories: [], routines: [], plugins: p.tools.map((t) => ({ catalogId: t.catalogId, name: t.name })),
    },
  };
  const files = { "template.json": JSON.stringify(template, null, 2), "memories.md": "" };
  for (const s of p.skills) for (const [f, body] of Object.entries(s.files)) files[`skills/${s.id}/${f}`] = body;
  return files;
}

let CRC;
function crc32(b) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A zip of the files, stored (no compression): enough for a .botpack the app reads. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const local = [], central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff], u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, body] of Object.entries(files)) {
    const n = enc.encode(name), data = typeof body === "string" ? enc.encode(body) : body, crc = crc32(data);
    const head = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0)];
    local.push(new Uint8Array([...u32(0x04034b50), ...head]), n, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...head, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0), count = Object.keys(files).length;
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
