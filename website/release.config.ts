/**
 * Download target when the GitHub releases API cannot be read.
 * The site otherwise picks the highest non-draft vX.Y.Z release that
 * includes Synapse-<version>-arm64.dmg, prereleases included.
 * Replace these fields to pin a different known-good disk image.
 */
export const GITHUB_REPOSITORY = "nyfeblade/synapse";

export const RELEASE_REVALIDATE_SECONDS = 3600;

export const FALLBACK_RELEASE = {
  tag: "v0.1.0",
  version: "0.1.0",
  assetName: "Synapse-0.1.0-arm64.dmg",
  releaseName: "Synapse 0.1.0 (beta)",
  prerelease: true,
  publishedAt: "2026-09-29T00:32:27Z",
  size: 511513595,
} as const;
