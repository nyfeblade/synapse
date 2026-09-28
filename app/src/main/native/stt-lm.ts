import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Bug 162: the compiled custom language model of the user's own vocabulary.
//
// Contextual strings bias one recognition; the language model teaches the recognizer the names and
// the shapes they are said in. Measured on 36 spoken samples, on top of contextual strings: word
// error rate 6.9% to 5.2%, name accuracy 48/54 to 51/54. Compiling costs about a second and a few
// megabytes, so it is built once per vocabulary and cached — never on the path to the microphone.

/** The cache key for a name list: the same names in any order give the same model. */
export function lmKey(strings: string[], locale: string): string {
  const norm = [...strings].map((s) => s.trim().toLowerCase()).sort().join("\n");
  return createHash("sha256").update(`${locale}\n${norm}`).digest("hex").slice(0, 16);
}

/** A compiled model is usable only when both halves are on disk. */
export function lmReady(dir: string): boolean {
  return ["model.lm", "model.vocab"].every((f) => {
    try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; }
  });
}

export interface LmCache {
  /** The compiled model for these names, or null while it is still being built (or if it failed). */
  dirFor(strings: string[], locale: string): string | null;
}

/**
 * Builds models in the background and hands back the one that is ready. A session never waits: the
 * first dictation after the Bot list changes runs on contextual strings alone and the next one gets
 * the model. Only one build runs at a time, and only the newest requested vocabulary is built.
 */
export function makeLmCache(o: {
  binary: string;
  root: string;
  execFileFn?: typeof execFile;
  writeContext: (strings: string[], dir: string, id: string) => string | null;
  log?: (line: string) => void;
  /** How many compiled models to keep before the oldest is dropped. */
  keep?: number;
}): LmCache {
  const keep = o.keep ?? 3;
  let building: string | null = null;
  const failed = new Set<string>();

  function prune(): void {
    let dirs: string[];
    try { dirs = fs.readdirSync(o.root); } catch { return; }
    const withTime = dirs
      .map((d) => ({ d, t: (() => { try { return fs.statSync(path.join(o.root, d)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.t - a.t);
    for (const { d } of withTime.slice(keep)) {
      try { fs.rmSync(path.join(o.root, d), { recursive: true, force: true }); } catch { /* it can wait */ }
    }
  }

  function build(key: string, dir: string, strings: string[], locale: string): void {
    if (building || failed.has(key)) return;
    building = key;
    let contextFile: string | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      contextFile = o.writeContext(strings, dir, "lm");
    } catch { /* handled below */ }
    if (!contextFile) { building = null; failed.add(key); return; }
    const done = (err: unknown): void => {
      building = null;
      if (contextFile) { try { fs.unlinkSync(contextFile); } catch { /* already gone */ } }
      if (err || !lmReady(dir)) {
        // Not a user-visible failure: dictation works without it, just less accurately on names.
        failed.add(key);
        o.log?.(`custom language model build failed for ${strings.length} names: ${String(err ?? "incomplete")}`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* it can wait */ }
        return;
      }
      o.log?.(`custom language model ready for ${strings.length} names`);
      prune();
    };
    (o.execFileFn ?? execFile)(
      o.binary,
      ["--build-lm", "--lm-dir", dir, "--context-file", contextFile, "--locale", locale],
      { timeout: 120_000 },
      (err) => done(err),
    );
  }

  return {
    dirFor(strings, locale) {
      if (strings.length === 0) return null;
      const key = lmKey(strings, locale);
      const dir = path.join(o.root, key);
      if (lmReady(dir)) {
        try { fs.utimesSync(dir, new Date(), new Date()); } catch { /* only affects pruning order */ }
        return dir;
      }
      build(key, dir, strings, locale);
      return null;
    },
  };
}
