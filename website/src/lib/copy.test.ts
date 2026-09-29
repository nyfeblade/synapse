import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("site copy stays with the repository", () => {
  it("keeps the install facts from the README", () => {
    const copy = read("src/components/product-copy.tsx");
    for (const phrase of [
      "Apple silicon",
      "macOS 14",
      "OrbStack",
      "Anthropic API key",
      "self-signed",
      "Open Anyway",
      "Settings → Updates",
      "127.0.0.1",
    ]) {
      expect(copy, phrase).toContain(phrase);
    }
    expect(read("src/lib/site.ts")).toContain('updateSource: "nyfeblade/synapse"');
  });

  it("points the fallback disk image at the v0.1.0 release", () => {
    const config = read("release.config.ts");
    expect(config).toContain("Synapse-0.1.0-arm64.dmg");
    expect(config).toContain("v0.1.0");
  });
});
