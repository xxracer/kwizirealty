/**
 * /api/query — hybrid SQL Connect resolver.
 *
 * FAST PATH (default map load, no selection): the per-area aggregates are
 * computed IN Postgres (areaMapValues / overallAggregates / monthlyTimeSeries
 * / mapPoints ops) and only ~20k compact area rows cross the wire — a full-row
 * fetch through the Data Connect layer costs ~0.37 ms/row (69k rows ≈ 25 s on
 * every map load). Falls back to the legacy full-row path automatically when
 * the aggregate ops are not deployed yet or anything fails.
 *
 * LEGACY PATH (selection, CMS overrides, ETA/Appreciation/Investor metrics,
 * or fallback): fetches the filtered rows and aggregates them with the SAME
 * engine methods the client uses, so results are identical.
 *
 *   1. verifies the Firebase ID token when present (optional — public map),
 *   2. runs the native-SQL ops (filtering in Postgres),
 *   3. aggregates with the SAME engine methods as the client path,
 *   4. returns small aggregates + a capped point set.
 */
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDataConnect } from '@/lib/firebaseAdmin';
import {
  RealEstateEngine,
  type PropertyData,
  type BoundaryKey,
  type MetricKey,
  type PropertyFilters,
} from '@/lib/engine';
import {
  getRealSchoolScore,
  type TeaScoreMap,
} from '@/lib/engineCore';
import { guardPublicRead } from '@/lib/server/requestGuard';
import { getTeaScoreMaps } from '@/lib/server/teaScores';
import { applyPropertyOverrides } from '@/lib/engineCore';
import type { PropertyOverrideLite } from '@/lib/engineCore';
import { getDatasetVersionTag } from '@/lib/server/datasetVersion';
import {
  generateETag,
  isMatch,
  notModifiedResponse,
  withETag,
} from '@/lib/server/etag';

export const runtime = 'nodejs';

/** Uniform-sample cap for the map values fetch (md5-ordered rows). */
const SQL_ROW_CAP = Number(process.env.SQL_ROW_CAP || 200000);
/** Points returned to the client; MapComponent culls by viewport + its own cap. */
const POINT_CAP = 30000;

/** ETA metrics need the TEA score maps that live in the browser engine. */
const ETA_METRICS = new Set<MetricKey>(['Elem ETA Score', 'Middle ETA Score', 'High ETA Score']);

interface QueryBody {
  filters: PropertyFilters;
  /** School names resolved client-side from the rating filters (TEA maps). */
  resolved?: { elementary: string[]; middle: string[]; high: string[] };
  boundary: BoundaryKey;
  metric: MetricKey;
  selectedIds: string[];
  /** Period window in unix ms (client computes from its engine reference date). */
  startTs: number | null;
  endTs: number | null;
  /** CMS single-property edits applied before aggregating. */
  propertyOverrides?: PropertyOverrideLite[];
}

function rowToProperty(row: any): PropertyData {
  return {
    mlsNumber: row.mls_number ?? '',
    address: row.address ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    zip: row.zip ?? '',
    closePrice: row.close_price ?? 0,
    listPrice: row.list_price ?? 0,
    pricePerSqft: row.price_per_sqft ?? 0,
    sqft: row.sqft ?? 0,
    lotSize: row.lot_size ?? 0,
    br: row.br ?? 0,
    baths: row.baths ?? 0,
    yearBuilt: row.year_built ?? 0,
    dom: row.dom ?? 0,
    cdom: row.cdom ?? 0,
    closeDate: row.close_date ?? '',
    closeYear: row.close_year ?? 0,
    closeDateTs: row.close_date_ts ? Number(row.close_date_ts) : 0,
    maintFee: row.maint_fee ?? 0,
    maintFeeSchedule: row.maint_fee_schedule ?? '',
    taxRate: row.tax_rate ?? 0,
    taxYear: row.tax_year ?? 0,
    taxAmount: row.tax_amount ?? 0,
    subdivisions: row.subdivisions ?? '',
    zipcodes: row.zipcodes ?? '',
    highschools: row.highschools ?? '',
    highschoolName: row.highschool_name ?? '',
    elementary: row.elementary ?? '',
    middle: row.middle ?? '',
    schoolDistrict: row.school_district ?? '',
    marketArea: row.market_area ?? '',
    area: row.area ?? '',
    lat: row.lat ?? 0,
    lng: row.lng ?? 0,
    propertyType: row.property_type ?? '',
    pool: !!row.pool,
    listingType: row.listing_type ?? 'sale',
  };
}

const RENTAL_METRICS = new Set<MetricKey>([
  'Est. Rental Price',
  'Rent-to-Sale Ratio',
  'Rental Price per Sqft',
  'Rental Days On Market',
]);

/** Metrics whose SQL aggregates should read actual rental rows (not sales estimates). */
const RENTAL_DATA_METRICS = new Set<MetricKey>([
  'Est. Rental Price',
  'Rental Price per Sqft',
  'Rental Days On Market',
]);

function buildVariables(
  filters: PropertyFilters,
  resolved: QueryBody['resolved'],
  startTs: number | null,
  endTs: number | null,
  metric: MetricKey
) {
  return {
    saleMin: filters.saleMin ?? 0,
    saleMax: filters.saleMax ?? 20000000,
    sqftMin: filters.sqftMin ?? 0,
    sqftMax: filters.sqftMax ?? 20000,
    yearMin: filters.yearMin ?? 1920,
    yearMax: filters.yearMax ?? new Date().getFullYear(),
    bedsMin: filters.bedsMin ?? 0,
    bedsMax: filters.bedsMax ?? 20,
    bathsMin: filters.bathsMin ?? 0,
    bathsMax: filters.bathsMax ?? 20,
    l2sMin: filters.l2sMin ?? 50,
    l2sMax: filters.l2sMax ?? 150,
    domMin: filters.domMin ?? 0,
    domMax: filters.domMax ?? 2000,
    lotSizeMin: filters.lotSizeMin ?? 0,
    lotSizeMax: filters.lotSizeMax ?? 1000000,
    ppsfMin: filters.pricePerSqftMin ?? 0,
    ppsfMax: filters.pricePerSqftMax ?? 5000,
    rentMin: filters.rentMin ?? 0,
    rentMax: filters.rentMax ?? 50000,
    startTs: startTs != null ? String(startTs) : null,
    endTs: endTs != null ? String(endTs) : null,
    propertyTypes: filters.propertyTypes ?? [],
    pool: filters.pool ?? 'any',
    schoolDistricts: filters.schoolDistricts ?? [],
    cities: filters.cities ?? [],
    elementaryExplicit: filters.elementary ?? [],
    elementaryRating: resolved?.elementary ?? [],
    middleExplicit: filters.middle ?? [],
    middleRating: resolved?.middle ?? [],
    highschoolsExplicit: filters.highschools ?? [],
    highSchoolRating: resolved?.high ?? [],
    listingType: RENTAL_DATA_METRICS.has(metric) ? 'rent' : 'sale',
    limit: SQL_ROW_CAP,
  };
}

/**
 * Simple per-area metrics computable by the areaMapValues percentile op
 * (median over the same per-row values the engine's getMetricValue produces).
 * Appreciation Rate / Investor Index / High ETA Score need per-row logic and
 * stay on the legacy path.
 */
const SQL_AGG_METRIC_COLUMN: Partial<Record<MetricKey, string>> = {
  'Close Price': 'med_close_price',
  'Price per Sqft': 'med_ppsf',
  'Price per Sqft List': 'med_ppsf_list',
  'List-to-Sale Ratio': 'med_l2s',
  'Days on Market': 'med_dom',
  'Est. Rental Price': 'med_rent',
  'Rent-to-Sale Ratio': 'med_rts',
  'Rental Price per Sqft': 'med_rent_psf',
  'Rental Days On Market': 'med_rent_dom',
  'Lot Size': 'med_lot',
  'Annual HOA Fee': 'med_hoa',
  'Last Year Tax Rate': 'med_tax_rate',
};

function buildYearBuiltData(engine: RealEstateEngine, data: PropertyData[], boundary: BoundaryKey, selectedIds: string[]) {
  const buckets: Record<string, number> = {
    'Before 1970': 0,
    '1970–1989': 0,
    '1990–2009': 0,
    '2010+': 0,
  };
  const selectedSet = new Set(selectedIds);
  const selected = selectedIds.length
    ? data.filter((d) => selectedSet.has(engine.getBoundaryKey(boundary, d)))
    : data;
  selected.forEach((d) => {
    if (!d.yearBuilt) return;
    if (d.yearBuilt < 1970) buckets['Before 1970']++;
    else if (d.yearBuilt < 1990) buckets['1970–1989']++;
    else if (d.yearBuilt < 2010) buckets['1990–2009']++;
    else buckets['2010+']++;
  });
  return Object.entries(buckets)
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0);
}

/** Market-health scoring, computed from the SQL medians (no rows needed).
 *  Mirrors getMarketHealth's math in engineCore. */
function marketHealthFromAggregates(
  n: number,
  medDom: number | null,
  medL2s: number | null,
  marketType: 'sale' | 'rental'
) {
  const clamp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const scores: Record<string, number> = {};
  const weights: Record<string, number> = {};
  if (medDom !== null) {
    scores['Days on Market'] = marketType === 'rental' ? clamp(60 - medDom, 0, 50) : clamp(90 - medDom, 0, 70);
    weights['Days on Market'] = 0.45;
  }
  if (medL2s !== null) {
    scores[marketType === 'rental' ? 'List-to-Lease Ratio' : 'List-to-Sale Ratio'] =
      marketType === 'rental' ? clamp(medL2s - 95, 0, 6) : clamp(medL2s - 94, 0, 8);
    weights[marketType === 'rental' ? 'List-to-Lease Ratio' : 'List-to-Sale Ratio'] = 0.35;
  }
  const monthsInPeriod = 6;
  const moi = n / Math.max(monthsInPeriod, 1);
  scores['Months of Inventory'] = clamp(marketType === 'rental' ? 3 - moi : 7 - moi, 0, marketType === 'rental' ? 2.5 : 5);
  weights['Months of Inventory'] = 0.2;
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!totalW || n === 0) return null;
  const finalScore = Object.entries(scores).reduce((sum, [k, v]) => sum + (v * weights[k]) / totalW, 0);
  let label: string;
  let color: string;
  if (marketType === 'rental') {
    if (finalScore >= 65) { label = "Landlord's Market"; color = '#ef4444'; }
    else if (finalScore >= 35) { label = 'Neutral Market'; color = '#f59e0b'; }
    else { label = "Renter's Market"; color = '#3b82f6'; }
  } else {
    if (finalScore >= 65) { label = "Seller's Market"; color = '#ef4444'; }
    else if (finalScore >= 35) { label = 'Neutral Market'; color = '#f59e0b'; }
    else { label = "Buyer's Market"; color = '#3b82f6'; }
  }
  return {
    score: Math.round(finalScore * 10) / 10,
    label,
    color,
    marketType,
    metrics: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    dom: medDom,
    l2s: medL2s,
    moi,
  };
}

export async function POST(req: Request) {
  // 1. Public read access: the map is open to signed-out visitors (the login
  //    gate is optional), so the Firebase token is OPTIONAL now. Same-origin +
  //    rate limiting protect the endpoint; a token, when present, is verified.
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token) {
    try {
      await getAdminAuth().verifyIdToken(token);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let body: QueryBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const { filters, boundary, metric, selectedIds } = body;
  if (!filters || !boundary || !metric) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  // Conditional cache: compute an ETag from the request body + dataset version.
  // If the browser already has this exact response, return 304 with no body.
  const datasetVersion = await getDatasetVersionTag();
  const etag = generateETag(body, datasetVersion);
  if (isMatch(req, etag)) {
    return notModifiedResponse(etag);
  }

  const dc = getAdminDataConnect();
  const variables = buildVariables(filters, body.resolved, body.startTs, body.endTs, metric);

  // FAST PATH — no selection, no CMS overrides, metric supported by the SQL
  // percentiles (or an Elem/Middle ETA metric, which is count + TEA lookup).
  const fastMetric =
    SQL_AGG_METRIC_COLUMN[metric] || metric === 'Elem ETA Score' || metric === 'Middle ETA Score';
  const useFastAgg =
    fastMetric && !(selectedIds && selectedIds.length) && !body.propertyOverrides?.length;

  if (useFastAgg) {
    try {
      const { limit: _limit, ...filterVars } = variables;
      const [areaRes, overallRes, tsRes, pointsRes] = await Promise.all([
        dc.executeQuery('areaMapValues', { ...filterVars, boundary }),
        dc.executeQuery('overallAggregates', filterVars),
        dc.executeQuery('monthlyTimeSeries', filterVars),
        dc.executeQuery('mapPoints', { ...filterVars, limit: POINT_CAP }),
      ]);

      const areas: any[] = (areaRes.data as any)?.areas || [];
      const totals: any = (overallRes.data as any)?.totals || {};
      const series: any[] = (tsRes.data as any)?.series || [];
      const pointRows: any[] = (pointsRes.data as any)?.points || [];

      // The weekly fallback (getTimeSeries switches to weekly buckets under 3
      // monthly points) and any unexpected empty aggregate fall back to the
      // exact legacy path.
      if (!areas.length || !totals || series.length < 3) {
        throw new Error('aggregate ops returned thin data');
      }

      // mapValues — the requested metric's SQL median per area, or the TEA
      // score for Elem/Middle ETA metrics (per-area score, count from SQL).
      const teaMaps: TeaScoreMap | null = ETA_METRICS.has(metric) ? await getTeaScoreMaps() : null;
      const values: Record<string, number> = {};
      const counts: Record<string, number> = {};
      const names: Record<string, string> = {};
      const col = SQL_AGG_METRIC_COLUMN[metric];
      for (const row of areas) {
        const key: string = row.key ?? '';
        if (!key) continue;
        counts[key] = row.n ?? 0;
        names[key] = key;
        if (col) {
          const v = row[col];
          if (v != null) values[key] = Number(v);
        } else if (metric === 'Elem ETA Score') {
          values[key] = getRealSchoolScore(teaMaps!, 'elementary', key) || 0;
        } else if (metric === 'Middle ETA Score') {
          values[key] = getRealSchoolScore(teaMaps!, 'middle', key) || 0;
        }
      }

      const n = totals.n ?? 0;
      const reportStats = {
        count: n,
        avgSale: n ? Number(totals.total_volume ?? 0) / n : 0,
        avgSqft: Number(totals.sqft_sum ?? 0) > 0 ? Number(totals.sqft_sale_sum ?? 0) / Number(totals.sqft_sum) : 0,
        avgDom: Number(totals.avg_dom ?? 0),
        totalVolume: Number(totals.total_volume ?? 0),
        avgList: Number(totals.list_count ?? 0) > 0 ? Number(totals.list_sum ?? 0) / Number(totals.list_count) : 0,
        avgLotSize: Number(totals.avg_lot ?? 0),
        avgTaxAmount: Number(totals.avg_tax_amount ?? 0),
        avgTaxRate: Number(totals.avg_tax_rate ?? 0),
        taxCoverage: n ? Number(totals.tax_count ?? 0) / n : 0,
      };

      // Rental metrics score market health as a rental market (page.tsx parity).
      const isRental =
        metric === 'Est. Rental Price' ||
        metric === 'Rental Price per Sqft' ||
        metric === 'Rental Days On Market' ||
        metric === 'Rent-to-Sale Ratio';
      const marketHealth = marketHealthFromAggregates(
        n,
        totals.med_dom != null ? Number(totals.med_dom) : null,
        totals.med_l2s != null ? Number(totals.med_l2s) : null,
        isRental ? 'rental' : 'sale'
      );

      const timeSeries = series.map((row: any) => ({
        period: row.period,
        value: Number(row[SQL_AGG_METRIC_COLUMN[metric]!] ?? 0) || 0,
        n: row.n ?? 0,
      }));

      const yearBuiltData = [
        { name: 'Before 1970', value: totals.era1 ?? 0 },
        { name: '1970–1989', value: totals.era2 ?? 0 },
        { name: '1990–2009', value: totals.era3 ?? 0 },
        { name: '2010+', value: totals.era4 ?? 0 },
      ].filter((d) => d.value > 0);

      const points = pointRows.map((row: any) => ({ lat: Number(row.lat ?? 0), lng: Number(row.lng ?? 0) }));

      return withETag({
        mapValues: { values, counts, names },
        reportStats,
        marketHealth,
        timeSeries,
        forecastComparison: [],
        yearBuiltData,
        points,
      }, etag);
    } catch (err) {
      // Ops not deployed yet (or a thin result) — fall through to the legacy
      // full-row path so the response stays identical while the connector
      // deployment catches up.
      console.warn('[api/query] fast aggregate path failed, using legacy row path:', (err as Error)?.message);
    }
  }

  try {
    // LEGACY PATH — map values + points from the (capped, uniform) sample.
    const mapRes = await dc.executeQuery('filteredProperties', variables);
    const rows: any[] = (mapRes.data as any)?.properties || [];
    const props = rows.map(rowToProperty);
    // CMS single-property edits apply before any aggregation.
    if (body.propertyOverrides?.length) {
      applyPropertyOverrides(props, body.propertyOverrides);
    }

    const engine = new RealEstateEngine();
    engine.data = props;
    // ETA metrics need the TEA score maps — loaded server-side (cached 10 min).
    if (ETA_METRICS.has(metric)) {
      engine.setTeaScores(await getTeaScoreMaps());
    }

    const mapValues = engine.getMapValues(props, boundary, metric);
    const points = props.slice(0, POINT_CAP).map((d) => ({ lat: d.lat, lng: d.lng }));

    // 3. Report aggregates. When an area is selected, fetch the exact scoped
    //    rows (no cap) so the report is exact; otherwise reuse the map sample.
    let reportProps = props;
    if (selectedIds && selectedIds.length) {
      // filteredPropertiesForSelection has no $limit param — drop it.
      const { limit: _limit, ...selectionVars } = variables;
      const selRes = await dc.executeQuery('filteredPropertiesForSelection', {
        ...selectionVars,
        boundary,
        selectedIds,
      });
      const selRows: any[] = (selRes.data as any)?.properties || [];
      reportProps = selRows.map(rowToProperty);
    }

    const reportStats = engine.getStatsForSelection(reportProps, boundary, selectedIds || []);
    // Mirrors page.tsx: rental metrics score market health as a rental market.
    const isRental =
      metric === 'Est. Rental Price' ||
      metric === 'Rental Price per Sqft' ||
      metric === 'Rental Days On Market' ||
      metric === 'Rent-to-Sale Ratio';
    const marketHealth = engine.getMarketHealth(
      reportProps,
      boundary,
      selectedIds || [],
      isRental ? 'rental' : 'sale'
    );
    const timeSeries = engine.getTimeSeries(reportProps, boundary, metric, selectedIds || []);
    const forecastComparison = engine
      .getForecastForSelection(reportProps, boundary, metric, selectedIds || [])
      .sort((a, b) => b.baseline - a.baseline)
      .slice(0, 5);

    // Year-built distribution for the report widget (mirrors page.tsx).
    const yearBuiltData = buildYearBuiltData(engine, reportProps, boundary, selectedIds || []);

    return withETag({
      mapValues: { values: mapValues.values, counts: mapValues.counts, names: mapValues.names },
      reportStats,
      marketHealth,
      timeSeries,
      forecastComparison,
      yearBuiltData,
      points,
    }, etag);
  } catch (err) {
    console.error('[api/query] SQL Connect failed:', err);
    return NextResponse.json({ error: 'SQL query failed' }, { status: 500 });
  }
}