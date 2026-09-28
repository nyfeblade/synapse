/**
 * Bug 107 + bug 152: a Bot's reply as it should SOUND, for both engines (Kokoro and Apple).
 *
 * Markdown is never read aloud and code is never read: a fenced block, a shell command, a diff, a
 * stack trace, a JSON/XML blob, a hash or any other unspeakable run gets ONE short, varied spoken
 * mention instead ("the Python's in the chat"). Emoji are dropped, a URL is "a link", and numbers,
 * money, percents, times, dates, ordinals, ranges, units and common abbreviations are said the way a
 * person says them. Punctuation survives: Kokoro's inflection comes from the commas, periods,
 * question marks, exclamation marks and dashes, so nothing here flattens a "?" or a "!" into a ".".
 * The pause between sentences is the helper's (pauseMs), not text.
 */

const UNITS: Record<string, [string, string]> = {
  km: ["kilometer", "kilometers"], cm: ["centimeter", "centimeters"], mm: ["millimeter", "millimeters"],
  mi: ["mile", "miles"], ft: ["foot", "feet"], kg: ["kilogram", "kilograms"], lb: ["pound", "pounds"], lbs: ["pound", "pounds"],
  mph: ["mile per hour", "miles per hour"], kph: ["kilometer per hour", "kilometers per hour"], "km/h": ["kilometer per hour", "kilometers per hour"],
  ns: ["nanosecond", "nanoseconds"], ms: ["millisecond", "milliseconds"], sec: ["second", "seconds"], min: ["minute", "minutes"], hr: ["hour", "hours"], hrs: ["hour", "hours"],
  kb: ["kilobyte", "kilobytes"], mb: ["megabyte", "megabytes"], gb: ["gigabyte", "gigabytes"], tb: ["terabyte", "terabytes"],
  kib: ["kibibyte", "kibibytes"], mib: ["mebibyte", "mebibytes"], gib: ["gibibyte", "gibibytes"], tib: ["tebibyte", "tebibytes"],
  kbps: ["kilobit per second", "kilobits per second"], mbps: ["megabit per second", "megabits per second"], gbps: ["gigabit per second", "gigabits per second"],
  px: ["pixel", "pixels"],
  ghz: ["gigahertz", "gigahertz"], mhz: ["megahertz", "megahertz"], khz: ["kilohertz", "kilohertz"], hz: ["hertz", "hertz"],
  "°f": ["degree Fahrenheit", "degrees Fahrenheit"], "°c": ["degree Celsius", "degrees Celsius"], "°": ["degree", "degrees"],
};
const UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?) ?(${Object.keys(UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/[/.]/g, "\\$&")).join("|")})(?![\\p{L}\\d])`, "giu");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_DAY_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b\.?\s+(\d{1,2})\b(?![.:]?\d)/g;
const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
  "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];
const SCALES: Record<string, string> = { k: "thousand", m: "million", b: "billion", t: "trillion", thousand: "thousand", million: "million", billion: "billion", trillion: "trillion" };
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function ordinalSuffix(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** "4.82" -> "4 point 8 2": a person reads the cents of a big number digit by digit. */
function digitsOut(n: string): string {
  const [whole, frac] = n.split(".");
  return frac ? `${whole} point ${frac.split("").join(" ")}` : `${whole}`;
}

function money(whole: string, frac: string | undefined): string {
  if (!frac) return `${whole} ${whole === "1" ? "dollar" : "dollars"}`;
  if (frac === "00") return `${whole} dollars`;
  if (frac.length === 2) return `${whole} dollars ${frac}`;
  return `${digitsOut(`${whole}.${frac}`)} dollars`;
}

function time(h: string, m: string, ampm: string | undefined): string {
  const suffix = ampm ? ` ${ampm.replace(/\./g, "").toUpperCase()}` : "";
  if (m === "00") return ampm ? `${Number(h)}${suffix}` : Number(h) >= 13 || Number(h) === 0 ? `${Number(h)} hundred` : `${Number(h)} o'clock`;
  return `${Number(h)} ${m.startsWith("0") ? `oh ${m[1]}` : m}${suffix}`;
}

function spoken(line: string): string {
  return line
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "an email address")
    .replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, "a link")
    .replace(new RegExp(UUID_RE.source, "gi"), "an ID")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, "a hash")
    .replace(/\b(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{24,}={0,2}/g, "a hash")
    .replace(/\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    // Dates: 2026-09-21 and "Sept 21" both become the way a person says them.
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
      const name = MONTHS[Number(mo) - 1];
      const day = Number(d);
      return name && day >= 1 && day <= 31 ? `${name} ${day}${ordinalSuffix(day)}, ${y}` : m;
    })
    .replace(MONTH_DAY_RE, (m, mon: string, d: string) => {
      const name = MONTHS.find((x) => x.slice(0, 3).toLowerCase() === mon.slice(0, 3).toLowerCase());
      const day = Number(d);
      return name && day >= 1 && day <= 31 ? `${name} ${day}${ordinalSuffix(day)}` : m;
    })
    .replace(/\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?![\w:])/gi, (_, h: string, m: string, ap: string | undefined) => time(h, m, ap))
    .replace(/\b(\d{1,2})\s?([ap])\.?m\.?(?!\w)/gi, (_, h: string, ap: string) => `${Number(h)} ${ap.toUpperCase()}M`)
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\$(\d+(?:\.\d+)?)\s*(k|m|b|t|thousand|million|billion|trillion)\b/gi, (_, n: string, s: string) => `${digitsOut(n)} ${SCALES[s.toLowerCase()]} dollars`)
    .replace(/\$(\d+)(?:\.(\d+))?/g, (_, d: string, c: string | undefined) => money(d, c))
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(UNIT_RE, (_, n: string, u: string) => { const w = UNITS[u.toLowerCase()]!; return `${n} ${n === "1" ? w[0] : w[1]}`; })
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, (m, d: string) => ORDINALS[Number(d)] || m)
    .replace(/(?<![\d-])(\d+)\s?[-–—]\s?(\d+)\b(?!-\d)/g, "$1 to $2")
    .replace(/\be\.g\.,?/gi, "for example")
    .replace(/\bi\.e\.,?/gi, "that is")
    .replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/\betc\.(?=$|\s+["'A-Z])/gi, "et cetera.")
    .replace(/\betc\.?/gi, "et cetera")
    .replace(/\bapprox\.?(?=\s)/gi, "approximately")
    .replace(/\bDr\./g, "Doctor")
    .replace(/\bProf\./g, "Professor")
    .replace(/\bMrs\./g, "Missus")
    .replace(/\bMr\./g, "Mister")
    .replace(/\s&\s/g, " and ");
}

/* ------------------------------------------------------------------ code, skipped ---- */

/** Spoken (and displayed — CodeBlock.tsx reuses this) names for fence info strings: ```python, ```ts path/to/foo.ts, ```sh. */
export const LANGUAGES: Record<string, string> = {
  py: "Python", python: "Python", ts: "TypeScript", tsx: "TypeScript", typescript: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  json: "JSON", jsonc: "JSON", html: "HTML", htm: "HTML", css: "CSS", scss: "CSS", sql: "SQL",
  sh: "shell command", bash: "shell command", zsh: "shell command", shell: "shell command", console: "shell command", ps1: "shell command",
  go: "Go", rs: "Rust", rust: "Rust", java: "Java", c: "C", h: "C", cpp: "C plus plus", "c++": "C plus plus", cc: "C plus plus",
  cs: "C sharp", csharp: "C sharp", rb: "Ruby", ruby: "Ruby", php: "PHP", swift: "Swift", kt: "Kotlin", kotlin: "Kotlin",
  yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", svg: "SVG", md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff", dockerfile: "Dockerfile", makefile: "Makefile", graphql: "GraphQL", proto: "protobuf", lua: "Lua", r: "R", m: "MATLAB",
};

export function languageName(info: string): string {
  const tokens = info.trim().replace(/[{}]/g, " ").split(/[\s:,]+/).filter(Boolean);
  for (const token of tokens) {
    const direct = LANGUAGES[token.toLowerCase().replace(/^\./, "")];
    if (direct) return direct;
    const ext = /\.([A-Za-z0-9+]+)$/.exec(token);
    const byExt = ext ? LANGUAGES[ext[1]!.toLowerCase()] : undefined;
    if (byExt) return byExt;
  }
  return "";
}

/** A deterministic phrase picker: rotates per kind, and never says the same line twice in a row. */
function phraser(): (kind: string, options: string[]) => string {
  const seen: Record<string, number> = {};
  let last = "";
  return (kind, options) => {
    let i = seen[kind] ?? 0;
    let pick = options[i % options.length]!;
    if (pick === last && options.length > 1) { i += 1; pick = options[i % options.length]!; }
    seen[kind] = i + 1;
    last = pick;
    return pick;
  };
}

type Say = ReturnType<typeof phraser>;

function codeMention(info: string, say: Say): string {
  const name = languageName(info);
  return name
    ? `${say(`block:${name}`, [`the ${name}'s in the chat`, `I put the ${name} in the chat`, `that ${name}'s in the chat`])}.`
    : `${say("block", ["the code's in the chat", "I put the snippet in the chat", "the snippet's in the chat"])}.`;
}

const SKIP_LINES: Record<string, string[]> = {
  shell: ["the command's in the chat", "I put the command in the chat", "that command's in the chat"],
  diff: ["the diff's in the chat", "I put the diff in the chat", "that diff's in the chat"],
  trace: ["the stack trace's in the chat", "I put the trace in the chat", "that trace's in the chat"],
  data: ["the data's in the chat", "I put the data in the chat", "that data's in the chat"],
  code: ["it's in the chat", "I put that in the chat", "that part's in the chat"],
};

const SHELL_WORDS = /^(npm|npx|pnpm|yarn|bun|node|deno|git|cd|ls|rm|mv|cp|mkdir|touch|cat|echo|sudo|brew|curl|wget|chmod|chown|ssh|scp|rsync|docker|kubectl|make|python|python3|pip|pip3|pytest|cargo|rustup|go|java|mvn|gradle|sed|awk|grep|rg|find|tar|zip|unzip|open|vim|nano|export|source|systemctl|apt|apt-get|gem|bundle|rails|composer|php|dotnet|swift|xcodebuild|pod|adb|terraform|aws|gcloud|az|psql|mysql|redis-cli|vitest|jest|eslint|prettier|tsc|vite|webpack|next|expo|killall|ps|df|du|which|whoami|sh|bash|zsh|conda|poetry|uv)$/;

function isShellLine(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^[$%]\s+\S/.test(t)) return true;
  const parts = t.split(/\s+/);
  if (parts.length < 2 || !SHELL_WORDS.test(parts[0]!)) return false;
  const rest = parts.slice(1).join(" ");
  const strong = /(^|\s)-{1,2}[A-Za-z]/.test(rest) || /[|&><]/.test(rest) || /\S+\/\S/.test(rest) || /^["'].*["']$/.test(rest) || /\.\w{1,5}\b/.test(rest);
  const wordy = /\b(the|a|an|to|is|are|was|were|and|or|for|with|of|in|on|it|you|we|this|that|my|your|but|so|if|when|then|than|be|do|does|did|can|will|would|should|my)\b/i.test(rest);
  return strong || !wordy;
}

function isDiffLine(raw: string): boolean {
  const t = raw.replace(/\s+$/, "");
  if (/^(\+\+\+|---)\s+\S/.test(t) || /^@@[\s-]/.test(t) || /^diff --git /.test(t)) return true;
  return /^[+-](?![-+*\s])\S/.test(t) && !/^[+-]?\d/.test(t);
}

function isTraceLine(raw: string): boolean {
  const t = raw.trim();
  return /^at\s+[\w$.<>[\]/\\:-]+\s*[(:]/.test(t)
    || /^Traceback\b/.test(t)
    || /^File\s+".+",\s*line\s+\d+/.test(t)
    || /^Caused by:/.test(t)
    || /^\w*(?:Error|Exception)\s*:\s/.test(t);
}

function isBlobLine(raw: string): boolean {
  const t = raw.trim();
  if (/^[{}]/.test(t)) return true;
  if (/^\[\s*[{"'\d]/.test(t) || /^\[\s*\]/.test(t) || /^\],?$/.test(t)) return true;
  if (/^"[^"]*"\s*:/.test(t)) return true;
  return /^<[!/?a-zA-Z][^>]*>/.test(t);
}

/** A lone unspeakable token: a hash, a UUID, base64, a long hex or id. */
function isTokenLine(raw: string): boolean {
  const t = raw.trim();
  if (/\s/.test(t) || t.length < 16) return false;
  if (!/^[A-Za-z0-9+/=_.:-]+$/.test(t)) return false;
  return /\d/.test(t) || /[+=/_:]/.test(t);
}

function isProse(t: string): boolean {
  const words = t.trim().split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const symbols = (t.match(/[{}<>[\]()=;|\\/*_`~^$#@+]/g) ?? []).length;
  return symbols / t.length < 0.06;
}

/** Which "never read this" bucket a line falls in, or "" when it is speakable prose. */
function skipKind(raw: string): string {
  // Inline code spans are handled one by one later, so they never make a prose line look like code.
  const t = raw.replace(/`[^`]*`/g, "code").trim();
  if (!t) return "";
  if (isShellLine(t)) return "shell";
  if (isDiffLine(t)) return "diff";
  if (isTraceLine(t)) return "trace";
  if (isBlobLine(t)) return "data";
  if (isTokenLine(t)) return "code";
  const probe = t.replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, "a link").replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "an email");
  if (probe.length > 80 && !isProse(probe)) return "code";
  return "";
}

/* ---------------------------------------------------------------------- inline code ---- */

function inlineCode(raw: string, say: Say): string {
  const c = raw.trim();
  if (!c) return "";
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(c)) return "a link";
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(c)) return "an email address";
  if (isShellLine(c)) return say("cmd", ["the command in the chat", "that command in the chat", "the command I put in the chat"]);
  // Short and speakable: `main`, `README`, `dark mode`, `42`.
  if (/^[A-Za-z]+(?: [A-Za-z]+)?$/.test(c) && c.length <= 24) return c;
  if (/^\d+$/.test(c)) return c;
  // A path is its last segment, spoken bare: `src/app/main.ts` -> "main".
  if (/[/\\]/.test(c) || /^[\w.-]+\.[A-Za-z]\w{0,4}$/.test(c)) {
    const segment = c.split(/[/\\]/).filter(Boolean).pop() ?? "";
    const base = segment.replace(/\.[A-Za-z0-9]{1,6}$/, "").replace(/[_-]+/g, " ").trim();
    if (/^[A-Za-z][A-Za-z ]*$/.test(base) && base.length <= 24) return base;
    return say("code", ["the file in the chat", "that file in the chat"]);
  }
  if (/\(/.test(c)) return say("fn", ["the function in the chat", "that function in the chat", "the function I put in the chat"]);
  return say("code", ["the code in the chat", "that bit in the chat", "the code I put in the chat"]);
}

/* -------------------------------------------------------------------------- assembly ---- */

type Unit = { text: string } | { skip: string };

function prose(raw: string, say: Say): string {
  const stripped = raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, (_, code: string) => inlineCode(code, say))
    .replace(/^\s*(?:#{1,6}\s+|>\s?)/, "")
    .replace(/\*\*|__|[*_~`]/g, "");
  return spoken(stripped).replace(/\s+/g, " ").trim();
}

const LIST_RE = /^\s*(?:[-+*]|\d+[.)])\s+(.*)$/;
const TABLE_TAIL = "and a few more in the chat";

function listContent(line: string): string {
  return (LIST_RE.exec(line)?.[1] ?? "").replace(/^\[[ xX]\]\s*/, "").trim();
}

function pushLine(units: Unit[], text: string, say: Say): void {
  if (!text) return;
  const kind = skipKind(text);
  if (kind) { units.push({ skip: kind }); return; }
  const said = prose(text, say);
  if (said) units.push({ text: said });
}

export function speechText(md: string): string {
  const say = phraser();
  const src = md.replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  let i = 0;

  while (i < src.length) {
    const line = src[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence) {
      const closer = fence[1]!.startsWith("`") ? /^\s{0,3}`{3,}\s*$/ : /^\s{0,3}~{3,}\s*$/;
      i += 1;
      while (i < src.length && !closer.test(src[i]!)) i += 1;
      i += 1;
      units.push({ text: codeMention(fence[2] ?? "", say) });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    // A horizontal rule or a setext underline is silent, never a diff.
    if (/^\s{0,3}([-*_=])\1{2,}\s*$/.test(line)) { i += 1; continue; }

    if (/\|/.test(line) && !LIST_RE.test(line)) {
      const rows: string[] = [];
      while (i < src.length && /\|/.test(src[i]!) && src[i]!.trim()) { rows.push(src[i]!); i += 1; }
      const body = rows.filter((r) => !/^[\s|:-]+$/.test(r));
      let more = body.length > 3;
      for (const row of body.slice(0, 3)) {
        const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length > 3) more = true;
        const said = cells.slice(0, 3).map((c) => prose(c, say)).filter(Boolean).join(", ");
        if (said) units.push({ text: said });
      }
      if (more) units.push({ text: TABLE_TAIL });
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < src.length && LIST_RE.test(src[i]!)) { items.push(listContent(src[i]!)); i += 1; }
      for (const item of items.slice(0, 3)) pushLine(units, item, say);
      if (items.length > 3) units.push({ text: TABLE_TAIL });
      continue;
    }

    pushLine(units, line, say);
    i += 1;
  }

  // A run of skipped lines gets one mention between them all, not one per line.
  const lines: string[] = [];
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u]!;
    if ("text" in unit) { lines.push(unit.text); continue; }
    const kind = unit.skip;
    while (u + 1 < units.length && "skip" in units[u + 1]!) u += 1;
    lines.push(`${say(`skip:${kind}`, SKIP_LINES[kind] ?? SKIP_LINES.code!)}.`);
  }

  const spokenLines = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => /[\p{L}\d]/u.test(l));
  return spokenLines
    // Sentence punctuation is prosody: only ever ADD a period, never replace a "?" or a "!".
    .map((l, n) => (n < spokenLines.length - 1 && !/[.!?:;,…—–-]$/.test(l) ? `${l}.` : l))
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}
