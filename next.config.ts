import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next-build",
  output: "standalone",
};

export default nextConfig;
