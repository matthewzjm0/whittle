import type { NextConfig } from "next";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Dev-only origin allowlist.
//
// Next dev BLOCKS /_next resources (JS chunks, HMR) from hosts not listed
// here. A hardcoded IP silently breaks hydration when the laptop's network
// changes: the page renders, but React never attaches — the prompt textarea
// accepts text while the send button stays greyed.
//
// Generate the list from the machine's CURRENT network interfaces so the app
// keeps working wherever the laptop is. Override/extend with:
//   PIPELINE_ALLOWED_DEV_ORIGINS=host1,host2
// ---------------------------------------------------------------------------

function devOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1"]);
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info || info.internal || !info.address) continue;
      origins.add(info.address);
      origins.add(`${info.address}:3000`);
    }
  }
  const extra = process.env.PIPELINE_ALLOWED_DEV_ORIGINS;
  if (extra) {
    for (const o of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      origins.add(o);
      origins.add(`${o}:3000`);
    }
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  turbopack: { root: path.resolve(__dirname, "../..") },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
};

export default nextConfig;
