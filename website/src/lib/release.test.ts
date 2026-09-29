import { describe, expect, it } from "vitest";
import { FALLBACK_RELEASE } from "../../release.config";
import { compareSemver, dmgUrl, fallbackDmg, formatBytes, pickDmg } from "./release";

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    name: `Synapse ${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-09-29T00:32:27Z",
    assets: [
      {
        name: `Synapse-${version}-arm64.dmg`,
        state: "uploaded",
        size: 1000,
        browser_download_url: "https://example.invalid/ignore-me",
      },
    ],
    ...extra,
  };
}

describe("pickDmg", () => {
  it("picks the highest plain version and builds the GitHub download URL", () => {
    const picked = pickDmg([release("0.1.0"), release("0.2.0", { prerelease: true }), release("0.1.9")]);
    expect(picked?.version).toBe("0.2.0");
    expect(picked?.prerelease).toBe(true);
    expect(picked?.url).toBe("https://github.com/nyfeblade/synapse/releases/download/v0.2.0/Synapse-0.2.0-arm64.dmg");
    expect(picked?.source).toBe("github");
  });

  it("keeps a prerelease when it is the only release", () => {
    const picked = pickDmg([release("0.1.0", { prerelease: true, name: "Synapse 0.1.0 (beta)" })]);
    expect(picked?.tag).toBe("v0.1.0");
    expect(picked?.releaseName).toBe("Synapse 0.1.0 (beta)");
    expect(picked?.url).toBe(dmgUrl("v0.1.0", "Synapse-0.1.0-arm64.dmg"));
  });

  it("skips drafts, non-semver tags, and look-alike files", () => {
    const picked = pickDmg([
      release("1.0.0", { draft: true }),
      { ...release("2.0.0"), tag_name: "v2.0.0-rc.1" },
      release("0.3.0", {
        assets: [
          { name: "Synapse-0.3.0-arm64.zip", state: "uploaded", size: 10 },
          { name: "Bots-0.3.0-arm64.dmg", state: "uploaded", size: 10 },
          { name: "Synapse-0.3.0-amd64.dmg", state: "uploaded", size: 10 },
        ],
      }),
      release("0.1.0"),
    ]);
    expect(picked?.version).toBe("0.1.0");
  });

  it("returns null for an empty or malformed payload", () => {
    expect(pickDmg([])).toBeNull();
    expect(pickDmg({ tag_name: "v0.1.0" })).toBeNull();
    expect(pickDmg([null, "v0.1.0", { draft: false }])).toBeNull();
  });
});

describe("fallback and semver", () => {
  it("orders numeric versions", () => {
    expect(compareSemver("0.1.10", "0.1.9")).toBe(1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  it("points the fallback at the configured v0.1.0 disk image", () => {
    const dmg = fallbackDmg("offline");
    expect(dmg.source).toBe("fallback");
    expect(dmg.notice).toBe("offline");
    expect(dmg.url).toBe(
      "https://github.com/nyfeblade/synapse/releases/download/v0.1.0/Synapse-0.1.0-arm64.dmg",
    );
    expect(dmg.assetName).toBe(FALLBACK_RELEASE.assetName);
    expect(formatBytes(511513595)).toBe("512 MB");
  });
});
