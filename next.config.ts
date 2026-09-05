import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [],
  async redirects() {
    return [{
      source: "/:path*",
      has: [{ type: "host", value: "management\\.titanium-pharmacy\\.com" }],
      destination: "https://www.management.titanium-pharmacy.com/:path*",
      permanent: true,
    }];
  },
};

export default nextConfig;
