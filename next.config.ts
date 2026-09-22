import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // There is a second package-lock.json in the PARENT folder
  // (../package-lock.json). Without this, Turbopack misdetects the project
  // root as that parent folder and resolves node_modules from there — where
  // dependencies like lucide-react don't exist ("Cannot find module").
  turbopack: {
    root: path.join(__dirname),
  },
  async headers() {
    return [
      {
        // Data assets are NEVER cached by the browser: these files keep stable
        // names across builds/uploads, so any cached copy risks serving data
        // the CMS has already deleted or replaced (the old 1-day cache +
        // stale-while-revalidate kept deleted sales data on screen and made
        // refreshes useless). Every visit fetches the current bytes — the
        // versioned IDB cache provides the speed on repeat visits. NOTE: there
        // is deliberately no <link rel=preload> for these files — preload
        // never matches a cache:'no-store' fetch and just downloaded the file
        // twice.
        source: '/geojson/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default nextConfig;
