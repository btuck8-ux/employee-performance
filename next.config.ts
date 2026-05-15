import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Default Server Action body cap is 1 MB. Our heavy CSVs (combined
    // scheduled+worked time data, large POS exports — Downtown Denver
    // at 4.6 MB) need a higher ceiling.
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
