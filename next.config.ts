import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const createNextConfig = (phase: string): NextConfig => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER
    ? ".next-dev"
    : (process.env.NEXT_DIST_DIR || ".next-build-check"),
});

export default createNextConfig;
