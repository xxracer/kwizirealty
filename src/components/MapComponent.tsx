'use client';

import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as turf from '@turf/turf';
import { PropertyData, BoundaryKey, engine, cleanBoundaryName, cleanSchoolName } from '@/lib/engine';
import { MousePointer2, Square, Trash2, BarChart3, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cmsStore } from '@/lib/cmsStore';

function LassoIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14c0-4.5 4-7 8-7s8 2.5 8 6-3.5 6-8 6c-2 0-3.7-.5-5-1.4" />
      <circle cx="8" cy="16.5" r="0.8" fill="currentColor" />
      <path d="M6 19l-1.5 2" />
    </svg>
  );
}

const BOUNDARY_SOURCES: Record<BoundaryKey, string> = {
  subdivisions: 'Mapped Subdivisions.geojson',
  zipcodes: 'Zip.geojson',
  highschools: 'Houston_ISD.geojson',
  elementary: 'Elementary School ISD.geojson',
  middle: 'Middle School ISD.geojson',
  neighborhoods: 'Mapped Subdivisions.geojson',
  areas: '',
};

const BOUNDARY_KEYS: BoundaryKey[] = [
  'subdivisions',
  'zipcodes',
  'highschools',
  'elementary',
  'middle',
  'neighborhoods',
];

type RGB = { r: number; g: number; b: number };

type ToolMode = 'select' | 'box' | 'lasso';

function hexToRgb(hex: string): RGB | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return { r, g, b };
}

function lerpColor(c1: string, c2: string, t: number): string {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  if (!a || !b) return c1;
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(a.r + (b.r - a.r) * clamped);
  const g = Math.round(a.g + (b.g - a.g) * clamped);
  const bl = Math.round(a.b + (b.b - a.b) * clamped);
  return `rgb(${r}, ${g}, ${bl})`;
}

function pointInPolygon(point: [number, number], polygon: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function getColorForValue(value: number, stops: [number, string][]): string {
  if (!stops.length) return '#2c7be5';
  if (value <= stops[0][0]) return stops[0][1];
  if (value >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v1, c1] = stops[i];
    const [v2, c2] = stops[i + 1];
    if (value >= v1 && value <= v2) {
      if (v2 === v1) return c1;
      const t = (value - v1) / (v2 - v1);
      return lerpColor(c1, c2, t);
    }
  }
  return stops[stops.length - 1][1];
}

function isValidCoord(lng: number, lat: number): boolean {
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    isFinite(lng) &&
    isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function getGeoProp(props: Record<string, any>, ...names: string[]): any {
  for (const n of names) {
    if (n in props) return props[n];
  }
  return undefined;
}

function computeFeatureBBox(feature: GeoJSON.Feature): [number, number, number, number] | null {
  const geom = feature.geometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coord: number[]) => {
    const [lng, lat] = coord;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  if (geom.type === 'Polygon') {
    geom.coordinates.forEach((ring) => ring.forEach(visit));
  } else {
    geom.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
  }
  if (!isFinite(minLng) || !isFinite(maxLng) || !isFinite(minLat) || !isFinite(maxLat)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function computeDataBounds(data: PropertyData[]): L.LatLngBounds | null {
  const lats: number[] = [];
  const lngs: number[] = [];
  data.forEach((d) => {
    if (isValidCoord(d.lng, d.lat)) {
      lats.push(d.lat);
      lngs.push(d.lng);
    }
  });
  if (!lats.length || !lngs.length) return null;

  // Trim the outer 10% of coordinates from each side so a handful of distant
  // outliers (e.g. Huntsville, far west/east listings) don't shrink the map
  // to a regional view. This keeps the dense Houston metro filling the box.
  const sortedLats = [...lats].sort((a, b) => a - b);
  const sortedLngs = [...lngs].sort((a, b) => a - b);
  const minLat = quantile(sortedLats, 0.10);
  const maxLat = quantile(sortedLats, 0.90);
  const minLng = quantile(sortedLngs, 0.10);
  const maxLng = quantile(sortedLngs, 0.90);

  const bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
  return bounds;
}

function formatMoney(num: number): string {
  if (!num || !isFinite(num)) return '$0';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(0) + 'K';
  return '$' + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

interface MapComponentProps {
  boundary: BoundaryKey;
  metricValues: Record<string, number>;
  sampleCounts: Record<string, number>;
  nameMap: Record<string, string>;
  colorStops: [number, string][];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  multiSelect: boolean;
  rawData: PropertyData[];
  showSales: boolean;
  showRentals: boolean;
  showFlood: boolean;
  metricLabel: string;
  fillOpacity: number;
  onClear?: () => void;
  onGenerateReport?: () => void;
  reportGenerated?: boolean;
  isReportLoading?: boolean;
  /** Incremented by the parent (e.g. after a search) to fly the map to the current selection. */
  focusSelectionTick?: number;
}

export default function MapComponent({
  boundary,
  metricValues,
  sampleCounts,
  nameMap,
  colorStops,
  selectedIds,
  onSelectionChange,
  multiSelect,
  rawData,
  showSales,
  showRentals,
  showFlood,
  metricLabel,
  fillOpacity,
  onClear,
  onGenerateReport,
  reportGenerated,
  isReportLoading,
  focusSelectionTick,
}: MapComponentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const areaLayerRef = useRef<L.GeoJSON | null>(null);
  const salesLayerRef = useRef<L.GeoJSON | null>(null);
  const rentalsLayerRef = useRef<L.GeoJSON | null>(null);
  const floodLayerRef = useRef<L.TileLayer.WMS | null>(null);
  const popupRef = useRef<L.Popup | null>(null);
  const areaFeaturesRef = useRef<GeoJSON.Feature[]>([]);
  const boundsSetRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const updateOverlayRef = useRef<(() => void) | null>(null);

  const [tool, setTool] = useState<ToolMode>('select');
  const [geoJsonData, setGeoJsonData] = useState<GeoJSON.FeatureCollection | null>(null);
  const geoJsonDataRef = useRef(geoJsonData);
  geoJsonDataRef.current = geoJsonData;
  const [boundaryLoading, setBoundaryLoading] = useState(false);
  const [boundarySwitching, setBoundarySwitching] = useState(true);
  const [areaLayerReady, setAreaLayerReady] = useState(false);
  const boundaryCacheRef = useRef<Partial<Record<BoundaryKey, GeoJSON.FeatureCollection>>>({});
  const initialRevealDoneRef = useRef(false);

  const multiSelectRef = useRef(multiSelect);
  const selectedRef = useRef(selectedIds);
  const rawDataRef = useRef(rawData);
  const metricLabelRef = useRef(metricLabel);
  const fillOpacityRef = useRef(fillOpacity);
  const metricValuesRef = useRef(metricValues);
  const sampleCountsRef = useRef(sampleCounts);
  const nameMapRef = useRef(nameMap);
  const colorStopsRef = useRef(colorStops);
  const toolRef = useRef<ToolMode>('select');

  multiSelectRef.current = multiSelect;
  selectedRef.current = selectedIds;
  rawDataRef.current = rawData;
  metricLabelRef.current = metricLabel;
  fillOpacityRef.current = fillOpacity;
  metricValuesRef.current = metricValues;
  sampleCountsRef.current = sampleCounts;
  nameMapRef.current = nameMap;
  colorStopsRef.current = colorStops;
  toolRef.current = tool;

  const buildAreaFeatures = (): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] => {
    console.log('Building area features for boundary:', boundary);
    console.log('GeoJSON Data:', geoJsonData ? 'loaded' : 'null', 'features:', geoJsonData?.features?.length);
    if (!geoJsonData || !geoJsonData.features) return [];

    const features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = [];

    geoJsonData.features.forEach((feature) => {
      const props = feature.properties || {};

      // Match common identifiers in the GeoJSON to what our engine expects.
      // Property names vary by file (NAME vs Name vs Zip_Code), so we look
      // case-insensitively.
      let rawName = '';
      if (boundary === 'elementary' || boundary === 'middle') {
        rawName = getGeoProp(props, 'Name', 'NAME') || '';
      } else if (boundary === 'zipcodes') {
        rawName = getGeoProp(props, 'Zip_Code') || '';
      } else if (boundary === 'highschools') {
        rawName = getGeoProp(props, 'NAME') || '';
      } else {
        rawName = getGeoProp(props, 'NAME', 'Name', 'Subdivision', 'id') || '';
      }
      const key = boundary === 'elementary' || boundary === 'middle'
        ? cleanSchoolName(rawName)
        : cleanBoundaryName(rawName);
      if (!key) return;

      const value = metricValues[key];
      const hasMetric = value && isFinite(value);
      // Don't render grey placeholder areas with no data.
      if (!hasMetric) return;
      const color = getColorForValue(value, colorStops);
      const count = sampleCounts[key] || 0;
      const name = nameMap[key] || String(rawName || key);

      // Only push if there's valid geometry
      if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
        // Precompute the feature's bbox and centroid once so box/lasso hit
        // tests can use fast numeric comparisons instead of calling expensive
        // turf helpers on every selection.
        const bbox = computeFeatureBBox(feature as GeoJSON.Feature);
        const centroid = bbox ? turf.centroid(feature as GeoJSON.Feature) : null;
        features.push({
          type: 'Feature',
          id: key,
          properties: { ...props, id: key, name, value, count, color, hasMetric, _bbox: bbox, _centroid: centroid },
          geometry: feature.geometry as any,
        });
      }
    });

    return features;
  };

  const buildPointFeatures = (data: PropertyData[]): GeoJSON.Feature<GeoJSON.Point>[] => {
    return data
      .filter((d) => isValidCoord(d.lng, d.lat))
      .map((d) => ({
        type: 'Feature' as const,
        properties: { price: d.closePrice },
        geometry: { type: 'Point' as const, coordinates: [d.lng, d.lat] },
      }));
  };

  const buildRentalFeatures = (data: PropertyData[]): GeoJSON.Feature<GeoJSON.Point>[] => {
    const rentals = engine.generateRentalPoints(data);
    return rentals
      .filter((d) => isValidCoord(d.lng, d.lat))
      .map((d) => ({
        type: 'Feature' as const,
        properties: { rent: d.listPrice || d.closePrice },
        geometry: { type: 'Point' as const, coordinates: [d.lng, d.lat] },
      }));
  };

  const makePopupHtml = (feature: GeoJSON.Feature): string => {
    const props = (feature.properties || {}) as Record<string, any>;
    const name = props.name ?? String(feature.id ?? props.id ?? '');
    const value = Number(props.value ?? 0);
    const count = Number(props.count ?? 0);
    const hasMetric = props.hasMetric !== false;
    const lowerLabel = metricLabelRef.current.toLowerCase();
    const valueText = !hasMetric
      ? 'No data'
      : lowerLabel.includes('price') || lowerLabel.includes('$/sqft')
      ? formatMoney(value)
      : lowerLabel.includes('ratio') || lowerLabel.includes('%')
      ? value.toFixed(1) + '%'
      : value.toFixed(1);
    const valueColor = hasMetric ? '#2c7be5' : '#9ca3af';

    return `
      <div style="font-family:sans-serif;color:#fff;background:#161a24;border:1px solid #374151;border-radius:8px;padding:10px;min-width:180px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${name}</div>
        <div style="font-size:12px;color:#9ca3af;">${metricLabelRef.current}: <span style="color:${valueColor};font-weight:700;">${valueText}</span></div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${count.toLocaleString()} properties</div>
      </div>
    `;
  };

  const applySelectionHits = (hits: Set<string>) => {
    if (!hits.size) return;
    // Box / Lasso always selects every area inside the drawn shape.
    // The multi-select checkbox only controls whether we add to or replace
    // the current selection.
    if (multiSelectRef.current) {
      const merged = new Set([...selectedRef.current, ...hits]);
      onSelectionChange(Array.from(merged));
    } else {
      onSelectionChange(Array.from(hits));
    }
  };

  const serverLog = (label: string, data: any) => {
    try {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, data }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // ignore
    }
  };

  const selectFromBoxBounds = (bounds: L.LatLngBounds) => {
    if (!areaFeaturesRef.current.length) return;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const minLng = sw.lng;
    const minLat = sw.lat;
    const maxLng = ne.lng;
    const maxLat = ne.lat;

    const boxLog = { total: areaFeaturesRef.current.length, bounds: { minLng, minLat, maxLng, maxLat } };
    console.log('[Kwizi Box] start', boxLog);
    serverLog('Kwizi Box start', boxLog);
    const t0 = performance.now();
    let bboxRejects = 0;
    let tests = 0;

    const hits = new Set<string>();
    areaFeaturesRef.current.forEach((f) => {
      const props = (f.properties || {}) as Record<string, any>;
      const bbox = props._bbox as [number, number, number, number] | undefined;
      const centroid = props._centroid as GeoJSON.Feature<GeoJSON.Point> | undefined;
      if (!bbox || !centroid) return;
      const [fMinLng, fMinLat, fMaxLng, fMaxLat] = bbox;
      // Quick bbox overlap reject.
      if (fMaxLng < minLng || fMinLng > maxLng || fMaxLat < minLat || fMinLat > maxLat) {
        bboxRejects++;
        return;
      }
      tests++;
      const [lng, lat] = centroid.geometry.coordinates;
      if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
        const id = String(props.id ?? f.id ?? '');
        if (id) hits.add(id);
      }
    });
    const ms = Math.round(performance.now() - t0);
    const boxDoneLog = { ms, bboxRejects, tests, hits: hits.size };
    console.log('[Kwizi Box] done', boxDoneLog);
    serverLog('Kwizi Box done', boxDoneLog);
    applySelectionHits(hits);
  };

  const selectFromPolygon = (poly: GeoJSON.Feature) => {
    if (!poly || !areaFeaturesRef.current.length) return;
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(poly);
    const ring = (poly.geometry as GeoJSON.Polygon).coordinates[0];

    const lassoLog = { total: areaFeaturesRef.current.length, bbox: { minLng, minLat, maxLng, maxLat }, points: ring.length };
    console.log('[Kwizi Lasso] start', lassoLog);
    serverLog('Kwizi Lasso start', lassoLog);
    const t0 = performance.now();
    let bboxRejects = 0;
    let tests = 0;

    const hits = new Set<string>();
    areaFeaturesRef.current.forEach((f) => {
      const props = (f.properties || {}) as Record<string, any>;
      const bbox = props._bbox as [number, number, number, number] | undefined;
      const centroid = props._centroid as GeoJSON.Feature<GeoJSON.Point> | undefined;
      if (!bbox || !centroid) return;
      const [fMinLng, fMinLat, fMaxLng, fMaxLat] = bbox;
      // Fast bbox overlap reject before expensive point-in-polygon test.
      if (fMaxLng < minLng || fMinLng > maxLng || fMaxLat < minLat || fMinLat > maxLat) {
        bboxRejects++;
        return;
      }
      tests++;
      const [lng, lat] = centroid.geometry.coordinates;
      if (pointInPolygon([lng, lat], ring)) {
        const id = String(props.id ?? f.id ?? '');
        if (id) hits.add(id);
      }
    });
    const ms = Math.round(performance.now() - t0);
    const lassoDoneLog = { ms, bboxRejects, tests, hits: hits.size };
    console.log('[Kwizi Lasso] done', lassoDoneLog);
    serverLog('Kwizi Lasso done', lassoDoneLog);
    applySelectionHits(hits);
  };

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      boxZoom: false,
    }).setView([29.76, -95.37], 10);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    // Disable Leaflet's native box-zoom handler so our custom Box tool is the
    // only one reacting to shift/mouse-drag and to avoid event conflicts.
    map.boxZoom.disable();

    // Constrain map to the data bounds once data is loaded. If the CSV data has
    // not been requested yet, fall back to the GeoJSON boundary bounds so the
    // map still frames the Houston metro immediately.
    const computeGeoJSONBounds = (): L.LatLngBounds | null => {
      const collection = geoJsonDataRef.current;
      if (!collection?.features?.length) return null;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const f of collection.features) {
        const bbox = computeFeatureBBox(f);
        if (!bbox) continue;
        const [fMinLng, fMinLat, fMaxLng, fMaxLat] = bbox;
        if (fMinLng < minLng) minLng = fMinLng;
        if (fMinLat < minLat) minLat = fMinLat;
        if (fMaxLng > maxLng) maxLng = fMaxLng;
        if (fMaxLat > maxLat) maxLat = fMaxLat;
      }
      if (!isFinite(minLng)) return null;
      return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
    };

    const applyBoundsOnce = () => {
      if (boundsSetRef.current) return;
      const bounds = computeDataBounds(rawDataRef.current) || computeGeoJSONBounds();
      if (!bounds) return;
      map.invalidateSize();
      // Tight fit with almost no padding so polygons/circles fill the container.
      const zoom = Math.min(12, map.getBoundsZoom(bounds, false, L.point(8, 8)));
      map.setView(bounds.getCenter(), zoom, { animate: false });
      map.setMaxBounds(bounds.pad(0.05));
      boundsSetRef.current = true;
    };
    applyBoundsOnce();
    const boundsInterval = setInterval(() => {
      if (boundsSetRef.current) {
        clearInterval(boundsInterval);
        return;
      }
      applyBoundsOnce();
    }, 100);
    const clearBoundsInterval = () => clearInterval(boundsInterval);

    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.zIndex = '600';
    overlay.style.cursor = 'crosshair';
    overlay.style.pointerEvents = 'none';
    overlay.style.touchAction = 'none';
    containerRef.current?.appendChild(overlay);
    overlayRef.current = overlay;

    const updateOverlayPointerEvents = () => {
      if (toolRef.current === 'select') {
        overlay.style.pointerEvents = 'none';
        overlay.style.cursor = 'default';
      } else {
        overlay.style.pointerEvents = 'auto';
        overlay.style.cursor = 'crosshair';
      }
    };
    updateOverlayPointerEvents();
    updateOverlayRef.current = updateOverlayPointerEvents;

    // --- Box select (pointer capture on overlay) ---
    let boxLayer: L.Rectangle | null = null;
    let boxStart: L.LatLng | null = null;
    let isBoxDrawing = false;

    const startBox = (latlng: L.LatLng) => {
      const log = { lat: latlng.lat, lng: latlng.lng };
      console.log('[Kwizi Box] start', log);
      serverLog('Kwizi Box start', log);
      isBoxDrawing = true;
      boxStart = latlng;
      map.dragging.disable();
      if (boxLayer) {
        boxLayer.remove();
        boxLayer = null;
      }
      boxLayer = L.rectangle(
        [
          [latlng.lat, latlng.lng],
          [latlng.lat, latlng.lng],
        ],
        {
          color: '#00d4ff',
          weight: 2,
          fillOpacity: 0.1,
          dashArray: '4 4',
        }
      ).addTo(map);
    };

    let boxRaf = 0;
    const moveBox = (latlng: L.LatLng) => {
      if (!isBoxDrawing || !boxStart || !boxLayer) return;
      if (boxRaf) return;
      const start = boxStart;
      boxRaf = requestAnimationFrame(() => {
        boxRaf = 0;
        if (!isBoxDrawing || !boxLayer) return;
        boxLayer.setBounds(L.latLngBounds([start.lat, start.lng], [latlng.lat, latlng.lng]));
      });
    };

    const finishBox = () => {
      if (!isBoxDrawing || !boxLayer) return;
      console.log('[Kwizi Box] finish');
      serverLog('Kwizi Box finish', {});
      isBoxDrawing = false;
      map.dragging.enable();
      const bounds = boxLayer.getBounds();
      boxLayer.remove();
      boxLayer = null;
      selectFromBoxBounds(bounds);
      setTool('select');
      updateOverlayPointerEvents();
    };

    // --- Lasso select ---
    let lassoPoints: L.LatLng[] = [];
    let lassoLayer: L.Polyline | null = null;
    let isLassoDrawing = false;

    const startLasso = (latlng: L.LatLng) => {
      isLassoDrawing = true;
      lassoPoints = [latlng];
      if (lassoLayer) {
        lassoLayer.remove();
        lassoLayer = null;
      }
      lassoLayer = L.polyline(lassoPoints, {
        color: '#00d4ff',
        weight: 2,
        dashArray: '4 4',
      }).addTo(map);
    };

    let lassoRaf = 0;
    const moveLasso = (latlng: L.LatLng) => {
      if (!isLassoDrawing || !lassoLayer) return;
      if (lassoRaf) return;
      lassoRaf = requestAnimationFrame(() => {
        lassoRaf = 0;
        if (!isLassoDrawing || !lassoLayer) return;
        lassoPoints.push(latlng);
        lassoLayer.setLatLngs(lassoPoints);
      });
    };

    const finishLasso = () => {
      if (!isLassoDrawing) return;
      isLassoDrawing = false;
      
      if (toolRef.current !== 'lasso' || lassoPoints.length < 3) {
        lassoLayer?.remove();
        lassoLayer = null;
        lassoPoints = [];
        return;
      }
      
      const finishLog = { points: lassoPoints.length };
      console.log('[Kwizi Lasso] finish', finishLog);
      serverLog('Kwizi Lasso finish', finishLog);
      const coords = lassoPoints.map((p) => [p.lng, p.lat]);
      (coords as number[][]).push([lassoPoints[0].lng, lassoPoints[0].lat]);
      
      try {
        const poly = turf.polygon([coords as number[][]]);
        selectFromPolygon(poly);
      } catch (err) {
        console.error('[Kwizi Lasso] invalid polygon', err);
      }
      
      lassoLayer?.remove();
      lassoLayer = null;
      lassoPoints = [];
      setTool('select');
      updateOverlayPointerEvents();
    };

    // Pointer events on overlay prevent Leaflet from panning/zooming while drawing.
    const onOverlayPointerDown = (e: PointerEvent) => {
      if (toolRef.current === 'select') return;
      const target = e.target as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const latlng = map.mouseEventToLatLng(e);
      if (toolRef.current === 'box') startBox(latlng);
      else if (toolRef.current === 'lasso') startLasso(latlng);
      e.preventDefault();
      e.stopPropagation();
    };

    const onOverlayPointerMove = (e: PointerEvent) => {
      if (toolRef.current === 'select') return;
      if (toolRef.current === 'box' && isBoxDrawing) {
        const latlng = map.mouseEventToLatLng(e);
        moveBox(latlng);
      } else if (toolRef.current === 'lasso' && isLassoDrawing) {
        const latlng = map.mouseEventToLatLng(e);
        moveLasso(latlng);
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onOverlayPointerUp = (e: PointerEvent) => {
      if (toolRef.current === 'select') return;
      const target = e.target as HTMLElement;
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be released
      }
      if (toolRef.current === 'box' && isBoxDrawing) finishBox();
      else if (toolRef.current === 'lasso' && isLassoDrawing) finishLasso();
      e.preventDefault();
      e.stopPropagation();
    };

    overlay.addEventListener('pointerdown', onOverlayPointerDown);
    overlay.addEventListener('pointermove', onOverlayPointerMove);
    overlay.addEventListener('pointerup', onOverlayPointerUp);

    // Lasso close: double-click on overlay or press Enter.
    const onOverlayDblClick = (e: MouseEvent) => {
      if (toolRef.current !== 'lasso') return;
      console.log('[Kwizi Lasso] dblclick');
      serverLog('Kwizi Lasso dblclick', {});
      e.preventDefault();
      e.stopPropagation();
      finishLasso();
    };
    overlay.addEventListener('dblclick', onOverlayDblClick);

    const onOverlayWheel = (e: WheelEvent) => {
      if (toolRef.current !== 'select') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    overlay.addEventListener('wheel', onOverlayWheel, { passive: false });

    const onKeyDown = (e: KeyboardEvent) => {
      if (toolRef.current !== 'lasso') return;
      if (e.key === 'Enter' && lassoPoints.length >= 3) {
        console.log('[Kwizi Lasso] Enter pressed');
        serverLog('Kwizi Lasso Enter', {});
        finishLasso();
      }
      if (e.key === 'Escape') {
        console.log('[Kwizi Lasso] Escape pressed');
        lassoLayer?.remove();
        lassoLayer = null;
        lassoPoints = [];
        setTool('select');
        updateOverlayPointerEvents();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      clearBoundsInterval();
      popupRef.current?.remove();
      overlay.removeEventListener('pointerdown', onOverlayPointerDown);
      overlay.removeEventListener('pointermove', onOverlayPointerMove);
      overlay.removeEventListener('pointerup', onOverlayPointerUp);
      overlay.removeEventListener('dblclick', onOverlayDblClick);
      overlay.removeEventListener('wheel', onOverlayWheel);
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      overlayRef.current = null;
      updateOverlayRef.current = null;
      map.remove();
      mapRef.current = null;
      boundsSetRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep overlay state and map dragging in sync with the active tool.
  useEffect(() => {
    toolRef.current = tool;
    updateOverlayRef.current?.();
    const map = mapRef.current;
    if (!map) return;
    if (tool === 'select') {
      try { map.dragging.enable(); } catch {}
    } else {
      try { map.dragging.disable(); } catch {}
    }
  }, [tool]);

  // Load boundary GeoJSON for the active boundary. We prefer same-domain files in
  // /geojson so Vercel serves them instantly, and fall back to Firebase CMS only
  // when the local copy is missing. All loaded boundaries are cached in memory
  // so switching between them is nearly instant after the first visit.
  const loadBoundary = async (key: BoundaryKey, { preloadOthers = false } = {}) => {
    setBoundaryLoading(true);
    setBoundarySwitching(true);
    setAreaLayerReady(false);

    const cached = boundaryCacheRef.current[key];
    if (cached) {
      setGeoJsonData(cached);
      setBoundaryLoading(false);
      if (preloadOthers) preloadRemainingBoundaries(key);
      return;
    }

    const localPath = `/geojson/${key}.geojson.gz`;
    try {
      const data = await engine.fetchGzJson<GeoJSON.FeatureCollection>(localPath);
      boundaryCacheRef.current[key] = data;
      setGeoJsonData(data);
      setBoundaryLoading(false);
      if (preloadOthers) preloadRemainingBoundaries(key);
      return;
    } catch (err) {
      console.warn(`[Kwizi Map] local GeoJSON missing for ${key}, falling back to CMS`, err);
    }

    // Fallback to Firebase CMS storage URL.
    try {
      const fileName = BOUNDARY_SOURCES[key];
      const allBoundaryFiles = await cmsStore.listFilesMetadataByCategory('boundary');
      const fileRecord = allBoundaryFiles.find((f) => f.name === fileName);
      if (!fileRecord || !fileRecord.storageUrl) {
        throw new Error(`Boundary file ${fileName} not found in Firebase CMS`);
      }
      const res = await fetch(fileRecord.storageUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GeoJSON.FeatureCollection;
      boundaryCacheRef.current[key] = data;
      setGeoJsonData(data);
    } catch (err) {
      console.error('[Kwizi Map] failed to load GeoJSON for', key, err);
      setGeoJsonData(null);
    } finally {
      setBoundaryLoading(false);
    }
  };

  const preloadRemainingBoundaries = async (current: BoundaryKey) => {
    const others = BOUNDARY_KEYS.filter((k) => k !== current && !boundaryCacheRef.current[k]);
    await Promise.all(
      others.map(async (k) => {
        try {
          boundaryCacheRef.current[k] = await engine.fetchGzJson<GeoJSON.FeatureCollection>(`/geojson/${k}.geojson.gz`);
        } catch {
          // Silent: preloading is optional; the active boundary is already loaded.
        }
      })
    );
  };

  useEffect(() => {
    loadBoundary(boundary, { preloadOthers: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const areaLayerJustBuiltRef = useRef(false);

  const makeAreaStyle = (id: string, value: number | undefined, selected: boolean) => ({
    fillColor: value && isFinite(value) ? getColorForValue(value, colorStopsRef.current) : '#374151',
    color: selected ? '#ec4899' : '#ffffff',
    weight: selected ? 2.5 : 0.75,
    opacity: Math.min(0.65, fillOpacityRef.current + 0.15),
    fillOpacity: selected ? Math.min(0.8, fillOpacityRef.current + 0.3) : fillOpacityRef.current,
  });

  const updateAreaLayerStyles = () => {
    if (!areaLayerRef.current) return;
    areaLayerRef.current.eachLayer((layer: any) => {
      const feature = layer.feature as GeoJSON.Feature | undefined;
      if (!feature) return;
      const props = (feature.properties || {}) as Record<string, any>;
      const id = String(props.id ?? feature.id ?? '');
      const value = metricValuesRef.current[id];
      const count = sampleCountsRef.current[id] || 0;
      const name = nameMapRef.current[id] || id;
      const hasMetric = value && isFinite(value);
      const color = hasMetric ? getColorForValue(value, colorStopsRef.current) : '#374151';

      props.value = value ?? 0;
      props.count = count;
      props.name = name;
      props.color = color;
      props.hasMetric = !!hasMetric;

      const selected = selectedRef.current.includes(id);
      layer.setStyle(makeAreaStyle(id, value, selected));
    });
  };

  const lastAreaFeatureIdsRef = useRef<string[]>([]);

  const sortedFeatureIds = (features: GeoJSON.Feature[]): string[] => {
    const ids = features.map((f) => String((f.properties as any)?.id ?? f.id ?? ''));
    ids.sort();
    return ids;
  };

  const featureIdsEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  const rebuildAreaLayer = (fitBounds = false) => {
    const map = mapRef.current;
    if (!map || !geoJsonData) return;

    console.log('[Kwizi Map] rebuildAreaLayer start', { fitBounds });
    const t0 = performance.now();
    setAreaLayerReady(false);

    if (areaLayerRef.current) {
      areaLayerRef.current.remove();
      areaLayerRef.current = null;
    }

    const areaFeatures = buildAreaFeatures();
    areaFeaturesRef.current = areaFeatures;
    lastAreaFeatureIdsRef.current = sortedFeatureIds(areaFeatures);
    console.log('[Kwizi Map] features to render', { count: areaFeatures.length });

    areaLayerRef.current = L.geoJSON(areaFeatures as any, {
      style: (feature) => {
        const props = (feature?.properties || {}) as Record<string, any>;
        const id = String(props.id ?? (feature as any).id ?? '');
        return makeAreaStyle(id, props.value, selectedRef.current.includes(id));
      },
      onEachFeature: (feature, layer) => {
        const pathLayer = layer as L.Path;
        const props = (feature.properties || {}) as Record<string, any>;
        const id = String(props.id ?? (feature as any).id ?? '');

        pathLayer.on('mouseover', (e) => {
          pathLayer.setStyle({ weight: 1.6, color: '#00d4ff', fillOpacity: Math.min(0.8, fillOpacityRef.current + 0.3) });
          if (!popupRef.current) {
            popupRef.current = L.popup({
              closeButton: false,
              autoPan: false,
              className: 'kwizi-map-popup',
            });
          }
          popupRef.current.setLatLng(e.latlng).setContent(makePopupHtml(feature)).openOn(map);
        });

        pathLayer.on('mousemove', (e) => {
          popupRef.current?.setLatLng(e.latlng);
        });

        pathLayer.on('mouseout', () => {
          const selected = selectedRef.current.includes(id);
          pathLayer.setStyle(makeAreaStyle(id, props.value, selected));
          popupRef.current?.close();
        });

        pathLayer.on('click', (e) => {
          if (toolRef.current !== 'select') return;
          L.DomEvent.stopPropagation(e);
          const currentlySelected = selectedRef.current.includes(id);
          let next: string[];
          if (multiSelectRef.current) {
            next = currentlySelected
              ? selectedRef.current.filter((x) => x !== id)
              : [...selectedRef.current, id];
          } else {
            next = currentlySelected ? [] : [id];
          }
          onSelectionChange(next);
        });
      },
    }).addTo(map);

    areaLayerJustBuiltRef.current = true;
    setAreaLayerReady(true);
    if (initialRevealDoneRef.current) {
      setBoundarySwitching(false);
    } else if (areaFeaturesRef.current.length > 0) {
      initialRevealDoneRef.current = true;
      setBoundarySwitching(false);
    }

    if (fitBounds) {
      const pointBounds = computeDataBounds(rawDataRef.current);
      if (pointBounds) {
        map.invalidateSize();
        map.fitBounds(pointBounds, { padding: [8, 8], maxZoom: 12, animate: false });
      }
    }

    console.log('[Kwizi Map] rebuildAreaLayer done', { ms: Math.round(performance.now() - t0), rendered: areaFeatures.length });
  };

  // Build (or rebuild) the area layer when the boundary or the set of
  // data-backed areas changes. No-data polygons are now filtered out, so the
  // number of rendered paths drops and the map no longer shows grey squares.
  useEffect(() => {
    rebuildAreaLayer(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoJsonData, boundary]);

  // If the visible area set changed (e.g. filter/metric made an area lose/gain
  // data), rebuild so grey no-data placeholders never appear. Otherwise just
  // update colors/fills in place to keep palette/opacity tweaks cheap.
  useEffect(() => {
    if (areaLayerJustBuiltRef.current) {
      areaLayerJustBuiltRef.current = false;
      return;
    }
    const nextFeatures = buildAreaFeatures();
    const nextIds = sortedFeatureIds(nextFeatures);
    if (featureIdsEqual(nextIds, lastAreaFeatureIdsRef.current)) {
      updateAreaLayerStyles();
    } else {
      areaFeaturesRef.current = nextFeatures;
      lastAreaFeatureIdsRef.current = nextIds;
      rebuildAreaLayer(false);
      areaLayerJustBuiltRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricValues, sampleCounts, nameMap, colorStops, fillOpacity]);

  // Sync selection styles without rebuilding layers
  useEffect(() => {
    if (!areaLayerRef.current) return;
    areaLayerRef.current.eachLayer((layer: any) => {
      const feature = layer.feature as GeoJSON.Feature | undefined;
      if (!feature) return;
      const props = (feature.properties || {}) as Record<string, any>;
      const id = String(props.id ?? feature.id ?? '');
      const selected = selectedIds.includes(id);
      layer.setStyle(makeAreaStyle(id, props.value, selected));
    });
  }, [selectedIds]);

  // Fly the map to the selected features when the parent signals a focus
  // event (e.g. the sidebar search found a match) so the user actually sees
  // what was selected instead of a distant highlight.
  useEffect(() => {
    if (!focusSelectionTick) return;
    const map = mapRef.current;
    if (!map || selectedIds.length === 0) return;
    const bounds = L.latLngBounds([]);
    let found = 0;
    areaLayerRef.current?.eachLayer((layer: any) => {
      const feature = layer.feature as GeoJSON.Feature | undefined;
      if (!feature) return;
      const props = (feature.properties || {}) as Record<string, any>;
      const id = String(props.id ?? feature.id ?? '');
      if (selectedIds.includes(id) && typeof layer.getBounds === 'function') {
        bounds.extend(layer.getBounds());
        found++;
      }
    });
    if (found > 0 && bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 13 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSelectionTick]);

  // Sales / rental point layers update only when data or visibility toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (salesLayerRef.current) {
      salesLayerRef.current.remove();
      salesLayerRef.current = null;
    }
    if (rentalsLayerRef.current) {
      rentalsLayerRef.current.remove();
      rentalsLayerRef.current = null;
    }

    const salesFeatures = buildPointFeatures(rawData);
    if (showSales) {
      salesLayerRef.current = L.geoJSON(salesFeatures as any, {
        pointToLayer: (feature, latlng) => {
          return L.circleMarker(latlng, {
            radius: 3,
            fillColor: '#2c7be5',
            color: '#ffffff',
            weight: 1,
            opacity: 0.6,
            fillOpacity: 0.6,
          });
        },
      }).addTo(map);
    }

    const rentalFeatures = buildRentalFeatures(rawData);
    if (showRentals) {
      rentalsLayerRef.current = L.geoJSON(rentalFeatures as any, {
        pointToLayer: (feature, latlng) => {
          return L.circleMarker(latlng, {
            radius: 3,
            fillColor: '#fb923c',
            color: '#ffffff',
            weight: 1,
            opacity: 0.6,
            fillOpacity: 0.6,
          });
        },
      }).addTo(map);
    }
  }, [rawData, showSales, showRentals]);

  // Flood layer toggles a FEMA ArcGIS MapServer. We use the geoplatform host which
  // proxies FEMA NFHL — it's faster and more reliable than the legacy NFHL WMS
  // endpoint and exposes the same OGC WMS interface.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const cleanup = () => {
      if (floodLayerRef.current) {
        floodLayerRef.current.remove();
        floodLayerRef.current = null;
      }
    };

    if (!showFlood) {
      cleanup();
      return;
    }

    if (floodLayerRef.current) return;

    const wms = L.tileLayer.wms(
      'https://hazards.geoplatform.gov/server/services/FEMA/FEMA_FLOODPLAIN/MapServer/WMSServer',
      {
        layers: '0', // FEMA Flood Hazard Areas
        format: 'image/png',
        transparent: true,
        opacity: 0.55,
        version: '1.3.0',
        attribution: 'FEMA NFHL via geoplatform.gov',
        // If the host is slow / down, Leaflet will keep retrying silently — we
        // don't want an error toast every minute, so we just log.
      }
    );
    wms.on('tileerror', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[Flood] tile error', err);
    });
    wms.addTo(map);
    floodLayerRef.current = wms;

    return cleanup;
  }, [showFlood]);

  // Never keep the boundary loading overlay stuck for more than 12 seconds;
  // if the CSV or boundary genuinely has no data we still want the map usable.
  useEffect(() => {
    const id = setTimeout(() => {
      if (!initialRevealDoneRef.current) {
        initialRevealDoneRef.current = true;
        setBoundarySwitching(false);
      }
    }, 12000);
    return () => clearTimeout(id);
  }, []);

  const showBoundaryOverlay = boundaryLoading || boundarySwitching;

  return (
    <div ref={containerRef} className="h-full w-full relative" aria-label="Interactive real estate market map">
      <AnimatePresence>
        {showBoundaryOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[1000] bg-black/30 flex items-center justify-center backdrop-blur-sm"
          >
            <div className="bg-[#121620] border border-white/[0.06] rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
              <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
              <p className="text-sm text-gray-200 font-medium tracking-wide">Loading Boundary Data...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isReportLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[1001] bg-black/40 flex items-center justify-center backdrop-blur-sm"
          >
            <div className="bg-[#121620] border border-white/[0.06] rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl max-w-[260px] text-center">
              <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
              <p className="text-sm text-gray-200 font-medium tracking-wide">Generating Report...</p>
              <p className="text-xs text-gray-400">Loading property data for the selected areas.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tool !== 'select' && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            className="absolute top-4 left-1/2 z-[1001] bg-blue-600/90 backdrop-blur text-white px-5 py-2.5 rounded-full text-sm font-semibold shadow-2xl pointer-events-none border border-white/20 whitespace-nowrap"
          >
            {tool === 'box'
              ? 'Click and drag on the map to draw a selection box'
              : 'Click to add points. Double-click or press Enter to finish shape.'}
          </motion.div>
        )}
      </AnimatePresence>

      <div data-tour="map-tools" className="absolute top-3 right-3 z-[500] flex flex-col gap-2">
        {([
          { key: 'select', label: 'Select', desc: 'Click polygons to select them', Icon: MousePointer2 },
          { key: 'box', label: 'Box', desc: 'Drag a rectangle to select areas inside it', Icon: Square },
          { key: 'lasso', label: 'Lasso', desc: 'Draw a freehand shape to select areas inside', Icon: LassoIcon },
        ] as { key: ToolMode; label: string; desc: string; Icon: any }[]).map(({ key, label, desc, Icon }) => (
          <div key={key} className="relative group">
            <button
              onClick={() => setTool(key)}
              aria-label={label}
              className={`w-9 h-9 rounded-lg border shadow flex items-center justify-center transition-colors ${
                tool === key
                  ? 'bg-[#2563eb] border-blue-500 text-white'
                  : 'bg-[#121620] border-white/[0.06] text-gray-300 hover:bg-[#1f2937]'
              }`}
            >
              <Icon className="w-4 h-4" />
            </button>
            <div className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap bg-gray-900 border border-gray-700 text-gray-200 text-xs px-2 py-1 rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="font-semibold text-white">{label}</span>
              <span className="text-gray-400"> · {desc}</span>
            </div>
          </div>
        ))}
        <button
          onClick={() => {
            onSelectionChange([]);
            if (onClear) onClear();
          }}
          title="Clear selection"
          className="w-9 h-9 rounded-lg border shadow bg-[#121620] border-white/[0.06] text-gray-300 hover:bg-rose-900/40 hover:text-rose-400 hover:border-rose-700 flex items-center justify-center transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {selectedIds.length > 0 && !reportGenerated && (
          <motion.button
            initial={{ opacity: 0, scale: 0.5, x: 20 }}
            animate={{
              opacity: isReportLoading ? 0.6 : 1,
              scale: 1,
              x: 0,
              boxShadow: isReportLoading
                ? 'none'
                : [
                    '0 0 0 0 rgba(37,99,235,0.7)',
                    '0 0 0 10px rgba(37,99,235,0)',
                    '0 0 0 0 rgba(37,99,235,0)',
                  ],
            }}
            transition={{
              opacity: { duration: 0.3 },
              scale: { type: 'spring', stiffness: 260, damping: 16 },
              x: { type: 'spring', stiffness: 260, damping: 18 },
              boxShadow: { repeat: Infinity, duration: 1.6, ease: 'easeInOut' },
            }}
            whileHover={isReportLoading ? {} : { scale: 1.05 }}
            whileTap={isReportLoading ? {} : { scale: 0.95 }}
            onClick={isReportLoading ? undefined : onGenerateReport}
            disabled={isReportLoading}
            data-tour="generate-report"
            title={isReportLoading ? 'Generating report…' : 'Generate Market Report'}
            className={`w-auto h-9 px-3 rounded-lg border shadow bg-gradient-to-r from-blue-600 to-emerald-500 border-transparent text-white flex items-center gap-2 font-bold text-xs whitespace-nowrap ${
              isReportLoading ? 'cursor-not-allowed' : 'hover:from-blue-700 hover:to-emerald-600'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span className="hidden sm:inline">{isReportLoading ? 'Generating…' : 'Generate Report'}</span>
            <span className="sm:hidden">{isReportLoading ? '…' : 'Report'}</span>
          </motion.button>
        )}
      </div>

      {/* Map legend — mirrors the sidebar palette so the colors on the map
          always match the gradient in the sidebar. */}
      {colorStops && colorStops.length >= 2 && (
        <div className="absolute bottom-3 left-3 z-[400] bg-[#121620]/85 backdrop-blur border border-white/[0.08] rounded-lg px-3 py-2 shadow-lg pointer-events-none max-w-[260px]">
          <div className="text-[9px] uppercase font-bold text-gray-400 mb-1 tracking-wider">{metricLabel}</div>
          <div
            className="h-2 w-full rounded-full"
            style={{
              background: `linear-gradient(to right, ${colorStops.map((s) => s[1]).join(', ')})`,
            }}
          />
          <div className="flex items-center justify-between text-[10px] font-semibold text-gray-200 mt-1 tabular-nums">
            <span>{formatLegendValue(colorStops[0][0])}</span>
            <span className="text-gray-500">·</span>
            <span>{formatLegendValue(colorStops[colorStops.length - 1][0])}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatLegendValue(v: number): string {
  if (!isFinite(v)) return '–';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return '$' + (v / 1_000).toFixed(0) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
