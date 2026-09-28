import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainPath = fileURLToPath(new URL("../../src/renderer/main.tsx", import.meta.url));
const dialogPath = fileURLToPath(new URL("../../src/renderer/components/HiddenBotsDialog.tsx", import.meta.url));

// Fix round 1, finding 1: main.tsx is Track P/Task 33's file (plan.md:9916), not Task 7's
// (task-7-brief.md:5-10 / plan.md:9911). plan.md:66's CSS-wiring rule puts a feature's
// stylesheet import in a component that feature's task owns, so parallel tracks never
// conflict on main.tsx.
describe("bot-admin.css ownership (fix round 1, finding 1)", () => {
  it("is not imported from main.tsx", () => {
    expect(readFileSync(mainPath, "utf8")).not.toMatch(/bot-admin\.css/);
  });

  it("is imported from HiddenBotsDialog.tsx instead (a Task 7-owned component)", () => {
    expect(readFileSync(dialogPath, "utf8")).toMatch(/import\s+"\.\.\/styles\/bot-admin\.css";/);
  });
});
