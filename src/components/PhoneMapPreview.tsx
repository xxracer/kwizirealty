'use client';

import { useEffect, useRef } from 'react';

/**
 * Lightweight decorative map for the landing-page phone mockup.
 *
 * It replaces the full MapComponent there (Leaflet + Turf + the engine +
 * Firebase — all dead weight for a pointer-events-none decoration) with a
 * plain canvas: it fetches the small zipcodes GeoJSON (132 KB gz) once and
 * paints the polygons in the same "no data" gray the real map shows when no
 * metric values are set.
 */

// Houston metro viewport — matches the real map's initial view closely enough
// for a decorative crop.
const BOUNDS = { minLng: -96.1, maxLng: -94.8, minLat: 29.45, maxLat: 30.25 };

async function fetchGzJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ds = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    let text: string;
    if (ds) {
      const buf = await res.arrayBuffer();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
      text = await new Response(stream.pipeThrough(new ds('gzip'))).text();
    } else {
      text = await res.text();
    }
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

type Ring = [number, number][];

function collectRings(geometry: { type: string; coordinates: unknown }, out: Ring[]) {
  if (geometry.type === 'Polygon') {
    out.push((geometry.coordinates as number[][])[0] as unknown as Ring);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates as number[][][]) {
      out.push(poly[0] as unknown as Ring);
    }
  }
}

export default function PhoneMapPreview({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const draw = (fc: GeoJSON.FeatureCollection, canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.scale(dpr, dpr);

      const { minLng, maxLng, minLat, maxLat } = BOUNDS;
      const spanLng = maxLng - minLng;
      const spanLat = maxLat - minLat;
      // Fit the bbox inside the canvas, preserving aspect ratio (like the map).
      const scale = Math.min(w / spanLng, h / spanLat);
      const offX = (w - spanLng * scale) / 2;
      const offY = (h + spanLat * scale) / 2; // lat grows upward on screen

      const project = (lng: number, lat: number): [number, number] => [
        offX + (lng - minLng) * scale,
        offY - (lat - minLat) * scale,
      ];

      ctx.fillStyle = '#374151';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 0.5;

      const rings: Ring[] = [];
      for (const feature of fc.features) {
        collectRings(feature.geometry as never, rings);
      }
      for (const ring of rings) {
        if (ring.length < 2) continue;
        ctx.beginPath();
        let first = true;
        for (const [lng, lat] of ring) {
          if (lng < minLng - 0.5 || lng > maxLng + 0.5 || lat < minLat - 0.5 || lat > maxLat + 0.5) continue;
          const [x, y] = project(lng, lat);
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    };

    const canvas = canvasRef.current;
    if (!canvas) return;

    let onResize: (() => void) | null = null;
    fetchGzJson<GeoJSON.FeatureCollection>('/geojson/zipcodes.geojson.gz').then((fc) => {
      if (cancelled || !fc) return;
      draw(fc, canvas);
      // The hero mockup scales with the viewport — repaint on resize.
      onResize = () => draw(fc, canvas);
      window.addEventListener('resize', onResize);
    });

    return () => {
      cancelled = true;
      if (onResize) window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className={`h-full w-full ${className}`} />;
}