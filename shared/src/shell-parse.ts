/**
 * A static shell parser for the fixed-rules engine (./perm-rules). Pure string code (the renderer imports
 * @synapse/shared). It is NOT a shell: it answers "which programs could this text run, with which arguments, and
 * reading/writing which files", conservatively. Anything it can't see through is reported in `opaque`, and the
 * rules engine treats opaque text as ALWAYS ASK (a card), never as allowed.
 *
 * Covers: quoting ('', "", $'', backslash), word joining (s""udo = sudo), ; && || | |& & newlines, ( ) { }
 * groups, $( ) and `` substitutions and <( ) >( ) =( ) process substitutions (parsed recursively), redirects
 * (fd prefixes, heredocs with bodies), comments, reserved words, leading NAME=value assignments, wrapper programs
 * (env, command, exec, nohup, nice, time, timeout, xargs, caffeinate, sudo …), `sh -c "…"` / `eval "…"` bodies,
 * `find -exec … ;`, and cd tracking (with subshell scoping) so relative paths resolve against the real cwd.
 */

export interface ShWord {
  /** The word after quote removal. Known variables ($HOME, $PWD, …) are substituted by the caller's `vars`. */
  text: string;
  /** Contains an expansion whose value can't be known statically ($X, ${X}, $(…), `…`, $((…))). */
  dynamic: boolean;
  /** Contains an unquoted glob or brace-expansion character. */
  glob: boolean;
  /** Some part of it was quoted or escaped. */
  quoted: boolean;
  /** The word's FIRST character was quoted/escaped (so a leading ~ does not expand). */
  headQuoted: boolean;
  /** The literal (non-expanded) parts, for text scans of dynamic words. */
  literal: string;
  /** Process substitutions used as this word (<(…) >(…) =(…)): indexes into ShParse.cmds of their commands' group. */
  procSubst: number | null;
}

export interface ShRedirect { op: string; fd: number | null; target: ShWord | null; heredoc: string | null }

export type ShOrigin = "top" | "subst" | "procsubst" | "c-string" | "eval" | "exec" | "xargs" | "heredoc" | "sudo" | "su";

export interface ShCmd {
  /** The program and its arguments, wrappers peeled (argv[0] is the program actually run). */
  argv: ShWord[];
  /** The program name (basename of argv[0]); "" when there is none (assignments only). */
  program: string;
  assigns: string[];
  redirects: ShRedirect[];
  /** Wrapper programs peeled off in front (env, nohup, xargs, …). */
  wrappers: string[];
  /** The directory this command runs in (cd tracked); null = unknown. */
  cwd: string | null;
  /** Where its standard input comes from. */
  stdin: "pipe" | "heredoc" | "file" | "herestring" | "procsubst" | null;
  /** It is a shell or language interpreter taking its program from standard input (or a pipe/proc-subst file). */
  programFromInput: boolean;
  /** The program's argument list is partly unknown (xargs, find -exec). */
  argsUnknown: boolean;
  /** Pipeline id and stage (a|b|c = stages 0,1,2 of one pipeline). */
  pipeline: number;
  stage: number;
  depth: number;
  origin: ShOrigin;
  /** Inline program text given to a language interpreter (python -c, node -e, osascript -e …), for text scans. */
  inlineCode: string[];
  /** The group (process substitution) this command belongs to, when origin is procsubst. */
  group: number | null;
}

export interface ShParse {
  cmds: ShCmd[];
  /** Reasons the text can't be analysed statically. Non-empty means: treat as unknown (ask). */
  opaque: string[];
  compound: boolean;
  hasPipe: boolean;
  hasRedirect: boolean;
  hasSubstitution: boolean;
  background: boolean;
}

export interface ShContext {
  cwd: string | null;
  home: string;
  /** Variables whose value is known ($HOME, $USER, $PWD, $TMPDIR…). */
  vars?: Record<string, string>;
}

const MAX_DEPTH = 6;
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "ash", "busybox"]);
/** Language interpreters that can run a program from standard input or an inline flag. */
export const INTERPRETERS: Record<string, string[]> = {
  python: ["-c"], python3: ["-c"], python2: ["-c"], node: ["-e", "--eval", "-p", "--print"], nodejs: ["-e"], deno: ["eval"], bun: ["-e", "--eval"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], osascript: ["-e"], lua: ["-e"], Rscript: ["-e"], swift: ["-e"], tclsh: [], awk: [], jshell: [],
};
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "{", "}", "coproc", "repeat"]);
const SKIP_SEGMENT = new Set(["for", "select", "case", "function", "foreach"]);

interface Tok { t: "word"; w: ShWord; subs: string[] ; procs: { dir: string; text: string }[]; /** The last char of w.text (bug 433: read without flattening a long word). */ last: string }
interface OpTok { t: "op"; v: string; heredoc?: string | null; fd?: number | null }
type Token = Tok | OpTok;

const isNameStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);

/** Bug 433: a brace word whose close couldn't be looked for within the lexer's linear scan budget. */
const BRACE_BUDGET = "a brace expansion too long to check";

/** Index of the char after the matching close of an opener at `i` (src[i] is the opener's last char); -1 when there is
 *  none; -2 when `limit` chars were scanned without finding it. */
function matchClose(src: string, i: number, open: string, close: string, limit = Infinity): number {
  let depth = 1;
  let j = i + 1;
  const end = Math.min(src.length, i + 1 + limit);
  while (j < end) {
    const c = src[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); if (e < 0) return -1; j = e + 1; continue; }
    if (c === "\"") {
      j++;
      while (j < src.length && src[j] !== "\"") { if (src[j] === "\\") j++; j++; }
      j++;
      continue;
    }
    if (c === "`") { let k = j + 1; while (k < src.length && src[k] !== "`") { if (src[k] === "\\") k++; k++; } j = k + 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    j++;
  }
  return end < src.length ? -2 : -1;
}

function ansiC(body: string): string {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/g, (_m, e: string) => {
    if (e[0] === "x" || e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === "c") return String.fromCharCode(e.charCodeAt(1) & 31);
    return ({ n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" } as Record<string, string>)[e] ?? e;
  });
}

const OPS = ["&&", "||", ";;&", ";;", ";&", "|&", "&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<", "|", "&", ";", "(", ")"];

function lex(src: string, opaque: string[], vars: Record<string, string>): Token[] {
  const toks: Token[] = [];
  let cur: Tok | null = null;
  const peek = (): Tok | null => cur;
  const word = (): Tok => (cur ??= { t: "word", w: { text: "", dynamic: false, glob: false, quoted: false, headQuoted: false, literal: "", procSubst: null }, subs: [], procs: [], last: "" });
  /** Appends to the current word's text (and literal, when given). Bug 433: tracks the last char, so the lexer never
   *  re-reads a growing word (a regex on it flattens the string: quadratic on a long hostile token). */
  const append = (s: string, literal: string | null = s): Tok => { const w = word(); if (s) { w.w.text += s; w.last = s[s.length - 1]!; } if (literal) w.w.literal += literal; return w; };
  const quoteMark = (w: ShWord) => { if (w.text === "") w.headQuoted = true; w.quoted = true; };
  const pending: { tok: OpTok; delim: string; strip: boolean }[] = [];
  let expectDelim: { tok: OpTok; strip: boolean } | null = null;
  const flush = () => {
    if (cur) {
      // A heredoc delimiter is the next whole word after << (quoted or not).
      if (expectDelim) { pending.push({ tok: expectDelim.tok, delim: cur.w.text, strip: expectDelim.strip }); expectDelim = null; }
      toks.push(cur);
    }
    cur = null;
  };
  const lit = (s: string) => { append(s); };
  /** $NAME / ${NAME} with a known value substitutes; anything else makes the word dynamic. */
  const variable = (name: string) => {
    const w = word();
    if (Object.prototype.hasOwnProperty.call(vars, name)) { append(vars[name]!, null); return; }
    w.w.dynamic = true;
  };
  let i = 0;
  const n = src.length;
  let braceBudget = 4 * n + 65536;
  /** $… at i; returns the next index. */
  const dollar = (j: number, inDouble: boolean): number => {
    const nx = src[j + 1];
    if (nx === "(" && src[j + 2] === "(") {
      const e = matchClose(src, j + 2, "(", ")");
      if (e < 0 || src[e] !== ")") { opaque.push("unterminated arithmetic"); return n; }
      const inner = src.slice(j + 3, e - 1);
      if (/[`$]\(|`/.test(inner)) opaque.push("command substitution inside arithmetic");
      word().w.dynamic = true;
      return e + 1;
    }
    if (nx === "(") {
      const e = matchClose(src, j + 1, "(", ")");
      if (e < 0) { opaque.push("unterminated $("); return n; }
      const w = word();
      w.subs.push(src.slice(j + 2, e - 1));
      w.w.dynamic = true;
      return e;
    }
    if (nx === "{") {
      const e = matchClose(src, j + 1, "{", "}");
      if (e < 0) { opaque.push("unterminated ${"); return n; }
      const body = src.slice(j + 2, e - 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) variable(body);
      else {
        if (/^\(/.test(body)) opaque.push("zsh parameter flags");
        if (/[`]|\$\(/.test(body)) word().subs.push(...(body.match(/\$\(([^()]*)\)/g) ?? []).map((s) => s.slice(2, -1)));
        word().w.dynamic = true;
      }
      return e;
    }
    if (isNameStart(nx)) {
      let k = j + 1;
      while (k < n && /[A-Za-z0-9_]/.test(src[k]!)) k++;
      variable(src.slice(j + 1, k));
      return k;
    }
    if (nx !== undefined && /[0-9@*#?$!-]/.test(nx)) { word().w.dynamic = true; return j + 2; }
    if (nx === "'" && !inDouble) {
      let k = j + 2;
      while (k < n && src[k] !== "'") { if (src[k] === "\\") k++; k++; }
      if (k >= n) { opaque.push("unterminated $'"); return n; }
      quoteMark(word().w);
      append(ansiC(src.slice(j + 2, k)));
      return k + 1;
    }
    lit("$");
    return j + 1;
  };
  const backtick = (j: number): number => {
    let k = j + 1;
    let body = "";
    while (k < n && src[k] !== "`") {
      if (src[k] === "\\" && k + 1 < n && "`\\$".includes(src[k + 1]!)) { body += src[k + 1]; k += 2; continue; }
      body += src[k]; k++;
    }
    if (k >= n) { opaque.push("unterminated backtick"); return n; }
    const w = word();
    w.subs.push(body);
    w.w.dynamic = true;
    return k + 1;
  };
  const readHeredocs = (j: number): number => {
    let k = j;
    for (const p of pending.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (k >= n) break;
        const e = src.indexOf("\n", k);
        const line = src.slice(k, e < 0 ? n : e);
        k = e < 0 ? n : e + 1;
        const cmp = p.strip ? line.replace(/^\t+/, "") : line;
        if (cmp === p.delim) break;
        lines.push(cmp);
      }
      p.tok.heredoc = lines.join("\n");
    }
    return k;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      flush();
      if (expectDelim) { opaque.push("heredoc without a delimiter"); expectDelim = null; }
      toks.push({ t: "op", v: "\n" });
      i++;
      if (pending.length) i = readHeredocs(i);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    if (c === "#" && !cur) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue; }
      const w = word();
      if (i + 1 < n) { quoteMark(w.w); append(src[i + 1]!); }
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) { opaque.push("unterminated quote"); break; }
      quoteMark(word().w);
      append(src.slice(i + 1, e));
      i = e + 1;
      continue;
    }
    if (c === "\"") {
      const w = word();
      quoteMark(w.w);
      let k = i + 1;
      while (k < n && src[k] !== "\"") {
        const d = src[k]!;
        if (d === "\\" && k + 1 < n && "$`\"\\\n".includes(src[k + 1]!)) { if (src[k + 1] !== "\n") lit(src[k + 1]!); k += 2; continue; }
        if (d === "$") { k = dollar(k, true); continue; }
        if (d === "`") { k = backtick(k); continue; }
        lit(d);
        k++;
      }
      if (k >= n) { opaque.push("unterminated quote"); break; }
      i = k + 1;
      continue;
    }
    if (c === "$") { i = dollar(i, false); continue; }
    if (c === "`") { i = backtick(i); continue; }
    // Process substitution <( ) >( ) and zsh =( ): a word of its own.
    if ((c === "<" || c === ">") && src[i + 1] === "(" || (c === "=" && !cur && src[i + 1] === "(")) {
      const e = matchClose(src, i + 1, "(", ")");
      if (e < 0) { opaque.push("unterminated process substitution"); break; }
      const w = word();
      w.procs.push({ dir: c, text: src.slice(i + 2, e - 1) });
      w.w.dynamic = true;
      i = e;
      continue;
    }
    const curT = peek();
    const op = !(c === "(" && curT && curT.last === "=") ? OPS.find((o) => src.startsWith(o, i)) : undefined;
    if (op) {
      // zsh glob qualifiers and array assignments: `*(e:…:)`, `a=(x y)` — an unquoted "(" glued to a word.
      if (op === "(" && curT) {
        if (curT.w.glob || /[*?\]]/.test(curT.last)) opaque.push("zsh glob qualifier");
        flush();
      }
      // An fd number glued to a redirect: 2> 2>&1 1>&2.
      let fd: number | null = null;
      if (/^[<>]|^&>/.test(op) && curT && !curT.w.quoted && !curT.w.dynamic && /[0-9]/.test(curT.last) && /^[0-9]+$/.test(curT.w.text)) { fd = Number(curT.w.text); cur = null; }
      flush();
      const tok: OpTok = { t: "op", v: op, fd };
      toks.push(tok);
      if (op === "<<" || op === "<<-") expectDelim = { tok, strip: op === "<<-" };
      i += op.length;
      continue;
    }
    if (c === "{" && !cur && /[\s]/.test(src[i + 1] ?? " ")) { toks.push({ t: "op", v: "{" }); i++; continue; }
    if (c === "}" && !cur && /[\s;&|)]/.test(src[i + 1] ?? " ")) { toks.push({ t: "op", v: "}" }); i++; continue; }
    if (c === "{") {
      // Bug 433: each `{` scans ahead for its close, so `{{{{…` (or `{` then a long body with no close) is quadratic. The
      // scans share one budget, linear in the text; past it a `{` is a brace word we couldn't check (glob, and opaque).
      const e = braceBudget > 0 ? matchClose(src, i, "{", "}", braceBudget) : -2;
      braceBudget = e === -2 ? 0 : braceBudget - (e > 0 ? e - i : n - i);
      if (e === -2) { word().w.glob = true; if (!opaque.includes(BRACE_BUDGET)) opaque.push(BRACE_BUDGET); }
      const body = e > 0 ? src.slice(i + 1, e - 1) : "";
      if (e > 0 && (body.includes(",") || body.includes(".."))) { append(src.slice(i, e)).w.glob = true; i = e; continue; }
    }
    if (c === "*" || c === "?" || c === "[") word().w.glob = true;
    lit(c);
    i++;
  }
  flush();
  if (pending.length) for (const p of pending) p.tok.heredoc = "";
  return toks;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Lexical path join + normalize (never above /). */
export function shJoin(p: string, cwd: string): string {
  const abs = p.startsWith("/") ? p : `${cwd.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** Resolves a word to an absolute path, or null when unknown (dynamic, ~user, relative with an unknown cwd). */
export function shPath(w: ShWord, cwd: string | null, home: string): string | null {
  if (w.dynamic) return null;
  let t = w.text;
  if (!w.headQuoted) {
    if (t === "~" || t.startsWith("~/")) t = home + t.slice(1);
    else if (t.startsWith("~")) return null;
  }
  if (!t.startsWith("/")) { if (!cwd) return null; }
  return shJoin(t, cwd ?? "/");
}

interface Peeled { argv: ShWord[]; wrappers: string[]; assigns: string[]; argsUnknown: boolean; inner: { argv: ShWord[]; origin: ShOrigin }[]; opaque: string[] }

const VALUE_FLAGS: Record<string, { value: Set<string>; bool?: RegExp }> = {
  nice: { value: new Set(["-n", "--adjustment"]) },
  timeout: { value: new Set(["-s", "--signal", "-k", "--kill-after"]) },
  gtimeout: { value: new Set(["-s", "--signal", "-k", "--kill-after"]) },
  caffeinate: { value: new Set(["-t", "-w"]) },
  stdbuf: { value: new Set(["-i", "-o", "-e"]) },
  watch: { value: new Set(["-n", "--interval", "-d"]) },
  ionice: { value: new Set(["-c", "-n", "-p"]) },
  exec: { value: new Set(["-a"]) },
  arch: { value: new Set(["-arch", "-d", "-e"]) },
  chrt: { value: new Set(["-p"]) },
  taskpolicy: { value: new Set(["-c", "-d", "-g", "-p"]) },
};
const PLAIN_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "noglob", "nocorrect", "-", "time", "caffeinate", "nice", "timeout", "gtimeout", "stdbuf", "watch", "unbuffer", "chronic", "ionice", "arch", "chrt", "taskpolicy", "then", "do", "else"]);
const SUDO_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R"]);
const XARGS_VALUE = new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-E", "-d", "-a"]);

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

function wordsFromString(s: string): ShWord[] {
  return s.split(/\s+/).filter(Boolean).map((t) => ({ text: t, dynamic: false, glob: /[*?[]/.test(t), quoted: false, headQuoted: false, literal: t, procSubst: null }));
}

function peel(argv0: ShWord[]): Peeled {
  let argv = argv0;
  const wrappers: string[] = [];
  const assigns: string[] = [];
  const inner: Peeled["inner"] = [];
  const opaque: string[] = [];
  let argsUnknown = false;
  for (let guard = 0; guard < 20 && argv.length; guard++) {
    const w0 = argv[0]!;
    if (w0.dynamic || w0.glob) return { argv, wrappers, assigns, argsUnknown, inner, opaque };
    let name = base(w0.text);
    if (!w0.quoted && name.startsWith("=") && name.length > 1) name = name.slice(1);
    if (name === "env") {
      wrappers.push(name);
      let k = 1;
      while (k < argv.length) {
        const t = argv[k]!.text;
        if (t === "--") { k++; break; }
        if (/^-[i0v]+$/.test(t) || t === "-" || t === "--ignore-environment") { k++; continue; }
        if (t === "-u" || t === "-P" || t === "-C" || t === "--unset" || t === "--chdir") { k += 2; continue; }
        if (/^-[uPC]./.test(t) || /^--(unset|chdir)=/.test(t)) { k++; continue; }
        if (t === "-S" || t === "--split-string" || /^-S./.test(t) || t.startsWith("--split-string=")) {
          const v = t === "-S" || t === "--split-string" ? argv[k + 1]?.text ?? "" : t.startsWith("-S") ? t.slice(2) : t.slice(t.indexOf("=") + 1);
          if (argv[k + (t === "-S" || t === "--split-string" ? 1 : 0)]?.dynamic) opaque.push("env -S with a computed string");
          argv = [...wordsFromString(v), ...argv.slice(k + (t === "-S" || t === "--split-string" ? 2 : 1))];
          k = 0;
          continue;
        }
        if (ASSIGN.test(t)) { assigns.push(t); k++; continue; }
        break;
      }
      argv = argv.slice(k);
      continue;
    }
    if (name === "command" && argv[1] && /^-[vV]/.test(argv[1].text)) return { argv, wrappers, assigns, argsUnknown, inner, opaque };
    if (name === "sudo" || name === "doas" || name === "sudoedit" || name === "run0" || name === "pkexec") {
      // The privileged program is also a command in its own right: both are evaluated.
      let k = 1;
      while (k < argv.length) {
        const t = argv[k]!.text;
        if (t === "--") { k++; break; }
        if (SUDO_VALUE.has(t)) { k += 2; continue; }
        if (t.startsWith("-")) { k++; continue; }
        if (ASSIGN.test(t)) { k++; continue; }
        break;
      }
      if (k < argv.length) inner.push({ argv: argv.slice(k), origin: "sudo" });
      return { argv, wrappers, assigns, argsUnknown, inner, opaque };
    }
    if (name === "xargs") {
      wrappers.push(name);
      argsUnknown = true;
      let k = 1;
      // Bug 431: the replace string (-I R, -J R, -i[R], --replace[=R]): a program word holding it is computed from input.
      let repl: string | null = null;
      while (k < argv.length) {
        const t = argv[k]!.text;
        if (t === "--") { k++; break; }
        if (t === "-I" || t === "-J") repl = argv[k + 1]?.text ?? null;
        else if (/^-[IJ]./.test(t)) repl = t.slice(2);
        else if (/^-i/.test(t)) repl = t.slice(2) || "{}";
        else if (/^--replace(=|$)/.test(t)) repl = t.slice(10) || "{}";
        if (XARGS_VALUE.has(t)) { k += 2; continue; }
        if (/^-[IJLnPsEda]./.test(t) || /^--\w/.test(t) || /^-[0oprtx]+$/.test(t) || /^-i/.test(t)) { k++; continue; }
        break;
      }
      argv = argv.slice(k);
      if (!argv.length) argv = wordsFromString("echo");
      else if (repl && argv[0]!.text.includes(repl)) argv = [{ ...argv[0]!, dynamic: true }, ...argv.slice(1)];
      continue;
    }
    if (PLAIN_WRAPPERS.has(name)) {
      wrappers.push(name);
      const spec = VALUE_FLAGS[name];
      let k = 1;
      while (k < argv.length) {
        const t = argv[k]!.text;
        if (t === "--") { k++; break; }
        if (spec?.value.has(t)) { k += 2; continue; }
        if (/^-[0-9]+$/.test(t) && name === "nice") { k++; continue; }
        if (t.startsWith("-") && t.length > 1) { k++; continue; }
        break;
      }
      // timeout DURATION cmd
      if ((name === "timeout" || name === "gtimeout") && k < argv.length && /^[0-9.]+[smhd]?$/.test(argv[k]!.text)) k++;
      argv = argv.slice(k);
      continue;
    }
    break;
  }
  return { argv, wrappers, assigns, argsUnknown, inner, opaque };
}

/** Parses shell text into the commands it can run. Never throws. */
export function parseShell(text: string, ctx: ShContext, depth = 0, origin: ShOrigin = "top"): ShParse {
  const out: ShParse = { cmds: [], opaque: [], compound: false, hasPipe: false, hasRedirect: false, hasSubstitution: false, background: false };
  if (depth > MAX_DEPTH) { out.opaque.push("nested too deeply"); return out; }
  if (/[\x00]/.test(text)) out.opaque.push("NUL byte");
  // zsh-only constructs that run code: glob qualifiers (e:…) (+func), ${(…)…} parameter flags.
  if (/\([^()\n]*\be:|\(\+\w/.test(text)) out.opaque.push("zsh glob qualifier");
  const vars = { ...(ctx.vars ?? {}), HOME: ctx.home, ...(ctx.cwd ? { PWD: ctx.cwd } : {}) };
  const toks = lex(text, out.opaque, vars);
  let cwd = ctx.cwd;
  const cwdStack: (string | null)[] = [];
  let pipeline = 0;
  let stage = 0;
  let nextStdin: ShCmd["stdin"] = null;
  let words: Tok[] = [];
  let redirects: (ShRedirect & { procText?: string })[] = [];
  let skipping = false;
  let segments = 0;

  const sub = (s: string, o: ShOrigin, c: string | null) => {
    const p = parseShell(s, { ...ctx, cwd: c }, depth + 1, o);
    out.opaque.push(...p.opaque);
    out.hasSubstitution = true;
    const start = out.cmds.length;
    out.cmds.push(...p.cmds);
    return start;
  };

  const endCommand = () => {
    const ws = words;
    const rs = redirects;
    words = [];
    redirects = [];
    const wasSkipping = skipping;
    skipping = false;
    if (!ws.length && !rs.length) return;
    segments++;
    // Substitutions in any word run first, in the same cwd.
    for (const t of ws) for (const s of t.subs) sub(s, "subst", cwd);
    for (const t of ws) for (const p of t.procs) {
      const g = out.cmds.length;
      sub(p.text, "procsubst", cwd);
      for (let k = g; k < out.cmds.length; k++) out.cmds[k]!.group = g;
      t.w.procSubst = g;
    }
    for (const r of rs) if (r.procText !== undefined) { const g = out.cmds.length; sub(r.procText, "procsubst", cwd); for (let k = g; k < out.cmds.length; k++) out.cmds[k]!.group = g; }
    if (wasSkipping) return;
    let argv = ws.map((t) => t.w);
    // Reserved words at the start (if/then/do/! …) aren't programs.
    while (argv.length && !argv[0]!.quoted && RESERVED.has(argv[0]!.text)) argv = argv.slice(1);
    const assigns: string[] = [];
    while (argv.length && !argv[0]!.dynamic && ASSIGN.test(argv[0]!.text) && !argv[0]!.literal.startsWith("\"")) { assigns.push(argv[0]!.text); argv = argv.slice(1); }
    const pe = peel(argv);
    out.opaque.push(...pe.opaque);
    const stdinR = rs.find((r) => r.fd === null || r.fd === 0 ? /^<(<<|<-|<)?$/.test(r.op) || r.op === "<>" : false);
    const stdin: ShCmd["stdin"] = stdinR ? (stdinR.heredoc !== null ? (stdinR.op === "<<<" ? "herestring" : "heredoc") : stdinR.procText !== undefined ? "procsubst" : "file") : nextStdin;
    const make = (av: ShWord[], o: ShOrigin, extraWrappers: string[] = []): ShCmd => {
      const w0 = av[0];
      let program = "";
      if (w0) {
        if (w0.dynamic) out.opaque.push("the program name is computed at run time");
        else if (w0.glob) out.opaque.push("the program name is a glob");
        program = base(w0.text);
        if (!w0.quoted && program.startsWith("=") && program.length > 1) program = program.slice(1);
      }
      return {
        argv: av, program, assigns: [...assigns, ...pe.assigns], redirects: rs.map(({ procText: _p, ...r }) => r), wrappers: [...pe.wrappers, ...extraWrappers], cwd, stdin,
        programFromInput: false, argsUnknown: pe.argsUnknown, pipeline, stage, depth, origin: o, inlineCode: [], group: null,
      };
    };
    const main = make(pe.argv, depth === 0 ? "top" : origin);
    const all = [main, ...pe.inner.map((x) => { const q = peel(x.argv); out.opaque.push(...q.opaque); return { ...make(q.argv, x.origin, q.wrappers), argsUnknown: q.argsUnknown }; })];
    for (const c of all) {
      out.cmds.push(c);
      interpret(c);
    }
    // cd tracking (after the command is recorded; applies to what follows).
    if (main.program === "cd" || main.program === "pushd") {
      const args = main.argv.slice(1).filter((w) => !(w.text.startsWith("-") && w.text.length > 1 && !w.dynamic));
      if (!args.length) cwd = main.program === "cd" ? ctx.home : cwd;
      else if (args.length === 1 && !args[0]!.glob) cwd = shPath(args[0]!, cwd, ctx.home);
      else cwd = null;
    }
  };

  /** Interpreter handling: sh -c bodies, eval, heredoc scripts, find -exec, inline code. */
  const interpret = (c: ShCmd) => {
    const p = c.program;
    const args = c.argv.slice(1);
    if (SHELLS.has(p)) {
      let script: ShWord | null = null;
      let cString: ShWord | null = null;
      let fromStdin = false;
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        if (args[k]!.dynamic && k === 0 && !cString) { script = args[k]!; break; }
        if (t === "--") { script = args[k + 1] ?? null; break; }
        if (/^[-+]o$/.test(t)) { k++; continue; }
        if (/^-[A-Za-z]+$/.test(t) && !args[k]!.quoted) {
          if (t.includes("c")) { cString = args[k + 1] ?? null; break; }
          if (t.includes("s")) fromStdin = true;
          continue;
        }
        if (/^--/.test(t) || /^\+[A-Za-z]+$/.test(t)) continue;
        script = args[k]!;
        break;
      }
      if (cString) {
        if (cString.dynamic) out.opaque.push(`${p} -c runs a computed string`);
        else sub(cString.text, "c-string", c.cwd);
        return;
      }
      if (!script || fromStdin || script.text === "-" || script.text === "/dev/stdin" || script.procSubst !== null) {
        c.programFromInput = true;
        const hd = c.redirects.find((r) => r.heredoc !== null);
        if (hd && c.stdin === "heredoc") { c.programFromInput = false; sub(hd.heredoc!, "heredoc", c.cwd); }
        else if (hd && c.stdin === "herestring") { c.programFromInput = false; if (hd.target?.dynamic) out.opaque.push("a shell runs a computed here-string"); else sub(hd.target?.text ?? "", "heredoc", c.cwd); }
      }
      return;
    }
    if (p === "eval") {
      if (args.some((w) => w.dynamic)) out.opaque.push("eval of a computed string");
      else sub(args.map((w) => w.text).join(" "), "eval", c.cwd);
      return;
    }
    if (p === "source" || p === ".") {
      if (!args[0] || args[0].procSubst !== null || args[0].text === "/dev/stdin" || args[0].text === "-") c.programFromInput = true;
      return;
    }
    if (p === "su") {
      const k = args.findIndex((w) => w.text === "-c" || w.text === "--command");
      if (k >= 0 && args[k + 1]) { if (args[k + 1]!.dynamic) out.opaque.push("su -c runs a computed string"); else sub(args[k + 1]!.text, "su", c.cwd); }
      return;
    }
    if (p === "find" || p === "gfind") {
      for (let k = 0; k < args.length; k++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(args[k]!.text)) continue;
        const end = args.findIndex((w, j) => j > k && (w.text === ";" || w.text === "+"));
        const body = args.slice(k + 1, end < 0 ? undefined : end);
        if (body.length) {
          const pe = peel(body);
          const w0 = pe.argv[0];
          out.cmds.push({ ...c, argv: pe.argv, program: w0 ? base(w0.text) : "", wrappers: pe.wrappers, argsUnknown: true, origin: "exec", redirects: [], inlineCode: [], programFromInput: false });
          interpret(out.cmds[out.cmds.length - 1]!);
        }
        if (end < 0) break;
        k = end;
      }
      return;
    }
    const langFlags = INTERPRETERS[p] ?? INTERPRETERS[p.replace(/[0-9.]+$/, "")];
    if (langFlags) {
      let hasProgram = false;
      let fromInput = false;
      for (let k = 0; k < args.length; k++) {
        const w = args[k]!;
        const t = w.text;
        if (langFlags.includes(t)) { if (args[k + 1]) c.inlineCode.push(args[k + 1]!.dynamic ? args[k + 1]!.literal : args[k + 1]!.text); hasProgram = true; k++; continue; }
        if (p.startsWith("python") && (t === "-m" || /^-m./.test(t))) { hasProgram = true; break; }
        if (t === "-" || t === "/dev/stdin" || w.procSubst !== null) { fromInput = true; break; }
        if (p === "awk" && (t === "-F" || t === "-v")) { k++; continue; }
        if (t.startsWith("-")) continue;
        if (p === "awk") c.inlineCode.push(w.dynamic ? w.literal : t);
        hasProgram = true;
        break;
      }
      if (!hasProgram && !fromInput) fromInput = c.stdin !== null;
      c.programFromInput = fromInput && p !== "awk";
    }
  };

  let k = 0;
  while (k < toks.length) {
    const t = toks[k]!;
    if (t.t === "word") {
      if (!words.length && !redirects.length && !t.w.quoted && SKIP_SEGMENT.has(t.w.text)) skipping = true;
      words.push(t);
      k++;
      continue;
    }
    const v = t.v;
    if (/^[<>]|^&>/.test(v) && v !== "<(" ) {
      out.hasRedirect = true;
      const fd = t.fd ?? null;
      const next = toks[k + 1];
      if (v === "<<" || v === "<<-") {
        redirects.push({ op: v, fd, target: next?.t === "word" ? next.w : null, heredoc: t.heredoc ?? "" });
        k += next?.t === "word" ? 2 : 1;
        continue;
      }
      if (next?.t === "word") {
        if (next.subs.length) for (const s of next.subs) sub(s, "subst", cwd);
        const procText = next.procs[0]?.text;
        redirects.push({ op: v, fd, target: next.w, heredoc: v === "<<<" ? next.w.text : null, ...(procText !== undefined ? { procText } : {}) });
        k += 2;
      } else { out.opaque.push("a redirect with no target"); k++; }
      continue;
    }
    // Control operators.
    if (v === "|" || v === "|&") { endCommand(); out.hasPipe = true; stage++; nextStdin = "pipe"; k++; continue; }
    endCommand();
    nextStdin = null;
    if (v === "(") { cwdStack.push(cwd); k++; continue; }
    if (v === ")") { if (cwdStack.length) cwd = cwdStack.pop()!; k++; continue; }
    if (v === "{" || v === "}") { k++; continue; }
    if (v === "&") out.background = true;
    pipeline++;
    stage = 0;
    k++;
  }
  endCommand();
  out.compound = segments > 1 || out.hasPipe;
  return out;
}
