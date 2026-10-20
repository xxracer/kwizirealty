/**
 * polyMatch — point-in-polygon assignment for the map's boundary classes.
 *
 * A property row belongs to the boundary polygon whose surface contains its
 * lat/lng (the same semantics RealEstate's Streamlit reference app used).
 * Names are normalized ONCE at index build time with `cleanBoundaryName`, the
 * exact function the map uses for its feature keys, so the stored polygon id
 * is the map's identity key — no alias resolution needed on lookup.
 *
 * Index: fixed grid (0.05° cells). Each cell stores the polygons whose bbox
 * overlaps it, so a point lookup ray-casts only its own cell's candidates.
 * "Smallest containing polygon wins" (shoelace area) for overlapping plats.
 * GeoJSON has 99 names shared by more than one feature — they share one key
 * and one aggregate (accepted decision, documented in the spec).
 */
import { cleanBoundaryName, cleanSchoolName, getFeatureName, type BoundaryKey } from './engineCore';

/** Cell size in degrees (~5.5km N-S at Houston's latitude). */
const CELL = 0.05;

interface PolyEntry {
  /** Cleaned polygon name — the id stored in SQL and shown on the map. */
  name: string;
  /** GeoJSON outer rings ([lng, lat] pairs); extra outer rings = separate entries. */
  ring: number[][];
  /** |area| via the shoelace formula, in deg² comparisons only. */
  area: number;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
}

export interface PolyIndex {
  cells: Map<string, PolyEntry[]>;
  /** Every ring entry exactly once (cells hold references; this is the count). */
  entries: PolyEntry[];
}

export interface PolyIndexOptions {
  /** The EXACT property keys the map reads for this class, in order —
   *  e.g. zipcodes reads Zip_Code, highschools reads NAME (getGeoProp is a
   *  case-SENSITIVE `in` check, so order and casing matter). */
  nameProps?: string[];
  /** The cleaner the map applies to this class's names (cleanBoundaryName
   *  everywhere except elementary/middle, which use cleanSchoolName). */
  clean?: (raw: unknown) => string;
}

/** Ring area |T| — sign ignored; small-enough numbers for comparisons. */
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2);
}

function bboxOf(ring: number[][]): PolyEntry['bbox'] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Even-odd ray casting against one closed ring ([lng, lat] pairs). */
function ringContains(ring: number[][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function collectOuterRings(geometry: GeoJSON.Geometry | undefined): number[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.length ? [geometry.coordinates[0]] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    const rings: number[][][] = [];
    for (const poly of geometry.coordinates) {
      if (poly.length) rings.push(poly[0]);
    }
    return rings;
  }
  return [];
}

export function buildPolyIndex(features: GeoJSON.Feature[], opts: PolyIndexOptions = {}): PolyIndex {
  const nameProps = opts.nameProps ?? ['Name', 'name'];
  const clean = opts.clean ?? cleanBoundaryName;
  const entries: PolyEntry[] = [];
  const cells = new Map<string, PolyEntry[]>();
  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    // Mirror MapComponent's buildAreaFeatures exactly: pick the class's own
    // property (case-SENSITIVE, same `in` check), clean with the class's
    // cleaner, and for empty names fall back to the SAME generic resolver and
    // the SAME synthetic 'Area N' key the map renders — so the stored polygon
    // id always equals the feature identity the user hovers.
    let rawName: unknown = '';
    for (const n of nameProps) {
      if (n in props) {
        rawName = props[n];
        break;
      }
    }
    let name = clean(rawName);
    if (!name) {
      const geom = feature.geometry as { type?: string; coordinates?: unknown } | null;
      name = clean(
        getFeatureName({
          geometry: { type: geom?.type ?? '', coordinates: (geom?.coordinates ?? []) as never },
          properties: props,
        })
      );
    }
    if (!name) name = cleanBoundaryName(`Area ${index + 1}`); // map parity: synthetic keys always use cleanBoundaryName
    if (!name) continue;
    for (const ring of collectOuterRings(feature.geometry)) {
      if (ring.length < 4) continue; // a ring must close
      const bbox = bboxOf(ring);
      const entry: PolyEntry = { name, ring, area: ringArea(ring), bbox };
      entries.push(entry);
      const gx0 = Math.floor(bbox[0] / CELL), gx1 = Math.floor(bbox[2] / CELL);
      const gy0 = Math.floor(bbox[1] / CELL), gy1 = Math.floor(bbox[3] / CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = `${gx}:${gy}`;
          const bucket = cells.get(key);
          if (bucket) bucket.push(entry);
          else cells.set(key, [entry]);
        }
      }
    }
  }
  return { cells, entries };
}

/** The containing polygon's cleaned name — smallest area wins on overlaps. */
export function assignPoly(lat: number, lng: number, index: PolyIndex): string {
  const key = `${Math.floor(lng / CELL)}:${Math.floor(lat / CELL)}`;
  const candidates = index.cells.get(key);
  if (!candidates) return '';
  let best: PolyEntry | null = null;
  for (const entry of candidates) {
    const bbox = entry.bbox;
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    if (!ringContains(entry.ring, lng, lat)) continue;
    if (!best || entry.area < best.area) best = entry;
  }
  return best ? best.name : '';
}

export function indexPolygonCount(index: PolyIndex): number {
  // One entry per outer ring, registered exactly once here no matter how
  // many grid cells reference it — the audit's polygon count.
  return index.entries.length;
}

/** Unused re-export guard so tree-shaking keeps the BoundaryKey type visible. */
export type { BoundaryKey };