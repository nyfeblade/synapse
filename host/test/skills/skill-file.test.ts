import { describe, expect, it } from "vitest";
import { parseSkill, serializeSkill, slugify, validateSkill } from "../../skills/skill-file";

describe("SKILL.md (SKL-01)", () => {
  it("slugs names with NFKD, lowercase and a 64-char cap", () => {
    expect(slugify("Weekly Report — Café Edition!")).toBe("weekly-report-cafe-edition");
    expect(slugify("x".repeat(80))).toHaveLength(64);
    expect(slugify("¿¿")).toBe("skill");
  });
  it("round-trips frontmatter, including folded descriptions and metadata", () => {
    const md = "---\nname: Weekly report\ndescription: >\n  Use this when the user asks for the weekly report.\nmetadata:\n  source: https://example.com/weekly.md\n  managed: false\ndisable-model-invocation: true\n---\n# Steps\n1. Pull numbers\n";
    const s = parseSkill(md);
    expect(s).toMatchObject({ name: "Weekly report", description: "Use this when the user asks for the weekly report.\n", metadata: { source: "https://example.com/weekly.md", managed: false }, disableModelInvocation: true });
    expect(s.body).toBe("# Steps\n1. Pull numbers\n");
    expect(parseSkill(serializeSkill(s))).toEqual(s);
  });
  it("validates the limits", () => {
    const ok = { name: "A", description: "Use this when…", metadata: {}, body: "x", disableModelInvocation: false };
    expect(validateSkill(ok)).toBeNull();
    expect(validateSkill({ ...ok, name: "n".repeat(81) })).toMatch(/80/);
    expect(validateSkill({ ...ok, description: "" })).toMatch(/description/);
    expect(validateSkill({ ...ok, body: "b".repeat(100_001) })).toMatch(/100,000/);
  });
});
