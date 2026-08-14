import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ];
  },
};

export default nextConfig;
