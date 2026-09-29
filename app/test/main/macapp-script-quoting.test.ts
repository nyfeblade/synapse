import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScript } from "../../src/main/macapp/scripts";

/**
 * Finder tags and Shortcuts take Bot-supplied names, paths and text. None of it may reach a shell as code:
 * `$()`, backticks, quotes and newlines must arrive as plain characters.
 */
const HOSTILE = [
  "$(touch pwned-dollar)",
  "`touch pwned-tick`",
  "a\"; touch pwned-dq; echo \"",
  "a'; touch pwned-sq; echo '",
  "line1\ntouch pwned-nl",
  "--output-path=pwned-opt",
];

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-quote-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const pwned = () => fs.readdirSync(dir).filter((f) => f.startsWith("pwned"));

/** Run a JXA script body in Node against fakes (JXA is JavaScript; the helpers are plain functions). */
function runJxa(source: string, g: { Application: unknown; ObjC?: unknown; $?: unknown; Ref?: unknown }): unknown {
  const f = new Function("Application", "ObjC", "$", "Ref", "Path", "delay", "src", "return eval(src)");
  return f(g.Application, g.ObjC, g.$, g.Ref, (p: string) => p, () => undefined, source);
}

/** A fake Standard Additions app whose doShellScript really runs the command through /bin/sh, in `dir`. */
function shellApp(rewrite: (cmd: string) => string, seen: string[]) {
  const app = {
    set includeStandardAdditions(_v: boolean) { /* fake */ },
    doShellScript(cmd: string) {
      seen.push(cmd);
      return execSync(rewrite(cmd), { cwd: dir, shell: "/bin/sh", encoding: "utf8" }).replace(/\n$/, "");
    },
  };
  return Object.assign(() => app, { currentApplication: () => app });
}

describe("Shortcuts: the name and the input reach the shortcuts tool as plain arguments", () => {
  for (const bad of HOSTILE) {
    it(`runs nothing from ${JSON.stringify(bad)}`, () => {
      const stub = path.join(dir, "stub.sh");
      fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\nprintf '|'\ncat\n`, { mode: 0o755 });
      const seen: string[] = [];
      const s = buildScript({ action: "shortcut", title: bad, text: bad } as never, { home: "/Users/alex" })!;
      const out = JSON.parse(String(runJxa(s.source, { Application: shellApp((c) => c.replace("/usr/bin/shortcuts", stub), seen) })));
      expect(pwned()).toEqual([]);
      expect(seen).toHaveLength(1);
      expect(out.output).toBe(`[run][--][${bad}]|${bad}`);
    });
  }

  it("with no input, sends none", () => {
    const stub = path.join(dir, "stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\n`, { mode: 0o755 });
    const s = buildScript({ action: "shortcut", title: "Morning" } as never, { home: "/Users/alex" })!;
    const out = JSON.parse(String(runJxa(s.source, { Application: shellApp((c) => c.replace("/usr/bin/shortcuts", stub), []) })));
    expect(out.output).toBe("[run][--][Morning]");
  });
});

/** A fake ObjC bridge holding one file's tags. */
function fakeObjC(existing: string[] | null) {
  const store = { tags: existing, writes: 0 };
  const wrap = (v: unknown) => ({ isNil: () => v == null, v });
  const $ = Object.assign((v: unknown) => wrap(v), {
    NSURLTagNamesKey: "NSURLTagNamesKey",
    NSURL: {
      fileURLWithPath: (p: string) => ({
        path: p,
        getResourceValueForKeyError(ref: unknown[], key: string) { expect(key).toBe("NSURLTagNamesKey"); ref[0] = wrap(store.tags); return true; },
        setResourceValueForKeyError(val: { v: string[] }, key: string) { expect(key).toBe("NSURLTagNamesKey"); store.tags = [...val.v]; store.writes++; return true; },
      }),
    },
  });
  const ObjC = { import: () => undefined, deepUnwrap: (w: { v: unknown }) => (Array.isArray(w.v) ? [...w.v] : w.v) };
  const Ref = () => [] as unknown[];
  const Application = () => ({
    set includeStandardAdditions(_v: boolean) { /* fake */ },
    doShellScript() { throw new Error("finder.tag must not use a shell"); },
  });
  return { store, g: { Application, ObjC, $, Ref } };
}

describe("Finder tags: no shell, and a new tag joins the file's existing tags", () => {
  for (const bad of HOSTILE) {
    it(`stores ${JSON.stringify(bad)} as a literal tag and keeps the others`, () => {
      const { store, g } = fakeObjC(["Red", "Work"]);
      const s = buildScript({ action: "finder.tag", target: `${dir}/${bad.replace(/\n/g, " ")}`, value: bad } as never, { home: "/Users/alex" })!;
      const out = JSON.parse(String(runJxa(s.source, g)));
      const expected = bad.replace(/\n/g, " ");
      expect(store.tags).toEqual(["Red", "Work", expected]);
      expect(out.tags).toEqual(["Red", "Work", expected]);
      expect(pwned()).toEqual([]);
    });
  }

  it("a file with no tags gets just the new one", () => {
    const { store, g } = fakeObjC(null);
    const s = buildScript({ action: "finder.tag", target: "~/a.txt", value: "Blue" } as never, { home: "/Users/alex" })!;
    runJxa(s.source, g);
    expect(store.tags).toEqual(["Blue"]);
  });

  it("a tag the file already has isn't added twice", () => {
    const { store, g } = fakeObjC(["Blue"]);
    const s = buildScript({ action: "finder.tag", target: "~/a.txt", value: "Blue" } as never, { home: "/Users/alex" })!;
    runJxa(s.source, g);
    expect(store.tags).toEqual(["Blue"]);
  });

  it.skipIf(process.platform !== "darwin")("on a real Mac: tags a temp file with hostile names and merges", () => {
    const file = path.join(dir, "f $(touch pwned-path) `x`.txt");
    fs.writeFileSync(file, "x");
    const run = (value: string) => {
      const s = buildScript({ action: "finder.tag", target: file, value } as never, { home: os.homedir() })!;
      return JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", s.source], { cwd: dir, encoding: "utf8" }));
    };
    run("$(touch pwned-a)");
    const out = run("`touch pwned-b` \"q\" 'z'");
    expect(out.tags).toEqual(["$(touch pwned-a)", "`touch pwned-b` \"q\" 'z'"]);
    expect(pwned()).toEqual([]);
  });
});
