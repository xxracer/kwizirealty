/**
 * Boundary classes → their Storage file names. Shared because the admin
 * assignment job (POST /api/sql/assign-poly + polyAssignClient) must resolve
 * exactly the same files the map renders. `neighborhoods` draws the SAME
 * file/content as `subdivisions` — they share one polygon column; `areas`
 * has no polygon file and keeps its CSV text key. Files NOT listed here
 * (e.g. High School ISD.geojson, COH_SiteAddresses.geojson) are not map
 * aggregate layers and stay untouched.
 */
import type { BoundaryKey } from '@/lib/engine';

export const BOUNDARY_SOURCES: Record<BoundaryKey, string> = {
  subdivisions: 'Mapped Subdivisions.geojson',
  zipcodes: 'Zip.geojson',
  highschools: 'Houston_ISD.geojson',
  elementary: 'Elementary School ISD.geojson',
  middle: 'Middle School ISD.geojson',
  neighborhoods: 'Mapped Subdivisions.geojson',
  areas: '',
};

/** Boundary classes with a polygon file — the assignment job's targets. */
export const POLY_ASSIGN_CLASSES = [
  'subdivisions',
  'zipcodes',
  'highschools',
  'elementary',
  'middle',
] as const;

export type PolyAssignClass = (typeof POLY_ASSIGN_CLASSES)[number];

/** Map a BOUNDARY_SOURCES file name back to its PRIMARY PolyAssignClass. */
export function polyClassForFile(name: string): PolyAssignClass | null {
  for (const key of POLY_ASSIGN_CLASSES) {
    if (BOUNDARY_SOURCES[key] === name) return key;
  }
  return null;
}