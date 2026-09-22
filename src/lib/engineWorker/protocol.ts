/**
 * Protocol between the map page (main thread) and the aggregation Web Worker.
 *
 * The worker OWNS the property rows. Requests carry only small payloads
 * (filters, selected ids); responses carry small aggregates plus one
 * transferable Float32Array of point coordinates.
 */
import type { BoundaryKey, MetricKey, PropertyFilters, TeaScoreMap, MetricOverrideLite, PropertyOverrideLite, TimeSeriesPoint, ForecastResult, ForecastComparisonRow, MarketHealthResult } from '../engineCore';

/**
 * Describes where the worker can fetch the dataset chunks. Resolved on the
 * main thread (Firebase SDK + manifest compare live there) and shipped to the
 * worker once; the worker then downloads and parses the chunks itself.
 */
export interface DataSourcePlan {
  /** Firebase Storage bucket, used to build direct alt=media URLs. */
  bucket: string;
  /** Per-boundary chunk file paths (boundary-chunks manifest format). */
  boundaries?: Partial<Record<BoundaryKey, { chunks: string[] }>>;
  /** Flat chunk list (legacy manifest format). */
  chunks?: string[];
  totalRows: number;
  version: number;
}

export interface DatasetUniqueValues {
  propertyType: string[];
  city: string[];
  schoolDistrict: string[];
  elementary: string[];
  middle: string[];
  highschools: string[];
}

export interface DatasetLoadProgress {
  loaded: number;
  total: number;
}

export type WorkerRequest =
  | {
      type: 'loadDataset';
      plan: DataSourcePlan;
      cacheVersion: string;
      schoolScores: TeaScoreMap;
      /** Single-property overrides baked into the rows on load (CMS edits). */
      propertyOverrides?: PropertyOverrideLite[];
    }
  | {
      type: 'aggregate';
      jobId: number;
      boundary: BoundaryKey;
      metric: MetricKey;
      filters: PropertyFilters;
      cmsOverrides: MetricOverrideLite[];
      selectedIds: string[];
    }
  | {
      type: 'search';
      jobId: number;
      boundary: BoundaryKey;
      query: string;
    }
  | {
      type: 'chatStats';
      jobId: number;
      boundary: BoundaryKey;
      /** Filters merged on top of the applied ones (chat filter stats) or the
       *  currently applied filters (arbitrary-area preview). */
      filters: PropertyFilters;
      /** When set: stats for these specific areas (chat area-query preview). */
      ids?: string[];
      marketType?: 'sale' | 'rental';
    }
  | { type: 'cancelStale'; jobId: number };

export interface AggregateResult {
  jobId: number;
  filteredCount: number;
  /** Same shape as engine.getMapValues (minus the CMS override step, which is
   *  applied inside the worker with the overrides passed in the request). */
  mapValues: { values: Record<string, number>; counts: Record<string, number>; names: Record<string, string> };
  reportStats: {
    count: number;
    avgSale: number;
    avgSqft: number;
    avgDom: number;
    totalVolume: number;
    avgList: number;
    avgLotSize: number;
    avgTaxAmount: number;
    avgTaxRate: number;
    /** Share of the selected rows that carry tax data (0–1). */
    taxCoverage: number;
  };
  marketHealth: MarketHealthResult | null;
  timeSeries: TimeSeriesPoint[];
  forecast: ForecastResult | null;
  forecastComparison: ForecastComparisonRow[];
  yearBuiltData: { name: string; value: number }[];
  /** Flat [lat, lng, lat, lng, …] point list (transferable). */
  points: Float32Array;
  pointsCount: number;
  pointsBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}

export interface SearchResult {
  jobId: number;
  ids: string[];
}

export interface ChatStatsResult {
  jobId: number;
  stats: {
    count: number;
    avgSale: number;
    avgSqft: number;
    avgDom: number;
    totalVolume: number;
    avgList: number;
    avgLotSize: number;
    avgTaxAmount: number;
    avgTaxRate: number;
    taxCoverage: number;
  };
  /** Present for area queries. */
  health?: MarketHealthResult | null;
  /** Present for filter stats: top 5 areas by match count (ids — the page
   *  maps them to display names, the worker has no boundary lookup). */
  topAreas?: { id: string; count: number }[];
}

export type WorkerResponse =
  | { type: 'datasetReady'; count: number; uniqueValues: DatasetUniqueValues }
  | { type: 'datasetProgress'; loaded: number; total: number; message: string }
  | { type: 'datasetError'; message: string }
  | { type: 'result'; result: AggregateResult }
  | { type: 'searchResult'; result: SearchResult }
  | { type: 'chatStatsResult'; result: ChatStatsResult }
  | { type: 'jobError'; jobId: number; message: string }
  | { type: 'log'; message: string };