/**
 * sqlData.ts — client-side bridge to the hybrid SQL Connect path.
 *
 * When the user has active filters (or a report selection), the browser no
 * longer re-scans the 763k rows in RAM. Instead it calls /api/query, which
 * filters in Postgres and returns the same aggregate shapes the engine
 * produces. Every function here returns null on any failure so the caller
 * falls back to the client engine — the app works exactly as before if SQL
 * Connect is not deployed or errors.
 */
import type { PropertyFilters, BoundaryKey, MetricKey } from '@/lib/engine';
import type { RealEstateEngine } from '@/lib/engine';
import { DEFAULT_FILTERS } from '@/lib/engine';

/** Gate: set NEXT_PUBLIC_SQL_ENABLED=true once dataconnect is deployed. */
export function isSQLEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SQL_ENABLED === 'true';
}

// DEFAULT_FILTERS is a live object; snapshot it once for the comparison below.
const DEFAULT_FILTERS_SNAPSHOT = JSON.stringify(DEFAULT_FILTERS);

export interface SqlAggregates {
  mapValues: { values: Record<string, number>; counts: Record<string, number> };
  reportStats: {
    count: number;
    avgSale: number;
    avgSqft: number;
    avgDom: number;
    totalVolume: number;
    avgList: number;
    avgLotSize: number;
  };
  marketHealth: {
    score: number;
    label: string;
    color: string;
    marketType: string;
    metrics: Record<string, number>;
    dom: number | null;
    l2s: number | null;
    moi: number;
  } | null;
  timeSeries: { period: string; value: number; n: number }[];
  forecastComparison: {
    region: string;
    baseline: number;
    annualDelta: number;
    annualPct: number;
    r2: number;
    forecast3yr: number;
  }[];
  yearBuiltData: { name: string; value: number }[];
  points: { lat: number; lng: number }[];
}

/** True when the applied filters differ from the no-op defaults. */
export function hasActiveFilters(filters: PropertyFilters): boolean {
  return JSON.stringify(filters) !== DEFAULT_FILTERS_SNAPSHOT;
}

/**
 * Resolve the school-rating filters (grades like "A") to the concrete school
 * names that carry that grade, using the browser engine's TEA score maps.
 * The route applies these as plain name filters.
 */
export function resolveRatingFilters(
  engine: RealEstateEngine,
  filters: PropertyFilters
): { elementary: string[]; middle: string[]; high: string[] } {
  return {
    elementary: engine.getSchoolNamesByGrade('elementary', filters.elementaryRating),
    middle: engine.getSchoolNamesByGrade('middle', filters.middleRating),
    high: engine.getSchoolNamesByGrade('high', filters.highRating),
  };
}

/** Replicates engine periodToDates() → unix ms window (client has the ref date). */
export function periodToWindow(
  period: PropertyFilters['period'],
  reference: Date
): { startTs: number | null; endTs: number | null } {
  const end = reference;
  let start: Date | null = null;
  const y = end.getFullYear();
  switch (period) {
    case '30d':
      start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '6m':
      start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);
      break;
    case 'ytd':
      start = new Date(y, 0, 1);
      break;
    case '1y':
      start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case '3y':
      start = new Date(end.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '5y':
      start = new Date(end.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      break;
    default:
      start = null;
  }
  return { startTs: start ? start.getTime() : null, endTs: end.getTime() };
}

/**
 * Call /api/query. Returns null on any error / unsupported metric so the
 * caller falls back to the client engine.
 */
export async function fetchSqlAggregates(
  filters: PropertyFilters,
  resolved: { elementary: string[]; middle: string[]; high: string[] },
  boundary: BoundaryKey,
  metric: MetricKey,
  selectedIds: string[],
  startTs: number | null,
  endTs: number | null,
  idToken: string
): Promise<SqlAggregates | null> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ filters, resolved, boundary, metric, selectedIds, startTs, endTs }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.unsupported || !data.mapValues) return null;
    return data as SqlAggregates;
  } catch {
    return null;
  }
}
