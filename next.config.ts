import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/catalog": ["./data/catalog.json"],
    "/api/catalog/providers/[code]": ["./data/catalog.json"],
    "/api/update": ["./data/catalog.json"],
  },
};

export default nextConfig;
