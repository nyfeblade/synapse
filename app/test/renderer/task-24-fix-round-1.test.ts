import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcPath = (p: string) => fileURLToPath(new URL(`../../src/renderer/${p}`, import.meta.url));
const read = (p: string) => readFileSync(srcPath(p), "utf8");

describe("Fix round 1, Task 24 finding 1 — skills.css is imported by its component, not main.tsx (Decision 8)", () => {
  it("main.tsx does not import styles/skills.css (that file belongs to Track P, not Track S)", () => {
    expect(read("main.tsx")).not.toMatch(/styles\/skills\.css/);
  });

  it("PrivateSkills.tsx imports ../styles/skills.css itself", () => {
    expect(read("components/PrivateSkills.tsx")).toMatch(/import\s+["']\.\.\/styles\/skills\.css["'];?/);
  });
});

describe("Fix round 1, Task 24 finding 2 — .plain-list is defined in skills.css", () => {
  it("skills.css defines .plain-list with list-style:none, margin:0 and padding:0", () => {
    const css = read("styles/skills.css");
    const m = css.match(/\.plain-list\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/list-style:\s*none/);
    expect(body).toMatch(/margin:\s*0/);
    expect(body).toMatch(/padding:\s*0/);
  });
});
