import type { MetadataRoute } from "next";
import { SITEMAP_PATHS } from "@/lib/nav";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return SITEMAP_PATHS.map((path) => ({
    url: `${base}${path}`,
    changeFrequency: path === "/" || path === "/download" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : path === "/download" ? 0.9 : 0.7,
  }));
}
