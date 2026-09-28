import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("files.css ownership (Task 30 fix round 1, finding 1)", () => {
  it("main.tsx (Track P's file, per the plan's Parallel tracks table) does not import files.css", () => {
    expect(read("../../src/renderer/main.tsx")).not.toMatch(/styles\/files\.css/);
  });

  it("FileCard.tsx (a Track F component) imports files.css itself, per Design Decision #8", () => {
    expect(read("../../src/renderer/components/FileCard.tsx")).toMatch(/^import "..\/styles\/files\.css";$/m);
  });
});
