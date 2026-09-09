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
        source: '/map',
        headers: [
          {
            key: 'Link',
            value:
              '</cache/initial_metrics_subdivisions.json.gz>; rel=preload; as=fetch; crossorigin=anonymous, </geojson/subdivisions.geojson.gz>; rel=preload; as=fetch; crossorigin=anonymous',
          },
        ],
      },
      {
        // Cacheable static data assets. Filenames are stable, so we can't mark
        // them immutable — use 1 day fresh + a week of stale-while-revalidate so
        // repeat visits hit the browser cache first (the dataset itself is also
        // cached in IndexedDB, which makes repeat loads near-instant).
        source: '/cache/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
      {
        source: '/geojson/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
    ];
  },
};

export default nextConfig;
