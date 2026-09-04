/**
 * /api/query — hybrid SQL Connect resolver.
 *
 * When the user has active filters, the browser no longer re-scans the 763k
 * rows in RAM. Instead this route:
 *   1. verifies the Firebase ID token (admin Data Connect bypasses @auth),
 *   2. runs the native-SQL `filteredProperties` op (filtering in Postgres),
 *   3. aggregates the returned rows with the SAME engine methods the client
 *      uses (getMapValues / getStatsForSelection / getMarketHealth /
 *      getTimeSeries), so results are identical to the client-side path,
 *   4. returns only small aggregates + a capped point set.
 *
 * The client applies CMS overrides and computes the forecast client-side.
 * Any error here → the client falls back to its own engine (no regression).
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
  };
}

function buildVariables(filters: PropertyFilters, resolved: QueryBody['resolved'], startTs: number | null, endTs: number | null) {
  return {
    saleMin: filters.saleMin,
    saleMax: filters.saleMax,
    sqftMin: filters.sqftMin,
    sqftMax: filters.sqftMax,
    yearMin: filters.yearMin,
    yearMax: filters.yearMax,
    bedsMin: filters.bedsMin,
    bedsMax: filters.bedsMax,
    bathsMin: filters.bathsMin,
    bathsMax: filters.bathsMax,
    l2sMin: filters.l2sMin,
    l2sMax: filters.l2sMax,
    domMin: filters.domMin,
    domMax: filters.domMax,
    lotSizeMin: filters.lotSizeMin,
    lotSizeMax: filters.lotSizeMax,
    ppsfMin: filters.pricePerSqftMin,
    ppsfMax: filters.pricePerSqftMax,
    rentMin: filters.rentMin,
    rentMax: filters.rentMax,
    startTs: startTs != null ? String(startTs) : null,
    endTs: endTs != null ? String(endTs) : null,
    propertyTypes: filters.propertyTypes,
    pool: filters.pool,
    schoolDistricts: filters.schoolDistricts,
    cities: filters.cities,
    elementaryExplicit: filters.elementary,
    elementaryRating: resolved?.elementary || [],
    middleExplicit: filters.middle,
    middleRating: resolved?.middle || [],
    highschoolsExplicit: filters.highschools,
    highSchoolRating: resolved?.high || [],
    limit: SQL_ROW_CAP,
  };
}

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

export async function POST(req: Request) {
  // 1. Auth — the map is behind RequireAuth; the token proves the caller.
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await getAdminAuth().verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  // ETA metrics need the TEA score maps (browser-only) — client falls back.
  if (ETA_METRICS.has(metric)) {
    return NextResponse.json({ unsupported: true });
  }

  const dc = getAdminDataConnect();
  const variables = buildVariables(filters, body.resolved, body.startTs, body.endTs);

  try {
    // 2. Map values + points from the (capped, uniform) filtered sample.
    const mapRes = await dc.executeQuery('filteredProperties', variables);
    const rows: any[] = (mapRes.data as any)?.properties || [];
    const props = rows.map(rowToProperty);

    const engine = new RealEstateEngine();
    engine.data = props;

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

    return NextResponse.json({
      mapValues: { values: mapValues.values, counts: mapValues.counts },
      reportStats,
      marketHealth,
      timeSeries,
      forecastComparison,
      yearBuiltData,
      points,
    });
  } catch (err) {
    console.error('[api/query] SQL Connect failed:', err);
    return NextResponse.json({ error: 'SQL query failed' }, { status: 500 });
  }
}
