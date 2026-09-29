import { FALLBACK_RELEASE, GITHUB_REPOSITORY, RELEASE_REVALIDATE_SECONDS } from "../../release.config";

export interface DmgRelease {
  tag: string;
  version: string;
  assetName: string;
  releaseName: string;
  url: string;
  releaseUrl: string;
  size: number | null;
  prerelease: boolean;
  publishedAt: string | null;
  source: "github" | "fallback";
  notice: string | null;
}

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function dmgUrl(tag: string, assetName: string): string {
  return `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${assetName}`;
}

export function releaseUrl(tag: string): string {
  return `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number(part));
  const pb = b.split(".").map((part) => Number(part));
  for (let i = 0; i < 3; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

export function formatBytes(size: number): string {
  const mb = size / 1_000_000;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatPublished(iso: string): string {
  return `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso))} UTC`;
}

export function sourceLabel(source: DmgRelease["source"]): string {
  switch (source) {
    case "github":
      return "Latest GitHub release";
    case "fallback":
      return "Configured fallback";
    default: {
      const neverSource: never = source;
      return neverSource;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assetNameFor(version: string): string {
  return `Synapse-${version}-arm64.dmg`;
}

function parseRelease(value: unknown): DmgRelease | null {
  if (!isRecord(value)) return null;
  if (value.draft !== false) return null;
  if (typeof value.tag_name !== "string") return null;
  const tag = TAG.exec(value.tag_name);
  if (!tag) return null;
  const version = `${tag[1]}.${tag[2]}.${tag[3]}`;
  const expectedName = assetNameFor(version);
  if (!Array.isArray(value.assets)) return null;
  const asset = value.assets.find((item) => {
    if (!isRecord(item) || item.name !== expectedName) return false;
    return item.state === undefined || item.state === "uploaded";
  });
  if (!asset || !isRecord(asset)) return null;
  const size = typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : null;
  const releaseName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : `Synapse ${version}`;
  const publishedAt = typeof value.published_at === "string" ? value.published_at : null;
  return {
    tag: value.tag_name,
    version,
    assetName: expectedName,
    releaseName,
    url: dmgUrl(value.tag_name, expectedName),
    releaseUrl: releaseUrl(value.tag_name),
    size,
    prerelease: value.prerelease === true,
    publishedAt,
    source: "github",
    notice: null,
  };
}

/** Highest plain vX.Y.Z release with an uploaded arm64 DMG. Drafts are skipped. Prereleases count. */
export function pickDmg(payload: unknown): DmgRelease | null {
  if (!Array.isArray(payload)) return null;
  let best: DmgRelease | null = null;
  for (const item of payload) {
    const parsed = parseRelease(item);
    if (!parsed) continue;
    if (!best || compareSemver(parsed.version, best.version) > 0) best = parsed;
  }
  return best;
}

export function fallbackDmg(notice: string): DmgRelease {
  const { tag, version, assetName, releaseName, prerelease, publishedAt, size } = FALLBACK_RELEASE;
  return {
    tag,
    version,
    assetName,
    releaseName,
    url: dmgUrl(tag, assetName),
    releaseUrl: releaseUrl(tag),
    size,
    prerelease,
    publishedAt,
    source: "fallback",
    notice,
  };
}

export async function getDmg(): Promise<DmgRelease> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "synapse-website",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=30`, {
      headers,
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
    if (!response.ok) {
      const notice = `GitHub API returned ${response.status}`;
      console.warn(`Synapse download is using the fallback release (${FALLBACK_RELEASE.tag}): ${notice}`);
      return fallbackDmg(notice);
    }
    const picked = pickDmg(await response.json());
    if (!picked) {
      const notice = "No arm64 DMG on a vX.Y.Z release";
      console.warn(`Synapse download is using the fallback release (${FALLBACK_RELEASE.tag}): ${notice}`);
      return fallbackDmg(notice);
    }
    return picked;
  } catch (error) {
    const notice = error instanceof Error ? error.message : "GitHub API request failed";
    console.warn(`Synapse download is using the fallback release (${FALLBACK_RELEASE.tag}): ${notice}`);
    return fallbackDmg(notice);
  }
}
