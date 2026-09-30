import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Bug 435: every `orb` the app runs goes through app/src/main/orb-exec.ts (orbCall / orb / orbBytes), which bounds
// it, kills its process group on timeout and retries only what is safe to repeat. Nothing else may spawn orb.
const src = path.resolve(__dirname, "../../src");
const HELPER = path.join("main", "orb-exec.ts");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(ts|tsx|mjs|js)$/.test(d.name) ? [p] : [];
  });
}

/** Every process-running call whose command (first argument) looks like the orb CLI. */
function orbSpawns(text: string): string[] {
  const out: string[] = [];
  const call = /\b(execFile|execFileSync|spawn|spawnSync|execSync|exec|execCommand|execBounded|runBounded|runBytes|runStreamed|run)\s*\(\s*([^,)]*)/g;
  for (const m of text.matchAll(call)) {
    const cmd = m[2]!;
    if (/\borb\b|\borb\(\)|resolveOrb|cliPath|ORB_CANDIDATES|orbCandidates|\/bin\/orb|\borbctl\b/.test(cmd)) out.push(`${m[1]}(${cmd.trim()}`);
  }
  // A shell command line that starts orb itself.
  for (const m of text.matchAll(/(?:execSync|spawnSync|spawn|exec)\s*\(\s*["'`](?:[^"'`]*\/)?orb(?:ctl)?\s/g)) out.push(m[0]);
  return out;
}

describe("orb is only ever run through orb-exec.ts (bug 435)", () => {
  it("the guard spots the ways orb used to be run", () => {
    const caught = (code: string) => orbSpawns(code).length > 0;
    expect(caught(`execCommand(resolveOrb(), ["list"], { timeoutMs: 1 })`)).toBe(true);
    expect(caught(`await this.o.exec(this.orb(), ["-m", m], {})`)).toBe(true);
    expect(caught(`const r = await d.exec(d.orb(), args, { timeoutMs })`)).toBe(true);
    expect(caught(`o.exec(cliPath, ["status"])`)).toBe(true);
    expect(caught(`spawn("/usr/local/bin/orb", ["list"])`)).toBe(true);
    expect(caught(`runBytes(resolveOrb(), ["-m", "box"])`)).toBe(true);
    expect(caught(`execSync("orb list")`)).toBe(true);
    expect(caught(`exec(orb, args, {})`)).toBe(true);
    // Not orb: other commands, a regex's exec, a helper call.
    expect(orbSpawns(`execCommand("bash", [script]); /x/.exec(v.stdout); orbCall(exec, orb, ["list"], o)`)).toEqual([]);
  });

  it("no file in app/src spawns orb except the helper", () => {
    const bad: string[] = [];
    for (const f of files(src)) {
      if (path.relative(src, f) === HELPER) continue;
      for (const hit of orbSpawns(fs.readFileSync(f, "utf8"))) bad.push(`${path.relative(src, f)}: ${hit}`);
    }
    expect(bad).toEqual([]);
  });

  it("the helper itself is the one place orb is spawned", () => {
    expect(orbSpawns(fs.readFileSync(path.join(src, HELPER), "utf8")).length).toBeGreaterThan(0);
  });
});
