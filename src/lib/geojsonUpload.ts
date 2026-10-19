import Papa from 'papaparse';
import { cleanBoundaryName } from './engine';

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: any };
  properties: Record<string, any>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

/**
 * Pull a human-readable area name from a GeoJSON feature. Tries common property
 * keys first, then falls back to any property that looks like a name.
 */
export function getFeatureName(feature: GeoJsonFeature): string {
  const props = feature?.properties || {};
  const candidates = [
    props.name,
    props.NAME,
    props.area,
    props.AREA,
    props.area_name,
    props.subdivision,
    props.SUB_NAME,
    props.title,
    props.id,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate);
  }
  for (const value of Object.values(props)) {
    if (value != null && typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function normalizeFeatureName(name: string): string {
  return cleanBoundaryName(name || '');
}

/**
 * Normalize a GeoJSON FeatureCollection to WGS84 lon/lat (EPSG:4326) — the only
 * CRS Leaflet can draw. Some GIS exports (e.g. ArcGIS "WGS 1984 Web Mercator")
 * ship polygon coordinates in meters; any coordinate outside the lon/lat range
 * is the giveaway. Projected data is converted in place with the inverse
 * spherical Mercator transform; already-WGS84 data is returned untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeGeoJsonCrs<T extends { features: any[] }>(collection: T): T {
  const features = collection?.features;
  if (!features?.length) return collection;

  const visitCoords = (coords: unknown, fn: (pt: number[]) => void): void => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number') {
      fn(coords as number[]);
      return;
    }
    for (const c of coords as unknown[]) visitCoords(c, fn);
  };

  // Inverse spherical Web Mercator (EPSG:3857 → EPSG:4326), the standard
  // projected export from ArcGIS/QGIS. Lossless for this projection.
  const R = 6378137;
  const toDeg = 180 / Math.PI;

  // PER-FEATURE detection (not file-wide): real exports DO mix CRS types —
  // some features already ship lon/lat degrees while others carry Mercator
  // meters. A file-wide convert re-projected the degree features into ~8-meter
  // slivers near (0,0), blanking whole areas on the map. Each feature is
  // converted only when ITS own coordinates fall outside the lon/lat range.
  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    if (!coords) continue;
    let projected = false;
    visitCoords(coords, (pt) => {
      if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) projected = true;
    });
    if (!projected) continue;
    visitCoords(coords, (pt) => {
      const x = pt[0];
      const y = pt[1];
      pt[0] = (x / R) * toDeg;
      pt[1] = (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * toDeg;
    });
  }
  return collection;
}

/**
 * LIGHTEN a GeoJSON text for CMS upload (the map's speed, owner rule 2026-10-18:
 * "que vuele" — every visitor downloads and decodes each boundary file).
 * Pipeline: per-feature CRS normalize → adaptive Douglas–Peucker simplify →
 * drop the Z/extra dims → round coordinates to 6 decimals (≈0.1 m) →
 * re-serialize. All features survive (names keep their identity); only
 * redundant vertices go away. Returns null for input it cannot parse or
 * safely transform — the caller then uploads the original bytes unmodified.
 */
export function lightenGeoJsonText(text: string, sizeBytes: number): string | null {
  let collection: { features?: GeoJsonFeature[] };
  try {
    collection = JSON.parse(text);
  } catch {
    return null;
  }
  const features = (collection as { features?: GeoJsonFeature[] })?.features;
  if (!Array.isArray(features) || features.length === 0) return null;

  // Adaptive tolerance: ~11m at the cap (calibrated on Mapped Subdivisions —
  // 65MB/1.06M vertices → 3.6MB text / 0.85MB gzip at 127k vertices, shapes
  // intact on screen) growing smaller only for tiny files.
  const sizeMB = Math.max(sizeBytes, 1) / 1e6;
  const tol = Math.max(0.00002, Math.min(0.0001, sizeMB * 0.05));

  const visitCoords = (coords: unknown, fn: (pt: number[]) => void): void => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number') {
      fn(coords as number[]);
      return;
    }
    for (const c of coords as unknown[]) visitCoords(c, fn);
  };

  // Douglas–Peucker on a ring treated as a polyline (first==last kept).
  const dpSimplify = (pts: number[][]): number[][] => {
    const n = pts.length;
    if (n <= 4) return pts;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: Array<[number, number]> = [[0, n - 1]];
    while (stack.length) {
      const [s, e] = stack.pop()!;
      const p1 = pts[s];
      const p2 = pts[e];
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const len2 = dx * dx + dy * dy;
      let maxD = -1;
      let maxI = -1;
      for (let i = s + 1; i < e; i++) {
        const p = pts[i];
        let d: number;
        if (len2 === 0) {
          const ex = p[0] - p1[0];
          const ey = p[1] - p1[1];
          d = ex * ex + ey * ey;
        } else {
          const t = ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / len2;
          const tt = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = p[0] - (p1[0] + tt * dx);
          const ey = p[1] - (p1[1] + tt * dy);
          d = ex * ex + ey * ey;
        }
        if (d > maxD) {
          maxD = d;
          maxI = i;
        }
      }
      if (maxI >= 0 && Math.sqrt(maxD) > tol) {
        keep[maxI] = 1;
        stack.push([s, maxI], [maxI, e]);
      }
    }
    const out: number[][] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  };

  const simplifyRings = (coords: any): any => {
    // Polygon: [outer, holes]; MultiPolygon: [polygon, polygon, ...]
    const isPolygonRings = typeof coords?.[0]?.[0]?.[0] === 'number';
    if (isPolygonRings) return coords.map((ring: number[][]) => dpSimplify(ring));
    return coords.map((poly: number[][][]) => simplifyRings(poly));
  };

  const R = 6378137;
  const toDeg = 180 / Math.PI;
  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    if (!coords) continue;
    // per-feature CRS normalize (same rule as normalizeGeoJsonCrs)
    let projected = false;
    visitCoords(coords, (pt) => {
      if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) projected = true;
    });
    if (projected) {
      visitCoords(coords, (pt) => {
        pt[0] = (pt[0] / R) * toDeg;
        pt[1] = (Math.atan(Math.exp(pt[1] / R)) * 2 - Math.PI / 2) * toDeg;
      });
    }
    if (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon') {
      feature.geometry.coordinates = simplifyRings(coords);
    }
    // strip extra dims (Z/M) + round to 6 decimals
    visitCoords(feature.geometry.coordinates, (pt) => {
      if (pt.length > 2) pt.length = 2;
      pt[0] = Math.round(pt[0] * 1e6) / 1e6;
      pt[1] = Math.round(pt[1] * 1e6) / 1e6;
    });
  }
  return JSON.stringify(collection);
}

/**
 * Parse a CSV string into a GeoJSON FeatureCollection of Point features.
 *
 * Expected columns (case-insensitive): `name` (or `area`), `lat`, `lng`.
 * Optional column `properties` with a JSON object is merged into the feature.
 *
 * Returns both the FeatureCollection and a list of skipped rows with reasons so
 * the UI can surface them.
 */
export interface CsvConversionResult {
  featureCollection: GeoJsonFeatureCollection;
  skipped: { row: number; reason: string; data?: Record<string, string> }[];
  headers: string[];
}

export function csvToFeatureCollection(text: string): CsvConversionResult {
  const result: CsvConversionResult = {
    featureCollection: { type: 'FeatureCollection', features: [] },
    skipped: [],
    headers: [],
  };

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const headers = parsed.meta.fields || [];
  result.headers = headers;

  if (!headers.length) {
    result.skipped.push({ row: 0, reason: 'CSV has no header row.' });
    return result;
  }

  const findCol = (...names: string[]) => {
    const lower = headers.map((h) => h.toLowerCase().trim());
    for (const name of names) {
      const idx = lower.indexOf(name.toLowerCase());
      if (idx !== -1) return headers[idx];
    }
    return null;
  };

  const nameCol = findCol('name', 'area', 'area_name', 'subdivision', 'title');
  const latCol = findCol('lat', 'latitude', 'y');
  const lngCol = findCol('lng', 'lon', 'long', 'longitude', 'x');
  const propsCol = findCol('properties');

  if (!nameCol) {
    result.skipped.push({
      row: 0,
      reason: 'CSV is missing a name column (name / area / subdivision).',
    });
    return result;
  }
  if (!latCol || !lngCol) {
    result.skipped.push({
      row: 0,
      reason: 'CSV is missing lat/lng columns (lat + lng, latitude + longitude).',
    });
    return result;
  }

  parsed.data.forEach((row, idx) => {
    const name = (row[nameCol] || '').trim();
    const latRaw = (row[latCol] || '').trim();
    const lngRaw = (row[lngCol] || '').trim();
    const lat = Number(latRaw);
    const lng = Number(lngRaw);

    if (!name) {
      result.skipped.push({ row: idx + 2, reason: 'Missing area name.', data: row });
      return;
    }
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
      result.skipped.push({ row: idx + 2, reason: 'Missing or invalid coordinates.', data: row });
      return;
    }

    let extraProps: Record<string, any> = {};
    if (propsCol && row[propsCol]) {
      try {
        const decoded = JSON.parse(row[propsCol]);
        if (decoded && typeof decoded === 'object') extraProps = decoded;
      } catch {
        result.skipped.push({
          row: idx + 2,
          reason: 'Could not parse properties JSON; storing row without extras.',
          data: row,
        });
      }
    }

    result.featureCollection.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { name, ...extraProps, source: 'csv-upload' },
    });
  });

  return result;
}

export interface DiffResult {
  /** Features whose normalized name does NOT exist in the existing set. */
  newFeatures: GeoJsonFeature[];
  /** Features whose normalized name DOES exist in the existing set. */
  duplicateFeatures: GeoJsonFeature[];
}

/**
 * Split a staged FeatureCollection into `newFeatures` and `duplicateFeatures`
 * by comparing each feature's normalized name against the set derived from the
 * existing FeatureCollection (already-loaded custom-area files).
 */
export function diffAgainstExisting(
  staged: GeoJsonFeatureCollection,
  existing: GeoJsonFeatureCollection
): DiffResult {
  const existingNames = new Set<string>();
  for (const feat of existing.features || []) {
    const normalized = normalizeFeatureName(getFeatureName(feat));
    if (normalized) existingNames.add(normalized);
  }

  const newFeatures: GeoJsonFeature[] = [];
  const duplicateFeatures: GeoJsonFeature[] = [];
  for (const feat of staged.features || []) {
    const normalized = normalizeFeatureName(getFeatureName(feat));
    if (normalized && existingNames.has(normalized)) {
      duplicateFeatures.push(feat);
    } else {
      newFeatures.push(feat);
    }
  }
  return { newFeatures, duplicateFeatures };
}

/**
 * Merge `newFeatures` into `existing`, replacing any feature whose normalized
 * name matches. Returns the combined FeatureCollection with no duplicates.
 */
export function mergeFeaturesReplacing(
  existing: GeoJsonFeatureCollection,
  newFeatures: GeoJsonFeature[]
): GeoJsonFeatureCollection {
  const byName = new Map<string, GeoJsonFeature>();
  for (const feat of existing.features || []) {
    const normalized = normalizeFeatureName(getFeatureName(feat));
    if (normalized) byName.set(normalized, feat);
  }
  for (const feat of newFeatures) {
    const normalized = normalizeFeatureName(getFeatureName(feat));
    if (!normalized) continue;
    byName.set(normalized, feat);
  }
  return { type: 'FeatureCollection', features: Array.from(byName.values()) };
}