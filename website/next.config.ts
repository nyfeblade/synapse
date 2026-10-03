import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const websiteRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: websiteRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
