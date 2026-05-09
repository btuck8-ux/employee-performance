import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Default is 1MB which is too small for combined scheduled+worked CSV uploads.
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
