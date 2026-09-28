/**
 * The public-tree scan: what may go into the public repo, and whether any of it still carries material
 * that must not (bug-log 282).
 *
 * The public tree is every file git would commit here (tracked, plus untracked files that are not
 * ignored) minus the paths listed in docs/public-repo-exclude.md. Every one of those files is read, of
 * every type, binary included, and matched case-insensitively against three families of patterns:
 *
 *   - "reference": the name of the product this app began as a clone of, and its maker;
 *   - "personal":  the owner's name, email, home folder and machine name, and real-looking tailnet names;
 *   - "notice":    a note that records a still-open weakness (those live in docs/private/security-notes.md).
 *
 * The patterns are written so this file does not match itself (a character class splits each word).
 *
 * A second check, `copyHits`, looks for copy retired from the reference product: model-facing and UI
 * sentences that were once taken from it word for word. It compares hashes of word runs
 * (scripts/retired-copy.json), so the retired sentences themselves are not published again, and it reads
 * each file reversed, with split string literals joined and with base64 runs decoded too, so no encoded copy
 * of them is published either.
 * Runs under plain `node` (type stripping): `node scripts/public-scan.ts` prints every hit and exits 1
 * when there is one. Only erasable TypeScript and node: imports here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXCLUDE_DOC = "docs/public-repo-exclude.md";

export interface Rule { family: "reference" | "personal" | "notice"; label: string; re: RegExp }

/** A key-shaped test value that is plainly a placeholder: a counting run, a repeated letter, an alternating pattern. */
const PLACEHOLDER = "[A-Za-z0-9_-]*(?:0123456|abcdefg|ABCDEFG|AAAAAA|A1b2C3|AbCdEf)";

export const RULES: Rule[] = [
  // Not "ngrok": a tunnelling service the courier list names.
  { family: "reference", label: "reference product name", re: /(?<!n)g[r]ok/i },
  { family: "reference", label: "reference product maker", re: /\bx[a]i\b|\bx\.[a]i\b/i },
  { family: "personal", label: "owner's name", re: /\blu[k]e\b|lu[k]e[\s._-]*h[o]rn/i },
  { family: "personal", label: "owner's machine name", re: /\blu[k]es-m/i },
  { family: "personal", label: "owner's email", re: /h[o]rnsons/i },
  { family: "personal", label: "owner's home folder", re: /\/Users\/lu[k]e/i },
  { family: "personal", label: "a real-looking tailnet name", re: /\btail[0-9a-f]{4,}\.ts\.net\b/i },
  // Bug 290: the reference product's other names, the owner's other projects and repos, hardware and network ids, keys.
  { family: "reference", label: "reference product's other names", re: /\bany[s]phere\b|\bspace[\s-]?x[\s-]?[a]i\b|\bcurs[o]r (lab|ide|agent|composer)\b|co-authored-by: curs[o]r/i },
  { family: "personal", label: "owner's other project", re: /\bjar[v]is\b/i },
  { family: "personal", label: "owner's private repo", re: /ny[f]eblade\/bots-app/i },
  { family: "personal", label: "a hardware (MAC) address", re: /\b(?!00[:-]00[:-]5e[:-]00[:-]53[:-])(?!(?:00[:-]){5}00\b)(?!(?:ff[:-]){5}ff\b)[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}\b/i },
  { family: "personal", label: "a tailnet (100.64/10) address", re: /\b100\.(?!64\.0\.)(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { family: "personal", label: "a private key block", re: /-----BEGIN (?:[A-Z]+ )?PRIV[A]TE KEY-----/ },
  { family: "personal", label: "a real-format API key or token", re: new RegExp(`\\b(?:sk-ant-(?:api|admin|oat)\\d\\d-(?!synproxy-|macproxy-)(?!${PLACEHOLDER})[A-Za-z0-9_-]{24,}|gh[pousr]_(?!${PLACEHOLDER})[A-Za-z0-9]{36}\\b)`) },
  { family: "notice", label: "a note on an unfixed weakness", re: /known resid[u]al|resid[u]al (same-uid )?risk|not covered, by ch[o]ice/i },
  // Bug 293: a code comment that records an accepted gap (the word, then a colon or a note in brackets and a colon).
  { family: "notice", label: "an accepted-gap comment", re: /\bResid[u]al(?: \([^)]*\))?:|resid[u]al is accepted/ },
];

/** The exclude list: every line of the fenced `paths` block in docs/public-repo-exclude.md. */
export function readExcludes(root: string): string[] {
  const doc = fs.readFileSync(path.join(root, EXCLUDE_DOC), "utf8");
  const block = /```paths\n([\s\S]*?)```/.exec(doc);
  if (!block) throw new Error(`${EXCLUDE_DOC} has no \`\`\`paths block`);
  return block[1].split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
}

const SPECIAL = new RegExp("[.+?^$" + "{}()|[\\]\\\\]", "g");
function escapeRe(s: string): string { return s.replace(SPECIAL, "\\$&"); }
const ANY_DIRS = "**" + "/";
const ANY_DIRS_RE = "(?:.*" + "/)?";
const DIR_TAIL_RE = "(" + "/.*)?";

/** `dir/` excludes the folder, `**` any run of folders (or none, before a slash), `*` any run within one name; anything else is one file. */
export function excludeMatcher(patterns: string[]): (rel: string) => boolean {
  const esc = (part: string): string => part.split("*").map(escapeRe).join("[^/]*");
  const res = patterns.map((p) => {
    const dir = p.endsWith("/");
    const segs = (dir ? p.slice(0, -1) : p).split(ANY_DIRS);
    const body = segs.map((seg) => seg.split("**").map(esc).join(".*")).join(ANY_DIRS_RE);
    return new RegExp("^" + body + (dir ? DIR_TAIL_RE : "") + "$");
  });
  return (rel) => res.some((r) => r.test(rel));
}

function walk(root: string, dir = "", out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Every file that would go into the public repo from `root`. Falls back to a walk where there is no git. */
export function publicFiles(root: string): string[] {
  let all: string[];
  try {
    all = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 64 << 20 })
      .toString("utf8").split("\0").filter(Boolean);
  } catch {
    all = walk(root);
  }
  const excluded = excludeMatcher(readExcludes(root));
  return [...new Set(all)].filter((f) => !excluded(f) && fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
}

export interface Hit { file: string; line: number; label: string; family: Rule["family"]; text: string }

/** The reference product's name and its maker's, for a test that checks a screen or an answer never shows them. */
export const REFERENCE_NAME = new RegExp(RULES.filter((r) => r.family === "reference").map((r) => r.re.source).join("|"), "i");

/** Checks each file's path, then reads it as bytes (latin1, so a binary file is scanned too) and reports every rule that matches, per line. */
export function scan(root: string, files: string[], rules: Rule[] = RULES): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    for (const r of rules) if (r.re.test(file)) hits.push({ file, line: 0, label: r.label, family: r.family, text: `(the file's path) ${file}` });
    const bytes = fs.readFileSync(path.join(root, file));
    // A binary file (any NUL byte) is read the way `strings` reads it: its runs of 8 or more printable
    // ASCII characters, one per line, so text inside an image or a bundle is found and noise is not.
    const lines = bytes.includes(0)
      ? (bytes.toString("latin1").match(/[\x20-\x7e]{8,}/g) ?? [])
      : bytes.toString("latin1").split("\n");
    lines.forEach((l, i) => {
      for (const r of rules) if (r.re.test(l)) hits.push({ file, line: i + 1, label: r.label, family: r.family, text: l.trim().slice(0, 120) });
    });
  }
  return hits;
}

/** Words as the copy check sees them: lower case, apostrophes dropped, everything else a separator. */
export function words(text: string): { w: string; at: number }[] {
  return [...text.toLowerCase().replace(/[\u2019']/g, "\u0000").matchAll(/[a-z0-9\u0000]+(?:[-_][a-z0-9\u0000]+)*/g)]
    .map((m) => ({ w: m[0].replace(/\u0000/g, ""), at: m.index })).filter((x) => x.w);
}

/** Runs of this many words are compared; a shorter retired line is compared whole (3 words at least). */
export const SHINGLE = 7;
const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h; };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const key = (run: string, n: number): string => `${n}:${fnv(run).toString(16).padStart(8, "0")}:${sha(run)}`;

/** The hashes `copyHits` compares: every SHINGLE-word run of a long line, or a short line whole. */
export function shingleHashes(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const w = words(l).map((x) => x.w);
    if (w.length >= SHINGLE) for (let i = 0; i + SHINGLE <= w.length; i++) out.add(key(w.slice(i, i + SHINGLE).join(" "), SHINGLE));
    else if (w.length >= 3) out.add(key(w.join(" "), w.length));
  }
  return out;
}

export const RETIRED_COPY_FILE = "scripts/retired-copy.json";
export function retiredCopy(root: string): Set<string> {
  return new Set(JSON.parse(fs.readFileSync(path.join(root, RETIRED_COPY_FILE), "utf8")).hashes as string[]);
}

const TEXT_FILE = /\.(ts|tsx|mts|mjs|cjs|js|md|txt|json|jsonl|sh|swift|py|css|html|plist|ya?ml)$|(^|\/)[^./]+$/;

/**
 * The forms a file is read in, beyond the text itself: backwards (a sentence stored reversed), with string literals
 * that split a word joined up ("Built like G" + "rok"), and every base64 run decoded (forwards and backwards). Each
 * gives the text to match and a map from a place in it back to a place in the file.
 */
interface Form { label: string; text: string; at: (i: number) => number }
const SPLIT_JOIN = /(["'`])\s*[,+]\s*(["'`])/g;
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const reversed = (label: string, text: string, at: (i: number) => number): Form => ({ label, text: text.split("").reverse().join(""), at: (i) => at(text.length - 1 - i) });

function forms(text: string): Form[] {
  const out: Form[] = [{ label: "retired copy", text, at: (i) => i }, reversed("retired copy (reversed)", text, (i) => i)];
  if (SPLIT_JOIN.test(text)) {
    SPLIT_JOIN.lastIndex = 0;
    let joined = "";
    const map: number[] = [];
    let last = 0;
    for (const m of text.matchAll(SPLIT_JOIN)) {
      for (let i = last; i < m.index; i++) { joined += text[i]; map.push(i); }
      last = m.index + m[0].length;
    }
    for (let i = last; i < text.length; i++) { joined += text[i]; map.push(i); }
    out.push({ label: "retired copy (split)", text: joined, at: (i) => map[i] ?? 0 });
  }
  for (const m of text.matchAll(BASE64_RUN)) {
    const bytes = Buffer.from(m[0], "base64");
    let printable = 0;
    for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x09 || b >= 0x80) printable++;
    if (bytes.length < 12 || printable < bytes.length * 0.95) continue;
    const decoded = bytes.toString("utf8");
    out.push({ label: "retired copy (base64)", text: decoded, at: () => m.index });
    out.push(reversed("retired copy (base64, reversed)", decoded, () => m.index));
  }
  return out;
}

/**
 * Every place a public text file repeats retired copy (across line breaks too: prompts wrap), whether written out,
 * reversed, split across string literals or base64-encoded. One hit per line, labelled with the form it was found in.
 */
export function copyHits(root: string, files: string[], retired: Set<string> = retiredCopy(root)): Hit[] {
  // Keyed by run length, then by the run's FNV hash (a number), so each run is hashed once, incrementally, as it
  // grows word by word; the SHA-256 part is computed only for a run whose FNV hash is already a candidate.
  const bySize = new Map<number, Map<number, string[]>>();
  for (const k of retired) {
    const [n, f] = k.split(":");
    const m = bySize.get(Number(n)) ?? new Map<number, string[]>();
    bySize.set(Number(n), m);
    const h = parseInt(f!, 16);
    m.set(h, [...(m.get(h) ?? []), k]);
  }
  const maxN = Math.max(0, ...bySize.keys());
  const hits: Hit[] = [];
  for (const file of files) {
    if (!TEXT_FILE.test(file) || file === RETIRED_COPY_FILE) continue;
    const buf = fs.readFileSync(path.join(root, file));
    if (buf.length > 4 << 20 || buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const seen = new Set<number>();
    for (const form of forms(text)) {
      const w = words(form.text);
      for (let i = 0; i < w.length; i++) {
        let h = 0x811c9dc5;
        for (let n = 1; n <= maxN && i + n <= w.length; n++) {
          const word = w[i + n - 1]!.w;
          if (n > 1) h = Math.imul(h ^ 32, 0x01000193) >>> 0;
          for (let c = 0; c < word.length; c++) h = Math.imul(h ^ word.charCodeAt(c), 0x01000193) >>> 0;
          const cands = bySize.get(n)?.get(h);
          if (!cands) continue;
          const run = w.slice(i, i + n).map((x) => x.w).join(" ");
          if (!cands.includes(key(run, n))) continue;
          const line = text.slice(0, form.at(w[i]!.at)).split("\n").length;
          if (!seen.has(line)) {
            seen.add(line);
            hits.push({ file, line, label: form.label, family: "reference", text: lines[line - 1]!.trim().slice(0, 120) });
          }
          break;
        }
      }
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = publicFiles(root);
  const hits = [...scan(root, files), ...copyHits(root, files)];
  for (const h of hits) console.log(`${h.file}:${h.line}: [${h.label}] ${h.text}`);
  console.log(`${files.length} public files scanned, ${hits.length} hits`);
  process.exit(hits.length ? 1 : 0);
}
