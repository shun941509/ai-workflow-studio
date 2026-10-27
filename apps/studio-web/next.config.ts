import type { NextConfig } from "next";
import { publicCloudConfiguration } from './src/config/public-cloud';

// Stop before bundling if a privileged credential was mistakenly assigned a public variable.
publicCloudConfiguration();

/** Workspace source is compiled by Next; package-kit stays behind server-only routes. */
const config: NextConfig = {
  transpilePackages: ["@studio/spec", "@studio/workflow-core", "@studio/package-kit", "@studio/ui"],
  poweredByHeader: false,
  // Shared ESM packages keep .js specifiers for Node builds; webpack resolves their TypeScript source here.
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ...webpackConfig.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return webpackConfig;
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ] }];
  }
};
export default config;
