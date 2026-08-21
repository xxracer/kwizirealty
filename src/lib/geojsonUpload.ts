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