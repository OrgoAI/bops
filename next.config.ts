import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop app is the product; Next's floating dev badge sat on top of the sidebar footer.
  devIndicators: false,
  // Loaded by Node, not bundled: the AgentMail SDK lazily imports optional payment packages
  // (@x402/fetch, mppx) that aren't installed, which the bundler can't resolve.
  serverExternalPackages: ["agentmail"],
  // The Mac app ships this server prebuilt (.next/standalone, started by desktop/main.cjs).
  output: "standalone",
  // Images are served as they are: resizing them on a local server isn't worth shipping sharp and
  // libvips (about 18 MB) in the app. next/image still renders, with the original file.
  images: { unoptimized: true },
  // Files the server reads or runs by path at runtime, which the build's tracing can't see:
  // the scripts it copies onto bots' computers (vm/), the browser tools it hands Codex
  // (lib/server/local.ts, sessions.ts), the page recorder it injects (lib/server/mirror.ts) and
  // AgentMail, which is loaded by Node at runtime (serverExternalPackages) with its one dependency.
  outputFileTracingIncludes: {
    "/*": [
      "./vm/**/*",
      "./node_modules/agentmail/**/*",
      "./node_modules/ws/**/*",
      "./node_modules/@playwright/mcp/**/*",
      "./node_modules/playwright/**/*",
      "./node_modules/playwright-core/**/*",
      "./node_modules/@rrweb/record/dist/record.umd.min.cjs",
    ],
  },
  // Reading .data/ and vm/ through process.cwd() makes the tracer take the whole project. Only
  // the built server, node_modules and the files above ship: never source, docs, the encrypted
  // envs/, local state or the desktop build itself.
  outputFileTracingExcludes: {
    "/*": [
      "./.data/**",
      "./.env*",
      "./app/**",
      "./assets/**",
      "./build/**",
      "./components/**",
      "./db/**",
      "./desktop/**",
      "./dist-desktop/**",
      "./docs/**",
      "./edge/**",
      "./envs/**",
      "./lib/**",
      "./orgo/**",
      "./scripts/**",
      "./site/**",
      "./types/**",
      "./vendor/**",
      "./node_modules/app-builder-lib/**",
      // Only next/image's optimizer loads these, and images are unoptimized (above).
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
      "./*.md",
      "./*.ts",
      "./*.mjs",
      "./components.json",
      "./package-lock.json",
      "./tsconfig.json",
    ],
    // The server's own trace (next-server, not a route's) is where next/image's optimizer pulls them in.
    "next-server": ["./node_modules/sharp/**", "./node_modules/@img/**"],
  },
};

export default nextConfig;
