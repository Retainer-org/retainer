import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Monorepo: the lockfile lives at the repo root, so Turbopack must be told that is the root.
  turbopack: { root: path.join(import.meta.dirname, "..", "..") },
  // Workspace packages ship untranspiled ESM.
  transpilePackages: ["@retainer/chain", "@retainer/db"],
};

export default nextConfig;
