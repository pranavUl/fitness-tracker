import type { NextConfig } from "next";

const UUID = "[0-9a-fA-F-]{36}";

const nextConfig: NextConfig = {
  // Workout and run screens moved from /workout/<id> to /workout?id=<id> so a
  // single cached page can open any of them offline. Keep old links working.
  async redirects() {
    return [
      {
        source: `/workout/:id(${UUID})/summary`,
        destination: "/workout/summary?id=:id",
        permanent: false,
      },
      {
        source: `/workout/:id(${UUID})`,
        destination: "/workout?id=:id",
        permanent: false,
      },
      {
        source: `/run/:id(${UUID})`,
        destination: "/run?id=:id",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
