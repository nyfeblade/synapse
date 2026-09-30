import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvalTemp } from "../../evals/eval-temp";

describe("eval temp dirs are removed (the approval eval used to leave one eval-* dir per case)", () => {
  it("removes a case's dir after the case, and everything left at the end", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "evaltemp-test-"));
    try {
      const t = new EvalTemp(base);
      const a = t.dir("eval-");
      const b = t.dir("eval-cli-");
      fs.writeFileSync(path.join(a, "log.jsonl"), "{}");
      expect(fs.readdirSync(base)).toHaveLength(2);
      t.done(a);
      expect(fs.existsSync(a)).toBe(false);
      expect(t.live).toBe(1);
      t.cleanup();
      t.cleanup();
      expect(fs.existsSync(b)).toBe(false);
      expect(fs.readdirSync(base)).toHaveLength(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("guard: the approval eval makes its temp dirs only through EvalTemp, and removes each case's", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../evals/reviewer/run.ts"), "utf8");
    expect(src).not.toMatch(/mkdtemp/);
    expect(src).toMatch(/temp\.done\(dir\)/);
    expect(src).toMatch(/temp\.cleanup\(\)/);
  });
});
